/*
 * AUVYQ RPC handler registry.
 * Dispatches validated messages to core services with caching and security boundaries.
 */
import type { RpcHandler } from '../../types/messages.js';
import type { Settings, PresetName, ThreatLogEntry, UpdateState } from '../../types/schemas.js';
import { STORAGE_KEYS, defaultSettings, PRESETS } from '../../core/storage/schema.js';
import { applyPatch, applyPreset, setSitePaused, isSitePaused, setSiteAllowlisted, type SettingsPatch } from '../../core/storage/settings.js';
import { validateHostnameInput, isRecord, LIMITS } from '../../core/validation/schemas.js';
import { normalizeHostname, getDomainCandidates, matchSuffix } from '../../core/domain/normalize.js';
import { computePrivacyScore, type createStatsService } from '../../core/stats/snapshot.js';
import { calculatePrivacyScore } from '../../core/privacy-score/calculator.js';
import { setSitePause, applyPackDiff } from '../dnr-adapter/adapter.js';
import { classify, classifyWithModel } from '../../core/ml/classify.js';
import { configureLogging } from '../../core/logging/logger.js';
import { runUpdateCheck } from '../../core/update-channel/channel.js';
import { isKnownTrackingCookie, sweepTrackerCookies } from '../cookie-guard/guard.js';
import { buildBackupPayload, restoreBackupPayload } from '../../core/backup/backup.js';
import { callOffscreen } from '../offscreen-client/client.js';
import { updateBadge } from '../badge/badge.js';
import {
  ensureInitialized,
  updateSettings,
  syncNetworkBlocking,
  activatePackFromListText,
  activateDefaultPackIfNeeded,
  resetDefaultPackChecked,
  getUpdateState,
  ensureAlarms,
  settingsMutex
} from '../lifecycle/lifecycle.js';
import {
  getTabThreat,
  handleThreatAction,
  checkLoginForms
} from '../threat-manager/manager.js';
import {
  cosmeticCache,
  dispatchCache,
  createCosmeticKey,
  createDispatchKey,
  invalidateCosmeticCaches
} from '../../core/cosmetic-engine/cache.js';
import cookieClassification from '../../data/cookie-classification.json';
import staticSpecificCosmetic from '../../data/cosmetic/specific.json';
import staticScriptletDispatch from '../../data/scriptlets/dispatch.json';
import {
  loadStoredCustomRules,
  saveStoredCustomRules,
  syncCustomNetworkRules,
  validateCustomRuleInput,
  generateRuleId,
  exportCustomRules,
  importCustomRules,
  type CustomRule,
  type CustomRuleType
} from '../../core/rule-manager/custom-rules.js';
import { getActiveRiskModel } from '../../core/ml/classify.js';
import { LocalUrlRiskClassifier } from '../../core/ml/url-classifier.js';
import { checkBuiltInAiAvailability, generateThreatExplanation, generatePrivacyAdvice } from '../../core/ml/builtin-ai.js';
import { isPrivilegedSender } from './rpc.js';

export interface RpcContext {
  stats: ReturnType<typeof createStatsService>;
}

export function senderTabHost(sender: chrome.runtime.MessageSender): string {
  if (sender.tab?.url !== undefined) {
    try {
      return normalizeHostname(new URL(sender.tab.url).hostname);
    } catch {
      return '';
    }
  }
  if (sender.url !== undefined) {
    try {
      return normalizeHostname(new URL(sender.url).hostname);
    } catch {
      return '';
    }
  }
  return '';
}

