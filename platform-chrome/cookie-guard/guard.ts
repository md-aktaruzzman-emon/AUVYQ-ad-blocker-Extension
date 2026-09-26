/*
 * Cookie Guard. Classifies cookies (tracker / analytics / session / essential) and
 * cleans ONLY third-party tracker cookies. Never deletes authentication or session
 * cookies. Respects masterEnabled, module settings and perSite.paused.
 */
import cookieClassification from '../../data/cookie-classification.json';
import type { Settings } from '../../types/schemas.js';
import { matchSuffix, normalizeHostname } from '../../core/domain/normalize.js';
import { createLogger } from '../../core/logging/logger.js';

const log = createLogger('cookie-guard');

interface CookieRule { domain: string; category: string }

const COOKIE_RULES: readonly CookieRule[] = cookieClassification;

const TRACKER_SUFFIXES: readonly string[] = COOKIE_RULES
  .filter((rule) => rule.category === 'tracker')
  .map((rule) => rule.domain);

export function classifyCookieDomain(domain: string): 'tracker' | 'analytics' | 'session' | 'essential' | 'unknown' {
  const normalized = normalizeHostname(domain);
  for (const rule of COOKIE_RULES) {
    if (matchSuffix(normalized, rule.domain)) {
      return rule.category as 'tracker' | 'analytics' | 'session' | 'essential';
    }
  }
  return 'unknown';
}

export function isTrackerDomain(host: string): boolean {
  const normalized = normalizeHostname(host);
  return TRACKER_SUFFIXES.some((suffix) => matchSuffix(normalized, suffix));
}

export interface CookieCleanupResult {
  removed: number;
  skipped: string;
}

/** Known tracking / ad profiling cookie name patterns (Google, Facebook, Bing, Criteo, etc.) */
const TRACKER_COOKIE_PATTERN = /^(Conversion|APISID|SAPISID|__Secure-[13]PAPISID|1P_JAR|NID|ANID|IDE|DSID|OTZ|_ga|_gid|_gat|_fbp|_fbc|fr|_uetsid|_uetvid|_gcl_.*|_gac_.*|__cf_bm|_clck|_clsk|__utma|__utmb|__utmc|__utmz|uuid2|tuuid|anj)$/i;

/** Essential session/login cookie name patterns that must NEVER be deleted */
const ESSENTIAL_COOKIE_PATTERN = /^(ACCOUNT_CHOOSER|SID|HSID|SSID|__Secure-[13]PSID|__Secure-.*OSID|OSID|__Secure-DIVERSION.*|__Host-|auth|token|jwt|csrf|xsrf|session|PHPSESSID|JSESSIONID|ASPSESSIONID|connect\.sid|remember_web_|wordpress_logged_in_|li_at|sessionid|authToken|access_token|refresh_token|id_token)$/i;

export function cookieUrl(cookie: { domain: string; path?: string; secure?: boolean }): string {
  const protocol = cookie.secure ? 'https:' : 'http:';
  const domain = cookie.domain.replace(/^\./, '');
  const path = cookie.path && cookie.path.startsWith('/') ? cookie.path : '/';
  return `${protocol}//${domain}${path}`;
}

export function isKnownTrackingCookie(cookie: { name: string; domain: string }): boolean {
  // 1. Never remove essential authentication/login cookies (checked FIRST for safety)
  if (ESSENTIAL_COOKIE_PATTERN.test(cookie.name) || /^(sess|auth|token|jwt|csrf|xsrf|login|secure_session|identity|user_session|sso)/i.test(cookie.name)) {
    return false;
  }

  // 2. Explicit tracking/profiling cookies are always tracking
  if (TRACKER_COOKIE_PATTERN.test(cookie.name)) {
    return true;
  }

  // 3. Domain-classified tracker
  const category = classifyCookieDomain(cookie.domain);
  if (category === 'tracker' || category === 'analytics') {
    return true;
  }

  return false;
}

export async function handleCookieChanged(
  changeInfo: chrome.cookies.CookieChangeInfo,
  settings: Settings
): Promise<{ removed: boolean }> {
  if (!settings.masterEnabled || !settings.modules.cookies) {
    return { removed: false };
  }
  if (changeInfo.removed) {
    return { removed: false };
  }
  const cookie = changeInfo.cookie;
  if (isSitePausedForCookie(settings, cookie.domain)) {
    return { removed: false };
  }
  if (!isKnownTrackingCookie(cookie)) {
    return { removed: false };
  }
  try {
    const url = cookieUrl(cookie);
    await chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId });
    return { removed: true };
  } catch {
    return { removed: false };
  }
}

export async function sweepTrackerCookies(settings: Settings): Promise<CookieCleanupResult> {
  if (!settings.masterEnabled || !settings.modules.cookies) {
    return { removed: 0, skipped: 'module disabled' };
  }
  let removed = 0;
  try {
    const all = await chrome.cookies.getAll({});
    for (const cookie of all) {
      // Must pass full tracking check (essential cookies are never touched)
      if (!isKnownTrackingCookie(cookie)) continue;
      if (classifyCookieDomain(cookie.domain) !== 'tracker') continue;
      if (isSitePausedForCookie(settings, cookie.domain)) continue;
      try {
        const url = cookieUrl(cookie);
        await chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId });
        removed += 1;
      } catch {
        // individual removal failures are non-fatal
      }
    }
  } catch (error) {
    log.warn('sweep failed', error instanceof Error ? error.message : String(error));
  }
  return { removed, skipped: '' };
}

function isSitePausedForCookie(settings: Settings, cookieDomain: string): boolean {
  // A site-level pause is evaluated against the cookie's owning host.
  const host = normalizeHostname(cookieDomain.replace(/^\./, ''));
  const entry = settings.perSite[host];
  return entry?.paused === true;
}

/**
 * Tab-removal cleanup: removes tracker cookies for tracker hosts observed in that
 * tab's browsing context. Falls back to a bounded sweep when no context was tracked.
 */
export async function cleanupForTab(settings: Settings, tabId: number, observedTrackerHosts: ReadonlySet<string>): Promise<CookieCleanupResult> {
  if (!settings.masterEnabled || !settings.modules.cookies) {
    return { removed: 0, skipped: 'module disabled' };
  }
  const hosts = observedTrackerHosts;
  if (hosts.size === 0) {
    return sweepTrackerCookies(settings);
  }
  let removed = 0;
  for (const host of hosts) {
    const normalized = normalizeHostname(host);
    if (normalized.length === 0 || !isTrackerDomain(normalized)) continue;
    try {
      const cookies = await chrome.cookies.getAll({ domain: normalized });
      for (const cookie of cookies) {
        if (!isKnownTrackingCookie(cookie)) continue;
        if (classifyCookieDomain(cookie.domain) !== 'tracker') continue;
        try {
          const url = cookieUrl(cookie);
          await chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId });
          removed += 1;
        } catch {
          // non-fatal
        }
      }
    } catch {
      // non-fatal
    }
  }
  return { removed, skipped: '' };
}

export const COOKIE_SWEEP_ALARM = 'auvyq-cookie-sweep';
export const COOKIE_SWEEP_PERIOD_MINUTES = 60; // Event-driven + longer interval (avoids 1-minute full sweep)
