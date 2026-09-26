/*
 * Request observer. Registers at module top level. OBSERVATION ONLY: the listener
 * never returns a blocking response. Broad <all_urls> observation is part of the design.
 *
 * Blocked-request counting uses declarativeNetRequest.onRuleMatchedDebug when the
 * extension runs unpacked (development). In packed production builds that channel is
 * unavailable; parameter-stripping counts then derive from observed URLs. This
 * limitation is documented in the README.
 */
import mainRulesJson from '../../rules/main.json';
import annoyancesJson from '../../rules/annoyances.json';
import adsTrackersJson from '../../rules/ads-trackers.json';
import trackingParamsJson from '../../data/tracking-params.json';
import type { StatEvent, StatsService } from '../../core/stats/snapshot.js';
import { normalizeHostname } from '../../core/domain/normalize.js';
import { isTrackerDomain } from '../cookie-guard/guard.js';
import { createLogger } from '../../core/logging/logger.js';

const log = createLogger('observer');

type DnrRule = chrome.declarativeNetRequest.Rule;
const BUNDLED_RULES: readonly DnrRule[] = [
  ...(mainRulesJson as DnrRule[]),
  ...(annoyancesJson as DnrRule[]),
  ...(adsTrackersJson as DnrRule[])
];

const TRACKING_PARAMS: readonly string[] = trackingParamsJson;

/** ruleId -> stats category for bundled static rules. */
const bundledCategoryById = new Map<number, StatEvent['category']>();
/** Hosts covered by bundled removeparam rules (parameter stripping counting). */
const removeParamHosts = new Set<string>();
/** Known blocklist request domains (used to attribute allowed-request categories). */
const bundledBlockDomains = new Set<string>();

for (const rule of BUNDLED_RULES) {
  const domains = rule.condition.requestDomains ?? [];
  const isTransform = rule.action.redirect?.transform?.queryTransform !== undefined;
  if (isTransform) {
    bundledCategoryById.set(rule.id, 'params');
    for (const d of domains) removeParamHosts.add(d);
    if (rule.condition.urlFilter !== undefined) {
      const host = urlFilterHost(rule.condition.urlFilter);
      if (host.length > 0) removeParamHosts.add(host);
    }
    continue;
  }
  const category: StatEvent['category'] = domains.some((d) => isTrackerDomain(d)) ? 'trackers' : 'ads';
  bundledCategoryById.set(rule.id, category);
  for (const d of domains) bundledBlockDomains.add(d);
}

function urlFilterHost(urlFilter: string): string {
  const stripped = urlFilter.replace(/^\|\|/, '').replace(/[\^|*].*$/, '');
  return normalizeHostname(stripped);
}

/** Dynamic pack rule categories, registered by the service worker at activation time. */
const packCategoryById = new Map<number, StatEvent['category']>();

export function registerPackRuleCategories(categories: Map<number, StatEvent['category']>): void {
  packCategoryById.clear();
  for (const [id, category] of categories) packCategoryById.set(id, category);
}

export function createRequestObserver(stats: StatsService) {
  const pending: StatEvent[] = [];
  const pendingSite: { host: string; category: StatEvent['category']; count: number }[] = [];
  let pendingCount = 0;
  const tabTrackerHosts = new Map<number, Set<string>>();
  let lastBadgeFlash = 0;
  let badgeFlashTimer: ReturnType<typeof setTimeout> | null = null;

  function buffer(category: StatEvent['category'], count = 1, host = ''): void {
    if (pendingCount > 5000) return; // bounded buffer under load
    pending.push({ category, count });
    pendingCount += count;
    if (host.length > 0 && pendingSite.length < 1000) {
      pendingSite.push({ host, category, count });
    }
  }

  async function flush(): Promise<void> {
    if (pending.length === 0 && pendingSite.length === 0) return;
    const events = pending.splice(0, pending.length);
    const siteEvents = pendingSite.splice(0, pendingSite.length);
    pendingCount = 0;
    await stats.recordEvents(events);
    if (siteEvents.length > 0) {
      await stats.recordSiteEvents(siteEvents).catch(() => undefined);
    }
  }

  function trackTabHost(tabId: number, host: string): void {
    if (tabId < 0) return;
    let set = tabTrackerHosts.get(tabId);
    if (set === undefined) {
      set = new Set<string>();
      if (tabTrackerHosts.size > 512) {
        const firstKey = tabTrackerHosts.keys().next().value;
        if (firstKey !== undefined) tabTrackerHosts.delete(firstKey);
      }
      tabTrackerHosts.set(tabId, set);
    }
    if (set.size < 64) set.add(host);
  }

  // Top-level registration: observation only, never blocking.
  if (chrome.webRequest?.onBeforeRequest !== undefined) {
    chrome.webRequest.onBeforeRequest.addListener((details) => {
      if (details.tabId < 0) return;
      let host = '';
      let paramsSeen = false;
      try {
        const parsed = new URL(details.url);
        host = parsed.hostname;
        if (parsed.search.length > 1) {
          for (const param of TRACKING_PARAMS) {
            if (parsed.searchParams.has(param)) {
              paramsSeen = true;
              break;
            }
          }
        }
      } catch {
        return;
      }
      if (host.length === 0) return;
      const initiatorHost = details.initiator !== undefined ? safeHost(details.initiator) : '';
      if (initiatorHost.length > 0 && initiatorHost !== host && isTrackerDomain(host)) {
        trackTabHost(details.tabId, host);
      }
      if (paramsSeen && removeParamHosts.has(host)) {
        buffer('params');
      }
    }, { urls: ['<all_urls>'] });
  }

  // Precise blocked-rule counting in unpacked/development builds.
  if (chrome.declarativeNetRequest.onRuleMatchedDebug !== undefined) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
      const category = packCategoryById.get(info.rule.id) ?? bundledCategoryById.get(info.rule.id);
      if (category === undefined) return;
      const host = safeHost(info.url);
      if (category === 'params') {
        buffer('params', 1, host);
        return;
      }
      buffer(category, 1, host);
      maybeFlashBadge();
      const initiatorHost = info.initiator !== undefined ? safeHost(info.initiator) : '';
      if (host.length > 0 && initiatorHost !== host && isTrackerDomain(host) && info.tabId !== undefined) {
        trackTabHost(info.tabId, host);
      }
    });
  }

  function maybeFlashBadge(): void {
    // Short color flash only: <=400ms, throttled to once per 30s, never a loop.
    const now = Date.now();
    if (now - lastBadgeFlash < 30000 || badgeFlashTimer !== null) return;
    lastBadgeFlash = now;
    void chrome.action.setBadgeText({ text: '+1' });
    void chrome.action.setBadgeBackgroundColor({ color: '#5B4BFF' });
    badgeFlashTimer = setTimeout(() => {
      badgeFlashTimer = null;
      void chrome.action.setBadgeText({ text: '' });
    }, 400);
  }

  function getTabTrackerHosts(tabId: number): Set<string> {
    return tabTrackerHosts.get(tabId) ?? new Set<string>();
  }

  function noteTabRemoved(tabId: number): void {
    tabTrackerHosts.delete(tabId);
  }

  log.info('observer initialized');
  return { buffer, flush, getTabTrackerHosts, noteTabRemoved };
}

export type RequestObserver = ReturnType<typeof createRequestObserver>;

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export { normalizeHostname };