export function classifyCookieCategory(domain: string, name?: string): string {
  const normalized = normalizeHostname(domain.replace(/^\./, ''));
  const cookieName = name || '';

  // 1. Session / Auth cookies on non-ad domains must be classified as session
  if (
    /^(ACCOUNT_CHOOSER|SID|HSID|SSID|__Secure-[13]PSID|__Secure-.*OSID|OSID|__Secure-DIVERSION.*|__Host-|auth|token|jwt|csrf|xsrf|session|PHPSESSID|JSESSIONID|ASPSESSIONID|connect\.sid)$/i.test(cookieName) ||
    /^(sess|auth|token|jwt|csrf|xsrf|login|secure_session)/i.test(cookieName)
  ) {
    const pureAdDomain = /(googleadservices|googlesyndication|doubleclick|adnxs|criteo|rubiconproject|pubmatic|openx|casalemedia|taboola|outbrain|adroll|adsrvr|bluekai|demdex|krxd)\.(com|net|org)/i.test(normalized);
    if (!pureAdDomain) return 'session';
  }

  // 2. Domain classification from database
  for (const rule of cookieClassification as { domain: string; category: string }[]) {
    if (matchSuffix(normalized, rule.domain)) return rule.category;
  }

  // 3. Known advertising & profiling tracking cookie names
  if (
    /^(Conversion|APISID|SAPISID|__Secure-[13]PAPISID|1P_JAR|NID|ANID|IDE|DSID|OTZ|fr|_fbp|_fbc|track|_uetsid|_uetvid|_gcl_.*|_gac_.*|__cf_bm|uuid2|tuuid|anj|KRTBCOOKIE_.*)$/i.test(cookieName)
  ) {
    return 'tracker';
  }

  // 4. Known analytics cookie names
  if (
    /^(_ga(_.*)?|_gid|_gat|_clck|_clsk|_pk_.*|mp_.*|ajs_.*|__utma|__utmb|__utmc|__utmz)$/i.test(cookieName)
  ) {
    return 'analytics';
  }

  return 'unknown';
}

