/*
 * AUVYQ service worker (single worker entry; bundled by esbuild into dist/sw.js).
 *
 * ALL event listeners are registered synchronously at module top level.
 * The worker may terminate at any moment: durable state lives ONLY in
 * chrome.storage.local / chrome.storage.session / IndexedDB. Module-level
 * variables are restricted to locks, promises and short-lived caches.
 */
import { createLogger, configureLogging, hostOfUrl } from './core/logging/logger.js';
import { createStatsService, emptySnapshot, computePrivacyScore, todayKey } from './core/stats/snapshot.js';
import { createRequestObserver, registerPackRuleCategories } from './platform-chrome/request-observer/observer.js';
import { createRpcRouter, registerRpcListener } from './platform-chrome/rpc/rpc.js';
import type { RpcHandler } from './types/messages.js';
import { loadSettings, saveSettings, applyPatch, applyPreset, setSitePaused, isSitePaused } from './core/storage/settings.js';
import { STORAGE_KEYS, defaultSettings, PRESETS } from './core/storage/schema.js';
import type { Settings, Snapshot, RiskResult, ThreatLogEntry, UpdateState, TabThreatState, PresetName } from './types/schemas.js';
import { validateSettings, validateHostnameInput, validateRiskResult, isRecord, isFiniteNumber, LIMITS } from './core/validation/schemas.js';
import { normalizeHostname, displayHost, getDomainCandidates } from './core/domain/normalize.js';
import { compileRulesDetailed } from './core/rule-compiler/compiler.js';
import { applyQuota, SAFE_DYNAMIC_CAPACITY } from './core/quota-manager/quota.js';
import { applyPackDiff, setSitePause, dnrMutex } from './platform-chrome/dnr-adapter/adapter.js';
import { sweepTrackerCookies, cleanupForTab, handleCookieChanged, isKnownTrackingCookie, COOKIE_SWEEP_ALARM, COOKIE_SWEEP_PERIOD_MINUTES } from './platform-chrome/cookie-guard/guard.js';
import { createTelemetryService } from './core/telemetry/queue.js';
import { runUpdateCheck, defaultUpdateState } from './core/update-channel/channel.js';
import { assessThreat } from './core/heuristic/tier1.js';
import { classify } from './core/ml/classify.js';
import { matchSuffix } from './core/domain/normalize.js';
import cookieClassification from './data/cookie-classification.json';
import staticSpecificCosmetic from './data/cosmetic/specific.json';
import staticScriptletDispatch from './data/scriptlets/dispatch.json';

const log = createLogger('sw');

// ---------------------------------------------------------------------------
// Short-lived module state (locks/caches only — never durable)
// ---------------------------------------------------------------------------
const stats = createStatsService();
const observer = createRequestObserver(stats);
let initPromise: Promise<Settings> | null = null;
let offscreenLastUse = 0;
let offscreenInFlight = new Map<string, Promise<unknown>>();
const OFFSCREEN_IDLE_MS = 60000;

const ALARMS = {
  statsFlush: 'auvyq-stats-flush',
  retention: 'auvyq-retention',
  offscreenIdle: 'auvyq-offscreen-idle',
  updateCheck: 'auvyq-update-check'
} as const;

// ---------------------------------------------------------------------------
// Settings + lifecycle
// ---------------------------------------------------------------------------

async function ensureInitialized(): Promise<Settings> {
  if (initPromise === null) {
    initPromise = (async () => {
      const settings = await loadSettings();
      configureLogging(settings.developerMode ? 'debug' : 'warn', settings.developerMode);
      await ensureAlarms();
      // Reconcile the actual blocking state with the stored master switch and module settings.
      await syncNetworkBlocking(settings.masterEnabled, settings);
      // Fire-and-forget: compile the bundled default filter pack if none exists.
      void activateDefaultPackIfNeeded();
      void updateBadge(settings);
      return settings;
    })().catch(async (error) => {
      initPromise = null;
      log.error('initialization failed', error instanceof Error ? error.message : String(error));
      return defaultSettings();
    });
  }
  return initPromise;
}

