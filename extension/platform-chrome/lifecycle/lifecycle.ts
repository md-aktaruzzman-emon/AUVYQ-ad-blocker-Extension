/*
 * AUVYQ service worker lifecycle manager.
 * Handles initialization, alarms, settings cache, ruleset synchronization,
 * and crash-resilient dynamic rule pack activation.
 */
import { createLogger, configureLogging } from '../../core/logging/logger.js';
import { loadSettings, saveSettings } from '../../core/storage/settings.js';
import { STORAGE_KEYS, defaultSettings } from '../../core/storage/schema.js';
import { validateSettings, isRecord, isFiniteNumber } from '../../core/validation/schemas.js';
import { compileRulesDetailed } from '../../core/rule-compiler/compiler.js';
import { applyQuota, SAFE_DYNAMIC_CAPACITY } from '../../core/quota-manager/quota.js';
import { applyPackDiff, setSitePause, dnrMutex, assignPackIds } from '../dnr-adapter/adapter.js';
import { COOKIE_SWEEP_ALARM, COOKIE_SWEEP_PERIOD_MINUTES } from '../cookie-guard/guard.js';
import { defaultUpdateState } from '../../core/update-channel/channel.js';
import { registerPackRuleCategories } from '../request-observer/observer.js';
import { updateBadge } from '../badge/badge.js';
import { invalidateCosmeticCaches } from '../../core/cosmetic-engine/cache.js';
import type { Settings, UpdateState } from '../../types/schemas.js';

const log = createLogger('lifecycle');

export const ALARMS = {
  statsFlush: 'auvyq-stats-flush',
  retention: 'auvyq-retention',
  offscreenIdle: 'auvyq-offscreen-idle',
  updateCheck: 'auvyq-update-check'
} as const;

export class AsyncMutex {
  private queue = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const res = this.queue.then(fn, fn);
    this.queue = res.then(() => {}, () => {});
    return res;
  }
}

export const settingsMutex = new AsyncMutex();

let cachedSettings: Settings | null = null;
let lifecyclePromise: Promise<void> | null = null;
let activating = false;
let defaultPackChecked = false;

export const DEFAULT_LIST_URL = 'data/default-filters.txt';
export const DEFAULT_LIST_ID = 'default';
export const STATIC_RULESET_IDS = ['main', 'ads', 'trackers', 'annoyances', 'ads-trackers'];
export const MASTER_ALLOW_RULE_ID = 30000;

export function getCachedSettings(): Settings | null {
  return cachedSettings;
}

export function setCachedSettings(settings: Settings): void {
  cachedSettings = settings;
}

export function resetLifecycleForTesting(): void {
  lifecyclePromise = null;
  cachedSettings = null;
  activating = false;
  defaultPackChecked = false;
}

/**
 * Single-flight initialization promise: ensures multiple concurrent events
 * (e.g. 5 tabs opening simultaneously on browser startup) trigger initialization
 * exactly once without duplicate runs or race conditions.
 */
export async function ensureInitialized(): Promise<Settings> {
  if (lifecyclePromise === null) {
    lifecyclePromise = (async () => {
      cachedSettings = await loadSettings();
      configureLogging(cachedSettings.developerMode ? 'debug' : 'warn', cachedSettings.developerMode);
      await ensureAlarms();
      await chrome.declarativeNetRequest?.setExtensionActionOptions?.({ displayActionCountAsBadgeText: true }).catch?.(() => undefined);
      await syncNetworkBlocking(cachedSettings.masterEnabled, cachedSettings);

      // Re-populate session DNR rules for paused sites (session rules are cleared on browser restart)
      if (cachedSettings.perSite) {
        for (const [site, entry] of Object.entries(cachedSettings.perSite)) {
          if (entry && entry.paused) {
            void setSitePause(site, true).catch(() => undefined);
          }
        }
      }
      void activateDefaultPackIfNeeded();
      void updateBadge(cachedSettings);
    })().catch(async (error) => {
      lifecyclePromise = null;
      log.error('initialization failed', error instanceof Error ? error.message : String(error));
    });
  }
  await lifecyclePromise;
  if (cachedSettings === null) {
    cachedSettings = await loadSettings();
  }
  return cachedSettings;
}