export function createRpcHandlers(ctx: RpcContext): Record<string, RpcHandler> {
  const { stats } = ctx;

  return {
    GET_SNAPSHOT: async () => {
      const settings = await ensureInitialized();
      const snapshot = await stats.getToday();
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
      const tab = tabs[0];
      let host = '';
      if (tab?.url !== undefined) {
        try {
          host = normalizeHostname(new URL(tab.url).hostname);
        } catch {
          host = '';
        }
      }
      const sitePaused = host.length > 0 ? isSitePaused(settings, host) : false;
      const privacyReport = calculatePrivacyScore({
        settings,
        siteContext: { host, paused: sitePaused },
        snapshot
      });
      return {
        snapshot,
        privacyScore: privacyReport.score,
        privacyReport,
        masterEnabled: settings.masterEnabled,
        sitePaused,
        theme: settings.theme,
        host
      };
    },

    GET_PRIVACY_REPORT: async (payload, sender) => {
      const settings = await ensureInitialized();
      const requested = isRecord(payload) && typeof payload['host'] === 'string' ? payload['host'] : '';
      const host = normalizeHostname(requested.length > 0 ? requested : senderTabHost(sender));
      const siteCounters = host.length > 0 ? await stats.getSiteCounters(host, settings.logRetentionDays) : undefined;
      const snapshot = await stats.getToday();
      const sitePaused = host.length > 0 ? isSitePaused(settings, host) : false;

      return calculatePrivacyScore({
        settings,
        siteContext: {
          host,
          paused: sitePaused,
          trackersBlocked: siteCounters?.trackers,
          paramsStripped: siteCounters?.params
        },
        snapshot
      });
    },

    SWEEP_COOKIES: async () => {
      const settings = await ensureInitialized();
      return sweepTrackerCookies(settings);
    },

    GET_STATS_HISTORY: async () => {
      const settings = await ensureInitialized();
      return stats.getHistory(settings.logRetentionDays);
    },

    GET_SETTINGS: async () => ensureInitialized(),

    SET_SETTINGS: async (payload) => {
      if (!isRecord(payload)) throw new Error('bad payload');
      return settingsMutex.run(async () => {
        const current = await ensureInitialized();
        let next = current;
        if (payload['preset'] !== undefined) {
          const preset = payload['preset'];
          if (typeof preset !== 'string' || PRESETS[preset as PresetName] === undefined) {
            throw new Error('unknown preset');
          }
          next = applyPreset(next, preset as PresetName);
        }
        const patchKeys = Object.keys(payload).filter((k) => k !== 'preset');
        if (patchKeys.length > 0) {
          next = applyPatch(next, payload as SettingsPatch);
        }
        await updateSettings(next);
        invalidateCosmeticCaches();
        configureLogging(next.developerMode ? 'debug' : 'warn', next.developerMode);
        if (next.masterEnabled !== current.masterEnabled ||
            next.modules.ads !== current.modules.ads ||
            next.modules.trackers !== current.modules.trackers ||
            next.modules.annoyances !== current.modules.annoyances) {
          void syncNetworkBlocking(next.masterEnabled, next);
        }
        void updateBadge(next);
        return next;
      });
    },

    GET_SITE_REPORT: async (payload, sender) => {
      const settings = await ensureInitialized();
      const requested = isRecord(payload) && typeof payload['host'] === 'string' ? payload['host'] : '';
      const host = normalizeHostname(requested.length > 0 ? requested : senderTabHost(sender));
      if (host.length === 0) throw new Error('no host available');
      const counters = await stats.getSiteCounters(host, settings.logRetentionDays);
      const risk = await classifyWithModel(`https://${host}/`, { hostname: host, url: `https://${host}/` });
      const isPaused = isSitePaused(settings, host);
      const siteConfig = settings.perSite[host];
      const pausedUntil = siteConfig?.pausedUntil ?? null;
      const remainingSeconds = (isPaused && typeof pausedUntil === 'number' && pausedUntil > Date.now())
        ? Math.max(0, Math.round((pausedUntil - Date.now()) / 1000))
        : null;
      const privacy = calculatePrivacyScore({
        settings,
        siteContext: {
          host,
          paused: isPaused,
          trackersBlocked: counters.trackers,
          paramsStripped: counters.params
        }
      });
      return {
        host,
        paused: isPaused,
        pausedUntil,
        remainingSeconds,
        adsBlocked: counters.ads,
        trackersBlocked: counters.trackers,
        paramsStripped: counters.params,
        cosmeticHidden: counters.cosmetic,
        threats: counters.threats,
        risk,
        privacy
      };
    },

    SET_SITE_PAUSED: async (payload) => {
      if (!isRecord(payload) || typeof payload['host'] !== 'string' || typeof payload['paused'] !== 'boolean') {
        throw new Error('bad payload');
      }
      const host = validateHostnameInput(payload['host']);
      if (!host.ok) throw new Error(host.error);
      const current = await ensureInitialized();
      const durationMinutes = typeof payload['durationMinutes'] === 'number' ? payload['durationMinutes'] : undefined;
      let next = setSitePaused(current, host.value, payload['paused'], durationMinutes);
      if (payload['allow'] === true && payload['paused'] === true) {
        const existing = next.perSite[host.value] ?? { paused: true, allowlist: [] };
        if (!existing.allowlist.includes(host.value)) {
          next = {
            ...next,
            perSite: { ...next.perSite, [host.value]: { ...existing, allowlist: [...existing.allowlist, host.value].slice(0, 32) } }
          };
        }
      }
      const applied = await setSitePause(host.value, payload['paused']);
      if (!applied) throw new Error('DNR session rule failed');
      await updateSettings(next);
      invalidateCosmeticCaches();
      void updateBadge(next);
      const siteEntry = next.perSite[host.value];
      return {
        host: host.value,
        paused: payload['paused'],
        pausedUntil: siteEntry?.pausedUntil ?? null
      };
    },

    GET_DISPATCH: async (payload) => {
      if (!isRecord(payload)) throw new Error('bad payload');
      const host = validateHostnameInput(payload['host']);
      if (!host.ok) throw new Error(host.error);
      const settings = await ensureInitialized();
      const isPaused = isSitePaused(settings, host.value);
      if (!settings.masterEnabled || !settings.modules.ads || isPaused) return { entries: [] };

      const cacheKey = createDispatchKey(host.value, settings.modules.ads, isPaused);
      const cached = dispatchCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const result = await chrome.storage.local.get(STORAGE_KEYS.pack);
      const pack = result[STORAGE_KEYS.pack];

      const staticMap = (staticScriptletDispatch && typeof staticScriptletDispatch === 'object')
        ? (staticScriptletDispatch as Record<string, unknown>)
        : {};
      const dynamicMap = (isRecord(pack) && isRecord(pack['scriptletDispatch']))
        ? (pack['scriptletDispatch'] as Record<string, unknown>)
        : {};

      const candidates = [...getDomainCandidates(host.value), '(generic)'];
      const seen = new Set<string>();
      const entries: { name: string; args: (string | number)[] }[] = [];

      for (const candidate of candidates) {
        const lists = [dynamicMap[candidate], staticMap[candidate]];
        for (const list of lists) {
          if (Array.isArray(list)) {
            for (const item of list) {
              if (isRecord(item) && typeof item['name'] === 'string') {
                const key = `${item['name']}:${JSON.stringify(item['args'] ?? [])}`;
                if (!seen.has(key)) {
                  seen.add(key);
                  entries.push({
                    name: item['name'],
                    args: Array.isArray(item['args']) ? item['args'] as (string | number)[] : []
                  });
                }
              }
            }
          }
        }
      }
      const response = { entries: entries.slice(0, LIMITS.dispatchEntriesPerHost) };
      dispatchCache.set(cacheKey, response);
      return response;
    },

    GET_COSMETIC: async (payload) => {
      if (!isRecord(payload)) throw new Error('bad payload');
      const host = validateHostnameInput(payload['host']);
      if (!host.ok) throw new Error(host.error);
      const settings = await ensureInitialized();
      const hasAnyCosmetic = settings.modules.ads || settings.modules.annoyances;
      const isPaused = isSitePaused(settings, host.value);

      if (!settings.masterEnabled || !hasAnyCosmetic || isPaused) {
        return { css: '', selectors: [], enabled: false };
      }

      const cacheKey = createCosmeticKey(host.value, settings.modules.ads, settings.modules.annoyances === true, isPaused);
      const cached = cosmeticCache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }

      const result = await chrome.storage.local.get(STORAGE_KEYS.pack);
      const pack = result[STORAGE_KEYS.pack];
      const cosmetic = isRecord(pack) && isRecord(pack['cosmetic'])
        ? (pack['cosmetic'] as { genericCss?: unknown; perDomain?: unknown })
        : undefined;

      const cssParts: string[] = [];
      if (cosmetic && typeof cosmetic.genericCss === 'string' && cosmetic.genericCss.length > 0) {
        const isAnnoyance = (line: string) => /cookie|newsletter|subscribe|push-notification|web-push|onesignal|smart-banner|social-share|sticky-social/i.test(line);
        let gCss = cosmetic.genericCss;
        if (!settings.modules.annoyances) {
          gCss = gCss.split('\n').filter((line) => !isAnnoyance(line)).join('\n');
        } else if (!settings.modules.ads) {
          gCss = gCss.split('\n').filter((line) => isAnnoyance(line)).join('\n');
        }
        if (gCss.length > 0) cssParts.push(gCss);
      }

      const staticDomainMap = (staticSpecificCosmetic && typeof staticSpecificCosmetic === 'object')
        ? (staticSpecificCosmetic as Record<string, unknown>)
        : {};
      const dynamicDomainMap = (cosmetic && isRecord(cosmetic.perDomain))
        ? (cosmetic.perDomain as Record<string, unknown>)
        : {};

      const candidates = getDomainCandidates(host.value);
      const seenRules = new Set<string>();

      for (const candidate of candidates) {
        const ruleSources = [dynamicDomainMap[candidate], staticDomainMap[candidate]];
        for (const rules of ruleSources) {
          if (Array.isArray(rules)) {
            for (const r of rules) {
              if (typeof r === 'string' && r.length > 0 && !seenRules.has(r)) {
                seenRules.add(r);
                cssParts.push(r);
              }
            }
          } else if (typeof rules === 'string' && rules.length > 0 && !seenRules.has(rules)) {
            seenRules.add(rules);
            cssParts.push(rules);
          }
        }
      }

      const customRules = await loadStoredCustomRules().catch(() => []);
      for (const rule of customRules) {
        if (rule.enabled && rule.type === 'cosmetic' && rule.rawText) {
          const applies = !rule.domain || candidates.includes(rule.domain.toLowerCase());
          if (applies) {
            const line = `${rule.rawText} { display: none !important; }`;
            if (!seenRules.has(line)) {
              seenRules.add(line);
              cssParts.push(line);
            }
          }
        }
      }

      let css = cssParts.join('\n');
      if (css.length > 1024 * 1024) css = css.slice(0, 1024 * 1024);
      const selectors = css.split('\n')
        .map((line) => { const i = line.indexOf('{'); return i >= 0 ? line.slice(0, i).trim() : ''; })
        .filter((selector) => selector.length > 0)
        .slice(0, 500);

      const response = { css, selectors, enabled: true };
      cosmeticCache.set(cacheKey, response);
      return response;
    },

    REPORT_COSMETIC: async (payload) => {
      if (!isRecord(payload)) throw new Error('bad payload');
      const host = typeof payload['host'] === 'string' ? normalizeHostname(payload['host']) : '';
      const count = typeof payload['count'] === 'number' && Number.isSafeInteger(payload['count']) && payload['count'] > 0
        ? Math.min(payload['count'], 200)
        : 0;
      if (count === 0) return { recorded: false };
      await stats.recordEvents([{ category: 'cosmetic', count }]).catch(() => undefined);
      if (host.length > 0) {
        await stats.recordSiteEvents([{ host, category: 'cosmetic', count }]).catch(() => undefined);
      }
      return { recorded: true };
    },

    GET_FP_SHIELDS: async (payload) => {
      const settings = await ensureInitialized();
      const host = isRecord(payload) && typeof payload['host'] === 'string' ? normalizeHostname(payload['host']) : '';
      if (!settings.modules.fingerprintShields || !settings.masterEnabled || (host.length > 0 && isSitePaused(settings, host))) {
        return { shields: {} };
      }
      return { shields: settings.fpShields };
    },

    EXPORT_BACKUP: async (payload) => {
      if (!isRecord(payload) || typeof payload['password'] !== 'string') throw new Error('bad payload');
      const plaintextJson = await buildBackupPayload();
      const result = await callOffscreen<{ bytes: number[] }>('encrypt-backup', {
        plaintextJson,
        password: payload['password']
      });
      return result;
    },

    IMPORT_BACKUP: async (payload) => {
      if (!isRecord(payload) || !Array.isArray(payload['data']) || typeof payload['password'] !== 'string') {
        throw new Error('bad payload');
      }
      if (payload['data'].length > LIMITS.backupBytes) throw new Error('backup too large');
      const result = await callOffscreen<{ value: unknown }>('decrypt-backup', {
        bytes: payload['data'],
        password: payload['password']
      });
      return restoreBackupPayload(result.value, async (restoredSettings) => {
        configureLogging(restoredSettings.developerMode ? 'debug' : 'warn', restoredSettings.developerMode);
        void syncNetworkBlocking(restoredSettings.masterEnabled, restoredSettings);
        void updateBadge(restoredSettings);
        invalidateCosmeticCaches();
        const restoredRules = await loadStoredCustomRules();
        await syncCustomNetworkRules(restoredRules);
      });
    },

    CHECK_UPDATES: async () => {
      const settings = await ensureInitialized();
      const state = await getUpdateState();
      const outcome = await runUpdateCheck({
        currentVersion: chrome.runtime.getManifest().version,
        endpoint: state.endpoint,
        stage: {
          compileAndActivate: async (packText, listId) => {
            const activation = await activatePackFromListText(packText, listId);
            return { activated: activation.activated, error: activation.error };
          }
        }
      });
      const next: UpdateState = {
        ...state,
        lastCheck: Date.now(),
        status: outcome.ok ? 'up-to-date' : 'failed',
        lastError: outcome.ok ? undefined : `${outcome.stage}: ${outcome.error ?? 'unknown'}`
      };
      await chrome.storage.local.set({ [STORAGE_KEYS.updateState]: next });
      void updateBadge(settings);
      return { ok: outcome.ok, stage: outcome.stage, error: outcome.error };
    },

    GET_UPDATE_STATE: async () => getUpdateState(),

    SET_ONBOARDING_DONE: async (payload) => {
      const done = isRecord(payload) && typeof payload['done'] === 'boolean' ? payload['done'] : true;
      await chrome.storage.local.set({ [STORAGE_KEYS.onboardingDone]: done });
      return { ok: true, done };
    },

    GET_THREAT_LOG: async (payload) => {
      const page = isRecord(payload) && typeof payload['page'] === 'number' ? Math.max(0, Math.floor(payload['page'])) : 0;
      const result = await chrome.storage.local.get(STORAGE_KEYS.threatLog);
      const all = Array.isArray(result[STORAGE_KEYS.threatLog]) ? result[STORAGE_KEYS.threatLog] as ThreatLogEntry[] : [];
      const pageSize = 20;
      return {
        total: all.length,
        page,
        entries: all.slice(page * pageSize, (page + 1) * pageSize)
      };
    },

    GET_COOKIE_REPORT: async () => {
      const all = await chrome.cookies?.getAll?.({}) ?? [];
      const entries = all.slice(0, 300).map((cookie) => ({
        name: cookie.name.slice(0, 64),
        domain: cookie.domain.slice(0, 253),
        category: classifyCookieCategory(cookie.domain, cookie.name)
      }));
      return { total: all.length, entries };
    },

    REMOVE_COOKIES: async (payload) => {
      if (!isRecord(payload) || !Array.isArray(payload['entries'])) throw new Error('bad payload');
      let removed = 0;
      for (const entry of (payload['entries'] as unknown[]).slice(0, 300)) {
        if (!isRecord(entry) || typeof entry['name'] !== 'string' || typeof entry['domain'] !== 'string') continue;
        if (!isKnownTrackingCookie({ name: entry['name'], domain: entry['domain'] })) continue;
        const category = classifyCookieCategory(entry['domain'], entry['name']);
        if (category !== 'tracker' && category !== 'analytics') continue;
        try {
          const domain = entry['domain'].replace(/^\./, '');
          const path = typeof entry['path'] === 'string' && entry['path'].startsWith('/') ? entry['path'] : '/';
          const storeId = typeof entry['storeId'] === 'string' ? entry['storeId'] : undefined;
          let res = await chrome.cookies.remove({ url: `https://${domain}${path}`, name: entry['name'], storeId }).catch(() => null);
          if (!res) {
            res = await chrome.cookies.remove({ url: `http://${domain}${path}`, name: entry['name'], storeId }).catch(() => null);
          }
          if (res) {
            removed += 1;
          }
        } catch {
          // non-fatal
        }
      }
      await stats.recordEvents([{ category: 'cookies', count: removed }]).catch(() => undefined);
      return { removed };
    },

    CLEAR_AUVYQ_DATA: async () => {
      await chrome.storage.local.remove([
        STORAGE_KEYS.settings, STORAGE_KEYS.snapshots, STORAGE_KEYS.siteStats, STORAGE_KEYS.threatLog,
        STORAGE_KEYS.pack, STORAGE_KEYS.packRuleIds, STORAGE_KEYS.telemetryQueue,
        STORAGE_KEYS.onboardingDone, STORAGE_KEYS.updateState, STORAGE_KEYS.tabThreats
      ]);
      await chrome.storage.session?.clear?.().catch?.(() => undefined);
      try {
        const sessionRules = await chrome.declarativeNetRequest?.getSessionRules?.() ?? [];
        if (sessionRules.length > 0 && chrome.declarativeNetRequest?.updateSessionRules) {
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: sessionRules.map((r) => r.id)
          });
        }
      } catch {
        // non-fatal
      }
      const settings = defaultSettings();
      await updateSettings(settings);
      await applyPackDiff([]);
      invalidateCosmeticCaches();
      resetDefaultPackChecked();
      await activateDefaultPackIfNeeded();
      await ensureAlarms();
      void updateBadge(settings);
      return { cleared: true };
    },

    GET_DIAGNOSTICS: async () => {
      const settings = await ensureInitialized();
      const packResult = await chrome.storage.local.get(STORAGE_KEYS.pack);
      const pack = packResult[STORAGE_KEYS.pack];
      const alarms = await chrome.alarms?.getAll?.() ?? [];
      return {
        version: chrome.runtime.getManifest().version,
        masterEnabled: settings.masterEnabled,
        preset: settings.preset,
        developerMode: settings.developerMode,
        packStats: isRecord(pack) ? pack['stats'] : null,
        alarms: alarms.map((a) => ({ name: a.name, periodInMinutes: a.periodInMinutes ?? 0 })),
        snapshot: await stats.getToday()
      };
    },

    CHECK_LOGIN_FORMS: async (payload, sender) => {
      if (!isRecord(payload) || typeof payload['pageOrigin'] !== 'string' || !Array.isArray(payload['forms'])) {
        throw new Error('bad payload');
      }
      const tabId = sender?.tab?.id;
      let pageOrigin = payload['pageOrigin'];
      if (sender?.tab?.url) {
        try {
          const tabOrigin = new URL(sender.tab.url).origin;
          if (pageOrigin !== tabOrigin) {
            pageOrigin = tabOrigin;
          }
        } catch {
          // retain pageOrigin
        }
      }
      const settings = await ensureInitialized();
      return checkLoginForms(pageOrigin, payload['forms'] as unknown[], tabId, settings, (events) => stats.recordEvents(events), updateBadge);
    },

    THREAT_ACTION: async (payload, sender) => {
      if (!isRecord(payload)) throw new Error('bad payload');
      let tabId = typeof payload['tabId'] === 'number' ? payload['tabId'] : sender.tab?.id;
      if (tabId === undefined) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        if (tabs[0]?.id === undefined) throw new Error('no tab available');
        tabId = tabs[0].id;
      }
      const action = payload['action'];
      if (typeof action !== 'string' || !['leave', 'block', 'continue', 'allowlist', 'report_false_positive'].includes(action)) {
        throw new Error('bad action');
      }
      return handleThreatAction(
        tabId,
        action,
        (events) => stats.recordEvents(events),
        async (hostToAllow) => {
          const settings = await ensureInitialized();
          const next = setSiteAllowlisted(settings, hostToAllow, true);
          await updateSettings(next);
        }
      );
    },

    REPORT_FALSE_POSITIVE: async (payload, sender) => {
      if (!isRecord(payload)) throw new Error('bad payload');
      let tabId = typeof payload['tabId'] === 'number' ? payload['tabId'] : sender.tab?.id;
      if (tabId === undefined) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        tabId = tabs[0]?.id;
      }
      if (tabId === undefined) throw new Error('no tab available');
      return handleThreatAction(
        tabId,
        'report_false_positive',
        (events) => stats.recordEvents(events)
      );
    },

    GET_TAB_STATE: async (payload, sender) => {
      let tabId = isRecord(payload) && typeof payload['tabId'] === 'number' ? payload['tabId'] : sender.tab?.id;
      if (tabId === undefined) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        tabId = tabs[0]?.id;
      }
      if (tabId === undefined) return { state: null };
      const state = await getTabThreat(tabId);
      return { state };
    },

    GET_CUSTOM_RULES: async () => {
      const rules = await loadStoredCustomRules();
      return { rules };
    },

    ADD_CUSTOM_RULE: async (payload, sender) => {
      if (!isRecord(payload) || typeof payload['rawText'] !== 'string') {
        throw new Error('bad payload');
      }
      const requestedType: CustomRuleType = (payload['type'] === 'network' || payload['ruleType'] === 'network') ? 'network' : 'cosmetic';
      let type: CustomRuleType = requestedType;
      let domain = typeof payload['domain'] === 'string' && payload['domain'].trim().length > 0
        ? normalizeHostname(payload['domain'])
        : undefined;

      // Security boundary: Content script senders can ONLY create domain-scoped cosmetic rules for their own tab host
      if (!isPrivilegedSender(sender)) {
        if (requestedType === 'network') {
          throw new Error('unauthorized: content scripts cannot create network rules');
        }
        type = 'cosmetic';
        const senderHost = senderTabHost(sender);
        if (!senderHost) throw new Error('unauthorized: sender host could not be verified');
        domain = senderHost;
      }

      const validation = validateCustomRuleInput(payload['rawText'], type, domain);
      if (!validation.valid) throw new Error(validation.error || 'invalid custom rule');

      const rules = await loadStoredCustomRules();
      const newRule: CustomRule = {
        id: generateRuleId(),
        type,
        rawText: validation.normalized || payload['rawText'].trim(),
        domain,
        enabled: true,
        createdAt: Date.now()
      };
      const updatedRules = [newRule, ...rules.slice(0, 999)];
      await saveStoredCustomRules(updatedRules);
      if (type === 'network') {
        await syncCustomNetworkRules(updatedRules);
      }
      invalidateCosmeticCaches();
      return { rule: newRule };
    },

    UPDATE_CUSTOM_RULE: async (payload) => {
      if (!isRecord(payload) || typeof payload['id'] !== 'string') {
        throw new Error('bad payload');
      }
      const rules = await loadStoredCustomRules();
      const index = rules.findIndex((r) => r.id === payload['id']);
      if (index === -1) throw new Error('custom rule not found');

      const existing = rules[index];
      let rawText = existing.rawText;
      if (typeof payload['rawText'] === 'string' && payload['rawText'].trim().length > 0) {
        const val = validateCustomRuleInput(payload['rawText'], existing.type, existing.domain);
        if (!val.valid) throw new Error(val.error || 'invalid custom rule');
        rawText = val.normalized || payload['rawText'].trim();
      }
      const enabled = typeof payload['enabled'] === 'boolean' ? payload['enabled'] : existing.enabled;

      const updatedRule: CustomRule = {
        ...existing,
        rawText,
        enabled
      };
      rules[index] = updatedRule;
      await saveStoredCustomRules(rules);
      if (existing.type === 'network') {
        await syncCustomNetworkRules(rules);
      }
      invalidateCosmeticCaches();
      return { rule: updatedRule };
    },

    DELETE_CUSTOM_RULE: async (payload) => {
      if (!isRecord(payload) || typeof payload['id'] !== 'string') {
        throw new Error('bad payload');
      }
      const rules = await loadStoredCustomRules();
      const filtered = rules.filter((r) => r.id !== payload['id']);
      await saveStoredCustomRules(filtered);
      await syncCustomNetworkRules(filtered);
      invalidateCosmeticCaches();
      return { deleted: true };
    },

    IMPORT_CUSTOM_RULES: async (payload) => {
      if (!isRecord(payload) || typeof payload['payload'] !== 'string') {
        throw new Error('bad payload');
      }
      const outcome = importCustomRules(payload['payload']);
      if (outcome.imported.length > 0) {
        const existing = await loadStoredCustomRules();
        const existingKeys = new Set(existing.map((r) => `${r.type}:${r.domain || ''}:${r.rawText}`));
        const toAdd = outcome.imported.filter((r) => !existingKeys.has(`${r.type}:${r.domain || ''}:${r.rawText}`));
        const merged = [...toAdd, ...existing].slice(0, 1000);
        await saveStoredCustomRules(merged);
        await syncCustomNetworkRules(merged);
        invalidateCosmeticCaches();
      }
      return {
        imported: outcome.imported.length,
        errors: outcome.errors
      };
    },

    EXPORT_CUSTOM_RULES: async (payload) => {
      const format = (isRecord(payload) && payload['format'] === 'json') ? 'json' : 'text';
      const rules = await loadStoredCustomRules();
      const text = exportCustomRules(rules, format);
      return { payload: text, count: rules.length };
    },

    START_ELEMENT_PICKER: async (payload, sender) => {
      let tabId = isRecord(payload) && typeof payload['tabId'] === 'number' ? payload['tabId'] : sender.tab?.id;
      if (tabId === undefined) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
        tabId = tabs[0]?.id;
      }
      if (tabId === undefined) throw new Error('no active tab available');
      if (typeof chrome !== 'undefined' && chrome.scripting?.executeScript) {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content/element-picker.js']
        });
      }
      return { started: true };
    },

    GET_AI_STATUS: async () => {
      const builtIn = await checkBuiltInAiAvailability();
      const model = getActiveRiskModel();
      return {
        localMlActive: model !== null,
        localMlVersion: model?.version || '1.0.0-statistical-lr',
        builtInAiStatus: builtIn,
        memoryHeapEstimatedKb: 45
      };
    },

    ANALYZE_URL_INTELLIGENCE: async (payload) => {
      if (!isRecord(payload) || typeof payload['url'] !== 'string') {
        throw new Error('invalid url payload');
      }
      const rawUrl = payload['url'].trim();
      if (!rawUrl) throw new Error('empty url');

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl.includes('://') ? rawUrl : `https://${rawUrl}`);
      } catch {
        throw new Error('invalid url format');
      }
      const canonicalUrl = parsedUrl.href;
      const hostname = normalizeHostname(parsedUrl.hostname);

      const classifier = new LocalUrlRiskClassifier();
      const features = classifier.extractFeatures(canonicalUrl);
      const mlScore = classifier.scoreFeatures(features);
      const risk = await classifier.classify(canonicalUrl, { hostname, url: canonicalUrl });
      const explanation = await generateThreatExplanation(hostname, risk);
      return {
        url: canonicalUrl,
        mlScore,
        risk,
        explanation
      };
    },

    GET_AI_EXPLANATION: async (payload) => {
      if (!isRecord(payload) || typeof payload['host'] !== 'string') {
        throw new Error('invalid host payload');
      }
      const host = normalizeHostname(payload['host']);
      const risk = (isRecord(payload['risk']) && typeof payload['risk']['score'] === 'number')
        ? (payload['risk'] as unknown as import('../../types/schemas.js').RiskResult)
        : await classifyWithModel(`https://${host}/`, { hostname: host, url: `https://${host}/` });
      return generateThreatExplanation(host, risk);
    },

    GET_AI_PRIVACY_ADVICE: async (payload) => {
      if (!isRecord(payload) || typeof payload['host'] !== 'string') {
        throw new Error('invalid host payload');
      }
      const host = normalizeHostname(payload['host']);
      const settings = await ensureInitialized();
      const siteCounters = await stats.getSiteCounters(host, settings.logRetentionDays);
      const privacyScore = calculatePrivacyScore({
        settings,
        siteContext: {
          host,
          trackersBlocked: siteCounters.trackers,
          paramsStripped: siteCounters.params
        }
      });
      return generatePrivacyAdvice(
        host,
        privacyScore.score,
        siteCounters.trackers || 0,
        0,
        false
      );
    }
  };
}