async function ensureAlarms(): Promise<void> {
  chrome.alarms.create(ALARMS.statsFlush, { periodInMinutes: 1 });
  chrome.alarms.create(ALARMS.retention, { periodInMinutes: 360 });
  chrome.alarms.create(ALARMS.offscreenIdle, { periodInMinutes: 2 });
  chrome.alarms.create(ALARMS.updateCheck, { periodInMinutes: 720 });
  chrome.alarms.create(COOKIE_SWEEP_ALARM, { periodInMinutes: COOKIE_SWEEP_PERIOD_MINUTES });
}

const CONTENT_SCRIPTS = [
  { id: 'auvyq-cosmetic', matches: ['<all_urls>'], js: ['content/cosmetic-injector.js'], runAt: 'document_start' as const, world: 'ISOLATED' as const, persistAcrossSessions: true },
  { id: 'auvyq-dispatch', matches: ['<all_urls>'], js: ['content/scriptlet-dispatch.js'], runAt: 'document_start' as const, world: 'MAIN' as const, persistAcrossSessions: true },
  { id: 'auvyq-fp', matches: ['<all_urls>'], js: ['content/fp-shields.js'], runAt: 'document_start' as const, world: 'MAIN' as const, persistAcrossSessions: true },
  { id: 'auvyq-banner', matches: ['<all_urls>'], js: ['content/warning-banner.js'], runAt: 'document_idle' as const, world: 'ISOLATED' as const, persistAcrossSessions: true }
];

async function registerContentScriptsSafely(): Promise<void> {
  try {
    await chrome.scripting.registerContentScripts(CONTENT_SCRIPTS);
  } catch {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: CONTENT_SCRIPTS.map((s) => s.id) });
      await chrome.scripting.registerContentScripts(CONTENT_SCRIPTS);
    } catch (error) {
      log.warn('content script registration failed', error instanceof Error ? error.message : String(error));
    }
  }
}

async function handleInstalled(details: { reason: string }): Promise<void> {
  if (details.reason === 'install') {
    const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
    if (raw[STORAGE_KEYS.settings] === undefined) {
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: defaultSettings() });
    }
    await chrome.storage.local.get(STORAGE_KEYS.onboardingDone);
    const done = (await chrome.storage.local.get(STORAGE_KEYS.onboardingDone))[STORAGE_KEYS.onboardingDone];
    if (done !== true) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('ui/onboarding/onboarding.html') });
    }
  }
  await registerContentScriptsSafely();
  const settings = await ensureInitialized();
  void updateBadge(settings);
}

async function handleStartup(): Promise<void> {
  await registerContentScriptsSafely();
  const settings = await ensureInitialized();
  void updateBadge(settings);
}

// ---------------------------------------------------------------------------
// Badge
// ---------------------------------------------------------------------------

async function updateBadge(settings: Settings, threat?: RiskResult): Promise<void> {
  if (!settings.masterEnabled) {
    await chrome.action.setBadgeText({ text: '×' });
    await chrome.action.setBadgeBackgroundColor({ color: '#77738F' });
    await chrome.action.setTitle({ title: 'AUVYQ — Protection disabled' });
    return;
  }
  if (threat !== undefined && (threat.severity === 'high' || threat.severity === 'malicious')) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#EF4444' });
    await chrome.action.setTitle({ title: 'AUVYQ — Threat detected' });
    return;
  }
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#22C55E' });
  await chrome.action.setTitle({ title: 'AUVYQ — Protected' });
}

// ---------------------------------------------------------------------------
// Pack activation (compile -> quota -> diff apply), atomic with rollback
// ---------------------------------------------------------------------------

let activating = false;