export async function updateSettings(next: Settings): Promise<void> {
  await saveSettings(next);
  cachedSettings = next;
  invalidateCosmeticCaches();
}

/** Idempotently registers all MV3 alarms. */
export async function ensureAlarms(): Promise<void> {
  try {
    chrome.alarms.create(ALARMS.statsFlush, { periodInMinutes: 1 });
    chrome.alarms.create(ALARMS.retention, { periodInMinutes: 360 });
    chrome.alarms.create(ALARMS.offscreenIdle, { periodInMinutes: 2 });
    chrome.alarms.create(ALARMS.updateCheck, { periodInMinutes: 720 });
    chrome.alarms.create(COOKIE_SWEEP_ALARM, { periodInMinutes: COOKIE_SWEEP_PERIOD_MINUTES });
  } catch {
    // non-fatal in test contexts
  }
}

export async function handleInstalled(details: { reason: string }): Promise<void> {
  if (details.reason === 'install') {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
    if (raw[STORAGE_KEYS.settings] === undefined) {
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: defaultSettings() });
    }
    const done = (await chrome.storage.local.get(STORAGE_KEYS.onboardingDone))[STORAGE_KEYS.onboardingDone];
    if (done !== true) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('ui/onboarding/onboarding.html') }).catch(() => undefined);
    }
  }
  const settings = await ensureInitialized();
  void updateBadge(settings);
}

export async function handleStartup(): Promise<void> {
  const settings = await ensureInitialized();
  void updateBadge(settings);
}

/**
 * Synchronizes declarativeNetRequest static rulesets with current settings.
 * Installs master session allow rule when protection is turned off.
 */
export async function syncNetworkBlocking(enabled: boolean, settings?: Settings): Promise<void> {
  return dnrMutex.run(async () => {
    try {
      if (enabled) {
        const enableIds: string[] = ['main'];
        const disableIds: string[] = [];

        const adsOn = settings ? settings.modules.ads : true;
        const trackersOn = settings ? settings.modules.trackers : true;
        const annoyancesOn = settings ? (settings.modules.annoyances === true) : false;

        if (adsOn) enableIds.push('ads');
        else disableIds.push('ads');

        if (trackersOn) enableIds.push('trackers');
        else disableIds.push('trackers');

        if (annoyancesOn) enableIds.push('annoyances');
        else disableIds.push('annoyances');

        if (adsOn || trackersOn) enableIds.push('ads-trackers');
        else disableIds.push('ads-trackers');

        if (enableIds.length > 0 && chrome.declarativeNetRequest?.updateEnabledRulesets) {
          await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enableIds });
        }
        if (disableIds.length > 0 && chrome.declarativeNetRequest?.updateEnabledRulesets) {
          await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: disableIds });
        }
      } else if (chrome.declarativeNetRequest?.updateEnabledRulesets) {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [...STATIC_RULESET_IDS] });
      }
    } catch (error) {
      log.warn('ruleset switch failed', error instanceof Error ? error.message : String(error));
    }

    try {
      if (!chrome.declarativeNetRequest?.updateSessionRules) return;
      if (enabled) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [MASTER_ALLOW_RULE_ID] });
      } else {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [MASTER_ALLOW_RULE_ID],
          addRules: [{
            id: MASTER_ALLOW_RULE_ID,
            priority: 30000,
            action: { type: 'allow' },
            condition: { regexFilter: '^https?:' }
          }]
        });
      }
    } catch (error) {
      log.warn('master allow rule failed', error instanceof Error ? error.message : String(error));
    }
  });
}

/**
 * Compiles a raw filter list text and applies it to DNR with automatic rollback on error.
 */