export async function activatePackFromListText(listText: string, listId: string): Promise<{ activated: boolean; error?: string; stats?: unknown }> {
  if (activating) return { activated: false, error: 'activation already in progress' };
  activating = true;
  try {
    const parsed = await import('./core/rule-parser/parser.js').then((m) => m.parseFilterListWithStats(listText, listId));
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

    // Demoted CSS is folded into the pack's cosmetic CSS before activation.
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

    // Rule-id -> category map for accurate stats attribution.
    const categories = new Map<number, 'ads' | 'trackers' | 'params'>();
    for (const kept of quota.kept) {
      if (kept.rule.action.redirect?.transform !== undefined) categories.set(kept.rule.id, 'params');
      else if (kept.category === 'trackers') categories.set(kept.rule.id, 'trackers');
      else categories.set(kept.rule.id, 'ads');
    }
    registerPackRuleCategories(categories);

    await chrome.storage.local.set({ [STORAGE_KEYS.pack]: pack });
    log.info(`pack applied: +${report.added} -${report.removed}, demoted ${quota.stats.demotedToCosmetic}, dropped ${quota.dropped}`);
    return { activated: true, stats: pack.stats };
  } catch (error) {
    return { activated: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    activating = false;
  }
}

// ---------------------------------------------------------------------------
// Default pack + master blocking switch
// ---------------------------------------------------------------------------

/** Bundled filter list compiled into the dynamic pack when no pack exists yet. */
const DEFAULT_LIST_URL = 'data/default-filters.txt';
const DEFAULT_LIST_ID = 'default';
const STATIC_RULESET_IDS = ['main', 'ads', 'trackers', 'annoyances', 'ads-trackers'];
/** Top-priority session allow rule that suspends ALL blocking while protection is off. */
const MASTER_ALLOW_RULE_ID = 30000;

let defaultPackChecked = false;

/**
 * Activates the bundled default filter list as the dynamic rule pack when the
 * stored pack is missing (fresh install, cleared data, failed update). A pack
 * that came from the signed update channel is never clobbered.
 */
async function activateDefaultPackIfNeeded(): Promise<void> {
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

/**
 * Master and module switch for network blocking. Enables/disables static rulesets
 * (EasyList ads, EasyPrivacy trackers, annoyances) according to module settings.
 * Installs a top-priority session allow rule while master protection is off.
 */
async function syncNetworkBlocking(enabled: boolean, settings?: Settings): Promise<void> {
  return dnrMutex.run(async () => {
    try {
      if (enabled) {
        const enableIds: string[] = ['main'];
        const disableIds: string[] = [];

        const adsOn = settings ? settings.modules.ads : true;
        const trackersOn = settings ? settings.modules.trackers : true;
        const annoyancesOn = settings ? settings.modules.annoyances : true;

        if (adsOn) enableIds.push('ads');
        else disableIds.push('ads');

        if (trackersOn) enableIds.push('trackers');
        else disableIds.push('trackers');

        if (annoyancesOn) enableIds.push('annoyances');
        else disableIds.push('annoyances');

        if (adsOn || trackersOn) enableIds.push('ads-trackers');
        else disableIds.push('ads-trackers');

        if (enableIds.length > 0) {
          await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: enableIds });
        }
        if (disableIds.length > 0) {
          await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: disableIds });
        }
      } else {
        await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [...STATIC_RULESET_IDS] });
      }
    } catch (error) {
      log.warn('ruleset switch failed', error instanceof Error ? error.message : String(error));
    }
    try {
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

// ---------------------------------------------------------------------------
// Offscreen gateway (singleton, request ids, timeouts)
// ---------------------------------------------------------------------------

let offscreenEnsure: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  if (offscreenEnsure === null) {
    offscreenEnsure = (async () => {
      const has = await chrome.offscreen.hasDocument().catch(() => false);
      if (!has) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['BLOBS', 'DOM_PARSER'],
          justification: 'AUVYQ key derivation (PBKDF2) and defensive DOM parsing for encrypted backups.'
        });
      }
      offscreenLastUse = Date.now();
    })().catch((error) => {
      offscreenEnsure = null;
      throw error;
    });
  }
  await offscreenEnsure;
}

async function callOffscreen<T>(op: string, payload: unknown, timeoutMs = 30000): Promise<T> {
  const opKey = `${op}:${JSON.stringify(payload).slice(0, 64)}`;
  const existing = offscreenInFlight.get(opKey);
  if (existing !== undefined) return existing as Promise<T>;

  const run = (async () => {
    await ensureOffscreen();
    offscreenLastUse = Date.now();
    const requestId = `off-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await Promise.race([
      chrome.runtime.sendMessage({ requestId, op, payload }) as Promise<{ requestId: string; success: boolean; data?: unknown; error?: string }>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('offscreen timeout')), timeoutMs))
    ]);
    if (response.success !== true) throw new Error(response.error ?? 'offscreen op failed');
    return response.data as T;
  })();

  offscreenInFlight.set(opKey, run);
  try {
    return await run;
  } finally {
    offscreenInFlight.delete(opKey);
  }
}

async function teardownOffscreenIfIdle(): Promise<void> {
  if (offscreenInFlight.size > 0) return;
  if (Date.now() - offscreenLastUse < OFFSCREEN_IDLE_MS) return;
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
    offscreenEnsure = null;
  }
}

// ---------------------------------------------------------------------------
// Threat assessment + warning banner flow
// ---------------------------------------------------------------------------

async function getTabThreat(tabId: number): Promise<TabThreatState | null> {
  const result = await chrome.storage.session.get(`${STORAGE_KEYS.tabThreats}:${tabId}`);
  const raw = result[`${STORAGE_KEYS.tabThreats}:${tabId}`];
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = validateTabState(parsed);
    return validated;
  } catch {
    return null;
  }
}

function validateTabState(value: unknown): TabThreatState | null {
  if (!isRecord(value)) return null;
  const risk = validateRiskResult(value['risk']);
  if (!risk.ok || typeof value['host'] !== 'string') return null;
  const stage = value['stage'];
  if (stage !== 'none' && stage !== 'warned' && stage !== 'confirmed' && stage !== 'acknowledged') return null;
  return { host: value['host'], risk: risk.value, stage };
}

async function setTabThreat(tabId: number, state: TabThreatState | null): Promise<void> {
  const key = `${STORAGE_KEYS.tabThreats}:${tabId}`;
  if (state === null) {
    await chrome.storage.session.remove(key);
    return;
  }
  await chrome.storage.session.set({ [key]: JSON.stringify(state) });
}

async function logThreat(host: string, risk: RiskResult, action: ThreatLogEntry['action']): Promise<void> {
  const entry: ThreatLogEntry = {
    time: Date.now(),
    severity: risk.severity,
    host: displayHost(host),
    reason: risk.reasons[0] ?? 'Suspicious activity',
    action
  };
  const result = await chrome.storage.local.get(STORAGE_KEYS.threatLog);
  const existing = Array.isArray(result[STORAGE_KEYS.threatLog]) ? result[STORAGE_KEYS.threatLog] as unknown[] : [];
  const next = [entry, ...existing].slice(0, LIMITS.threatLogEntries);
  await chrome.storage.local.set({ [STORAGE_KEYS.threatLog]: next });
  await stats.recordEvents([{ category: 'threats', count: 1 }]).catch(() => undefined);
}

async function assessNavigation(tabId: number, url: string): Promise<void> {
  const settings = await ensureInitialized();
  if (!settings.masterEnabled || !settings.modules.heuristics) return;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  const host = normalizeHostname(parsed.hostname);
  if (host.length === 0 || matchSuffix(host, 'localhost')) return;

  const risk = classify(url, { hostname: host, url });
  const previous = await getTabThreat(tabId);
  if (risk.severity === 'medium' || risk.severity === 'high' || risk.severity === 'malicious') {
    await setTabThreat(tabId, { host, risk, stage: previous?.stage ?? 'none' });
    await logThreat(host, risk, 'warned').catch(() => undefined);
    await chrome.tabs.sendMessage(tabId, { v: 1, type: 'AUVYQ_SHOW_THREAT', risk, host }).catch(() => undefined);
    void updateBadge(settings, risk);
  } else if (previous !== null) {
    await setTabThreat(tabId, null);
    void updateBadge(settings);
  }
}

// ---------------------------------------------------------------------------
// Backup (KDF runs in the offscreen document)
// ---------------------------------------------------------------------------

async function buildBackupPayload(): Promise<string> {
  const keys = [STORAGE_KEYS.settings, STORAGE_KEYS.snapshots, STORAGE_KEYS.threatLog];
  const data = await chrome.storage.local.get(keys);
  return JSON.stringify(data);
}

async function restoreBackupPayload(value: unknown): Promise<{ restored: string[] }> {
  if (!isRecord(value)) throw new Error('backup payload is not an object');
  const restored: string[] = [];
  const settingsRaw = value[STORAGE_KEYS.settings];
  if (settingsRaw !== undefined) {
    const validated = validateSettings(settingsRaw);
    if (!validated.ok) throw new Error('backup settings failed validation');
    await saveSettings(validated.value);
    restored.push(STORAGE_KEYS.settings);
  }
  if (value[STORAGE_KEYS.snapshots] !== undefined && isRecord(value[STORAGE_KEYS.snapshots])) {
    await chrome.storage.local.set({ [STORAGE_KEYS.snapshots]: value[STORAGE_KEYS.snapshots] });
    restored.push(STORAGE_KEYS.snapshots);
  }
  if (value[STORAGE_KEYS.threatLog] !== undefined && Array.isArray(value[STORAGE_KEYS.threatLog])) {
    await chrome.storage.local.set({ [STORAGE_KEYS.threatLog]: value[STORAGE_KEYS.threatLog] });
    restored.push(STORAGE_KEYS.threatLog);
  }
  return { restored };
}

// ---------------------------------------------------------------------------
// RPC handlers
// ---------------------------------------------------------------------------

function senderTabHost(sender: chrome.runtime.MessageSender): string {
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

const handlers: Record<string, RpcHandler> = {
  GET_SNAPSHOT: async () => {
    const settings = await ensureInitialized();
    const snapshot = await stats.getToday();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    let host = '';
    if (tab?.url !== undefined) {
      try {
        host = normalizeHostname(new URL(tab.url).hostname);
      } catch {
        host = '';
      }
    }
    return {
      snapshot,
      privacyScore: computePrivacyScore(snapshot),
      masterEnabled: settings.masterEnabled,
      sitePaused: host.length > 0 ? isSitePaused(settings, host) : false,
      host
    };
  },

  GET_STATS_HISTORY: async () => {
    const settings = await ensureInitialized();
    return stats.getHistory(settings.logRetentionDays);
  },

  GET_SETTINGS: async () => ensureInitialized(),

  SET_SETTINGS: async (payload) => {
    if (!isRecord(payload)) throw new Error('bad payload');
    const current = await ensureInitialized();
    if (payload['preset'] !== undefined) {
      const preset = payload['preset'];
      if (typeof preset !== 'string' || PRESETS[preset as PresetName] === undefined) {
        throw new Error('unknown preset');
      }
      const next = applyPreset(current, preset as PresetName);
      await saveSettings(next);
      void syncNetworkBlocking(next.masterEnabled, next);
      void updateBadge(next);
      return next;
    }
    const next = applyPatch(current, payload as Partial<Settings>);
    await saveSettings(next);
    configureLogging(next.developerMode ? 'debug' : 'warn', next.developerMode);
    if (next.masterEnabled !== current.masterEnabled ||
        next.modules.ads !== current.modules.ads ||
        next.modules.trackers !== current.modules.trackers ||
        next.modules.annoyances !== current.modules.annoyances) {
      void syncNetworkBlocking(next.masterEnabled, next);
    }
    void updateBadge(next);
    return next;
  },

  GET_SITE_REPORT: async (payload, sender) => {
    const settings = await ensureInitialized();
    const requested = isRecord(payload) && typeof payload['host'] === 'string' ? payload['host'] : '';
    const host = normalizeHostname(requested.length > 0 ? requested : senderTabHost(sender));
    if (host.length === 0) throw new Error('no host available');
    const counters = await stats.getSiteCounters(host, settings.logRetentionDays);
    const risk = classify(`https://${host}/`, { hostname: host, url: `https://${host}/` });
    return {
      host,
      paused: isSitePaused(settings, host),
      adsBlocked: counters.ads,
      trackersBlocked: counters.trackers,
      paramsStripped: counters.params,
      cosmeticHidden: counters.cosmetic,
      threats: counters.threats,
      risk
    };
  },

  SET_SITE_PAUSED: async (payload) => {
    if (!isRecord(payload) || typeof payload['host'] !== 'string' || typeof payload['paused'] !== 'boolean') {
      throw new Error('bad payload');
    }
    const host = validateHostnameInput(payload['host']);
    if (!host.ok) throw new Error(host.error);
    const current = await ensureInitialized();
    let next = setSitePaused(current, host.value, payload['paused']);
    if (payload['allow'] === true && payload['paused'] === true) {
      const existing = next.perSite[host.value] ?? { paused: true, allowlist: [] };
      if (!existing.allowlist.includes(host.value)) {
        next = {
          ...next,
          perSite: { ...next.perSite, [host.value]: { ...existing, allowlist: [...existing.allowlist, host.value].slice(0, 32) } }
        };
      }
    }
    await saveSettings(next);
    const applied = await setSitePause(host.value, payload['paused']);
    if (!applied) throw new Error('DNR session rule failed; settings updated');
    void updateBadge(next);
    return { host: host.value, paused: payload['paused'] };
  },

  GET_DISPATCH: async (payload) => {
    if (!isRecord(payload)) throw new Error('bad payload');
    const host = validateHostnameInput(payload['host']);
    if (!host.ok) throw new Error(host.error);
    const settings = await ensureInitialized();
    if (!settings.masterEnabled || !settings.modules.ads) return { entries: [] };

    const result = await chrome.storage.local.get(STORAGE_KEYS.pack);
    const pack = result[STORAGE_KEYS.pack];

    const staticMap = (staticScriptletDispatch && typeof staticScriptletDispatch === 'object')
      ? (staticScriptletDispatch as Record<string, unknown>)
      : {};
    const dynamicMap = (isRecord(pack) && isRecord(pack['scriptletDispatch']))
      ? (pack['scriptletDispatch'] as Record<string, unknown>)
      : {};

    // Support: exact hostname, subdomain/suffix matching, and generic scriptlets `(generic)`
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
    return { entries: entries.slice(0, LIMITS.dispatchEntriesPerHost) };
  },

  GET_COSMETIC: async (payload) => {
    if (!isRecord(payload)) throw new Error('bad payload');
    const host = validateHostnameInput(payload['host']);
    if (!host.ok) throw new Error(host.error);
    const settings = await ensureInitialized();
    // With protection (or the ads module) off, the injector must also remove its
    // built-in fallback selectors, hence the explicit enabled flag.
    if (!settings.masterEnabled || !settings.modules.ads) {
      return { css: '', selectors: [], enabled: false };
    }
    const result = await chrome.storage.local.get(STORAGE_KEYS.pack);
    const pack = result[STORAGE_KEYS.pack];
    const cosmetic = isRecord(pack) && isRecord(pack['cosmetic'])
      ? (pack['cosmetic'] as { genericCss?: unknown; perDomain?: unknown })
      : undefined;

    const cssParts: string[] = [];
    if (cosmetic && typeof cosmetic.genericCss === 'string' && cosmetic.genericCss.length > 0) {
      cssParts.push(cosmetic.genericCss);
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

    let css = cssParts.join('\n');
    if (css.length > 1024 * 1024) css = css.slice(0, 1024 * 1024);
    const selectors = css.split('\n')
      .map((line) => line.slice(0, line.indexOf('{')).trim())
      .filter((selector) => selector.length > 0)
      .slice(0, 500);
    return { css, selectors, enabled: true };
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

  GET_FP_SHIELDS: async () => {
    const settings = await ensureInitialized();
    if (!settings.modules.fingerprintShields || !settings.masterEnabled) {
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
    return restoreBackupPayload(result.value);
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
    if (!isRecord(payload) || payload['done'] !== true) throw new Error('bad payload');
    await chrome.storage.local.set({ [STORAGE_KEYS.onboardingDone]: true });
    return { done: true };
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
    const all = await chrome.cookies.getAll({});
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
        try {
          await chrome.cookies.remove({ url: `https://${domain}${path}`, name: entry['name'], storeId });
        } catch {
          await chrome.cookies.remove({ url: `http://${domain}${path}`, name: entry['name'], storeId }).catch(() => undefined);
        }
        removed += 1;
      } catch {
        // non-fatal
      }
    }
    await stats.recordEvents([{ category: 'cookies', count: removed }]).catch(() => undefined);
    return { removed };
  },

  CLEAR_AUVYQ_DATA: async () => {
    // Removes ONLY AUVYQ-owned data; never touches unrelated browser data.
    await chrome.storage.local.remove([
      STORAGE_KEYS.settings, STORAGE_KEYS.snapshots, STORAGE_KEYS.siteStats, STORAGE_KEYS.threatLog,
      STORAGE_KEYS.pack, STORAGE_KEYS.packRuleIds, STORAGE_KEYS.telemetryQueue,
      STORAGE_KEYS.onboardingDone, STORAGE_KEYS.updateState, STORAGE_KEYS.tabThreats
    ]);
    await chrome.storage.session.clear().catch(() => undefined);
    const settings = defaultSettings();
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    await applyPackDiff([]);
    // Clearing resets to defaults: the default pack is part of the default state.
    defaultPackChecked = false;
    void activateDefaultPackIfNeeded();
    await ensureAlarms();
    void updateBadge(settings);
    return { cleared: true };
  },

  GET_DIAGNOSTICS: async () => {
    const settings = await ensureInitialized();
    const packResult = await chrome.storage.local.get(STORAGE_KEYS.pack);
    const pack = packResult[STORAGE_KEYS.pack];
    const alarms = await chrome.alarms.getAll();
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

  CHECK_LOGIN_FORMS: async (payload) => {
    if (!isRecord(payload) || typeof payload['pageOrigin'] !== 'string' || !Array.isArray(payload['forms'])) {
      throw new Error('bad payload');
    }
    const settings = await ensureInitialized();
    if (!settings.masterEnabled || !settings.modules.heuristics) {
      return { risk: { score: 0, severity: 'none', reasons: [], confidence: 0.5 } };
    }
    const forms = (payload['forms'] as unknown[]).slice(0, 20).map((form) => {
      if (!isRecord(form)) return { actionOrigin: '', hasPasswordField: false };
      return {
        actionOrigin: typeof form['actionOrigin'] === 'string' ? form['actionOrigin'] : '',
        hasPasswordField: form['hasPasswordField'] === true
      };
    });
    const risk = assessThreat({
      hostname: hostOfUrl(payload['pageOrigin']),
      url: payload['pageOrigin'],
      pageOrigin: payload['pageOrigin'],
      loginForms: forms
    });
    if (risk.severity === 'high' || risk.severity === 'malicious') {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const host = hostOfUrl(payload['pageOrigin']);
      if (tabs[0]?.id !== undefined) {
        const previous = await getTabThreat(tabs[0].id);
        await setTabThreat(tabs[0].id, { host, risk, stage: previous?.stage ?? 'none' });
      }
      await logThreat(host, risk, 'warned').catch(() => undefined);
      void updateBadge(settings, risk);
    }
    return { risk };
  },

  THREAT_ACTION: async (payload) => {
    if (!isRecord(payload)) throw new Error('bad payload');
    let tabId = typeof payload['tabId'] === 'number' ? payload['tabId'] : undefined;
    if (tabId === undefined) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id === undefined) throw new Error('no tab available');
      tabId = tabs[0].id;
    }
    const action = payload['action'];
    if (typeof action !== 'string' || !['leave', 'block', 'continue'].includes(action)) {
      throw new Error('bad action');
    }
    const state = await getTabThreat(tabId);
    if (state !== null) {
      if (action === 'block') {
        const applied = await setSitePause(state.host, true);
        if (!applied) throw new Error('block rule failed');
        await logThreat(state.host, state.risk, 'blocked');
      } else if (action === 'continue') {
        const nextStage = state.risk.severity === 'malicious' ? 'confirmed' : (state.stage === 'none' ? 'warned' : 'confirmed');
        await setTabThreat(tabId, { ...state, stage: nextStage });
        if (nextStage === 'confirmed') {
          await logThreat(state.host, state.risk, 'continued');
        }
      } else {
        await logThreat(state.host, state.risk, 'left');
        await setTabThreat(tabId, null);
      }
    }
    return { ok: true };
  },

  GET_TAB_STATE: async (payload) => {
    if (!isRecord(payload) || typeof payload['tabId'] !== 'number') throw new Error('bad payload');
    const state = await getTabThreat(payload['tabId']);
    return { state };
  }
};

function classifyCookieCategory(domain: string, name?: string): string {
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
    /^(_ga|_gid|_gat|_clck|_clsk|_pk_.*|mp_.*|ajs_.*|__utma|__utmb|__utmc|__utmz)$/i.test(cookieName)
  ) {
    return 'analytics';
  }

  return 'unknown';
}