export async function activatePackFromListText(
  listText: string,
  listId: string
): Promise<{ activated: boolean; error?: string; stats?: unknown }> {
  if (activating) return { activated: false, error: 'activation already in progress' };
  activating = true;
  try {
    const parsed = await import('../../core/rule-parser/parser.js').then((m) => m.parseFilterListWithStats(listText, listId));
    const compiled = compileRulesDetailed(parsed.rules);
    const quota = applyQuota(
      compiled.rules.map((rule) => ({
        key: rule.key,
        score: rule.frequency * rule.confidence,
        category: rule.category,
        rule: rule.rule,
        cosmeticFallback: rule.cosmeticFallback
      })),
      SAFE_DYNAMIC_CAPACITY
    );

    const perDomainCss = compiled.pack.cosmetic.perDomain;
    const demoted = quota.demotedCss;
    const additionalGeneric = demoted.join('\n');
    const mergedGenericCss = compiled.pack.cosmetic.genericCss.length > 0
      ? (additionalGeneric.length > 0 ? `${compiled.pack.cosmetic.genericCss}\n${additionalGeneric}` : compiled.pack.cosmetic.genericCss)
      : additionalGeneric;

    const pack = {
      ...compiled.pack,
      cosmetic: {
        genericCss: mergedGenericCss,
        perDomain: perDomainCss
      },
      stats: {
        rulesCompiled: compiled.pack.stats.rulesCompiled + demoted.length,
        dropped: compiled.pack.stats.dropped + quota.dropped,
        downgradedToCosmetic: compiled.pack.stats.downgradedToCosmetic + quota.stats.demotedToCosmetic
      }
    };

    const report = await applyPackDiff(quota.kept.map((kept) => ({ key: kept.key, rule: kept.rule })));
    if (report.rolledBack) {
      return { activated: false, error: report.error ?? 'DNR update failed; previous rules remain active' };
    }

    const categories = new Map<number, 'ads' | 'trackers' | 'params'>();
    const withIds = assignPackIds(quota.kept.map((k) => ({ key: k.key, rule: k.rule })));
    for (let i = 0; i < quota.kept.length; i++) {
      const kept = quota.kept[i];
      const assigned = withIds[i];
      if (!kept || !assigned) continue;
      if (assigned.action.redirect?.transform !== undefined) categories.set(assigned.id, 'params');
      else if (kept.category === 'trackers') categories.set(assigned.id, 'trackers');
      else categories.set(assigned.id, 'ads');
    }
    registerPackRuleCategories(categories);

    await chrome.storage.local.set({ [STORAGE_KEYS.pack]: pack });
    invalidateCosmeticCaches();
    log.info(`pack applied: +${report.added} -${report.removed}, demoted ${quota.stats.demotedToCosmetic}, dropped ${quota.dropped}`);
    return { activated: true, stats: pack.stats };
  } catch (error) {
    return { activated: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    activating = false;
  }
}

/**
 * Activates default filter list on fresh install or data clear.
 */
export async function activateDefaultPackIfNeeded(): Promise<void> {
  if (defaultPackChecked) return;
  defaultPackChecked = true;
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.pack);
    const pack = result[STORAGE_KEYS.pack];
    if (isRecord(pack) && isFiniteNumber(pack['version'])) return;
    const response = await fetch(chrome.runtime.getURL(DEFAULT_LIST_URL));
    if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
    const text = await response.text();
    const outcome = await activatePackFromListText(text, DEFAULT_LIST_ID);
    if (!outcome.activated) {
      log.warn('default pack activation failed', outcome.error ?? 'unknown');
    }
  } catch (error) {
    log.warn('default pack load failed', error instanceof Error ? error.message : String(error));
  }
}

export function resetDefaultPackChecked(): void {
  defaultPackChecked = false;
}

export async function getUpdateState(): Promise<UpdateState> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.updateState);
  const raw = result[STORAGE_KEYS.updateState];
  if (isRecord(raw) && typeof raw['endpoint'] === 'string') return raw as unknown as UpdateState;
  return defaultUpdateState('');
}