async function getUpdateState(): Promise<UpdateState> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.updateState);
  const raw = result[STORAGE_KEYS.updateState];
  if (isRecord(raw) && typeof raw['endpoint'] === 'string') return raw as unknown as UpdateState;
  return defaultUpdateState('');
}

// ---------------------------------------------------------------------------
// Top-level event listeners (registered synchronously, never conditionally)
// ---------------------------------------------------------------------------

const router = createRpcRouter(handlers);
registerRpcListener(router);

chrome.runtime.onInstalled.addListener((details) => {
  void handleInstalled(details);
});

chrome.runtime.onStartup.addListener(() => {
  void handleStartup();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  observer.noteTabRemoved(tabId);
  void (async () => {
    const settings = await ensureInitialized();
    const hosts = observer.getTabTrackerHosts(tabId);
    await cleanupForTab(settings, tabId, hosts).catch(() => undefined);
    await setTabThreat(tabId, null).catch(() => undefined);
  })();
});

if (chrome.cookies?.onChanged !== undefined) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    void (async () => {
      const settings = await ensureInitialized();
      const outcome = await handleCookieChanged(changeInfo, settings);
      if (outcome.removed) {
        await stats.recordEvents([{ category: 'cookies', count: 1 }]).catch(() => undefined);
      }
    })();
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    switch (alarm.name) {
      case ALARMS.statsFlush:
        await observer.flush().catch(() => undefined);
        await stats.flush().catch(() => undefined);
        break;
      case ALARMS.retention: {
        const settings = await ensureInitialized();
        await stats.prune(settings.logRetentionDays).catch(() => undefined);
        break;
      }
      case ALARMS.offscreenIdle:
        await teardownOffscreenIfIdle();
        break;
      case COOKIE_SWEEP_ALARM: {
        const settings = await ensureInitialized();
        const result = await sweepTrackerCookies(settings).catch(() => ({ removed: 0, skipped: 'error' }));
        if (result.removed > 0) {
          await stats.recordEvents([{ category: 'cookies', count: result.removed }]).catch(() => undefined);
        }
        break;
      }
      case ALARMS.updateCheck: {
        const state = await getUpdateState();
        if (state.endpoint.length > 0) {
          void handlers.CHECK_UPDATES(undefined, {}).catch(() => undefined);
        }
        break;
      }
      default:
        break;
    }
  })();
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void assessNavigation(details.tabId, details.url).catch(() => undefined);
});

// Observation-only webRequest listener lives in the observer module (registered at import).
// declarativeNetRequestFeedback listener likewise registers itself at import time.

log.info('service worker loaded');
void ensureInitialized();

// Re-export for tests / future model integration.
export { emptySnapshot, todayKey, snapshotForDay };
function snapshotForDay(day: string): Snapshot {
  return emptySnapshot(day);
}
