/*
 * AUVYQ tab threat & navigation security manager.
 * Tracks per-tab risk evaluations in session storage and logs verified threats.
 */
import { STORAGE_KEYS } from '../../core/storage/schema.js';
import { validateRiskResult, isRecord, LIMITS } from '../../core/validation/schemas.js';
import { normalizeHostname, displayHost, matchSuffix } from '../../core/domain/normalize.js';
import { hostOfUrl } from '../../core/logging/logger.js';
import { classifyWithModel } from '../../core/ml/classify.js';
import { assessThreat } from '../../core/heuristic/tier1.js';
import { setSiteBlock } from '../dnr-adapter/adapter.js';
import { isSitePaused, isSiteAllowlisted } from '../../core/storage/settings.js';
import type { Settings, RiskResult, ThreatLogEntry, TabThreatState } from '../../types/schemas.js';

export function validateTabState(value: unknown): TabThreatState | null {
  if (!isRecord(value)) return null;
  const risk = validateRiskResult(value['risk']);
  if (!risk.ok || typeof value['host'] !== 'string') return null;
  const stage = value['stage'];
  if (stage !== 'none' && stage !== 'warned' && stage !== 'confirmed' && stage !== 'acknowledged') return null;
  return { host: value['host'], risk: risk.value, stage };
}

export async function getTabThreat(tabId: number): Promise<TabThreatState | null> {
  const result = await chrome.storage.session?.get?.(`${STORAGE_KEYS.tabThreats}:${tabId}`) ?? {};
  const raw = result[`${STORAGE_KEYS.tabThreats}:${tabId}`];
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return validateTabState(parsed);
  } catch {
    return null;
  }
}

export async function setTabThreat(tabId: number, state: TabThreatState | null): Promise<void> {
  const key = `${STORAGE_KEYS.tabThreats}:${tabId}`;
  if (state === null) {
    await chrome.storage.session?.remove?.(key).catch?.(() => undefined);
    return;
  }
  await chrome.storage.session?.set?.({ [key]: JSON.stringify(state) }).catch?.(() => undefined);
}

export async function logThreat(
  host: string,
  risk: RiskResult,
  action: ThreatLogEntry['action'],
  recordStats?: (events: { category: 'threats'; count: number }[]) => Promise<unknown>
): Promise<void> {
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
  if (recordStats) {
    await recordStats([{ category: 'threats', count: 1 }]).catch(() => undefined);
  }
}

export async function assessNavigation(
  tabId: number,
  url: string,
  settings: Settings,
  recordStats?: (events: { category: 'threats'; count: number }[]) => Promise<unknown>,
  updateBadgeFn?: (settings: Settings, threat?: RiskResult) => void
): Promise<void> {
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
  if (isSitePaused(settings, host) || isSiteAllowlisted(settings, host)) return;

  const previous = await getTabThreat(tabId);
  if (previous && previous.host === host && (previous.stage === 'confirmed' || previous.stage === 'acknowledged')) {
    return;
  }

  const risk = await classifyWithModel(url, { hostname: host, url });
  const threatThreshold = (settings.preset === 'strong' || settings.preset === 'maximum') ? 30 : 40;
  const isThreat = (risk.score >= threatThreshold) || risk.severity === 'high' || risk.severity === 'malicious';

  if (isThreat) {
    const effectiveRisk = (risk.score >= threatThreshold && (risk.severity === 'none' || risk.severity === 'low'))
      ? { ...risk, severity: 'medium' as const }
      : risk;
    await setTabThreat(tabId, { host, risk: effectiveRisk, stage: previous?.stage ?? 'none' });
    await logThreat(host, effectiveRisk, 'warned', recordStats).catch(() => undefined);
    await chrome.tabs.sendMessage(tabId, { v: 1, type: 'AUVYQ_SHOW_THREAT', risk: effectiveRisk, host }).catch(() => undefined);
    if (updateBadgeFn) updateBadgeFn(settings, effectiveRisk);
  } else if (previous !== null) {
    await setTabThreat(tabId, null);
    if (updateBadgeFn) updateBadgeFn(settings);
  }
}

export async function handleThreatAction(
  tabId: number,
  action: string,
  recordStats?: (events: { category: 'threats'; count: number }[]) => Promise<unknown>,
  allowlistFn?: (host: string) => Promise<unknown>
): Promise<{ ok: boolean; reported?: boolean; allowlisted?: boolean }> {
  const state = await getTabThreat(tabId);
  if (state !== null) {
    if (action === 'block') {
      const applied = await setSiteBlock(state.host, true);
      if (!applied) throw new Error('block rule failed');
      await logThreat(state.host, state.risk, 'blocked', recordStats);
      await setTabThreat(tabId, null);
      await chrome.tabs.update(tabId, { url: 'about:blank' }).catch(() => undefined);
    } else if (action === 'continue') {
      const nextStage = state.risk.severity === 'malicious' ? 'confirmed' : (state.stage === 'none' ? 'warned' : 'confirmed');
      await setTabThreat(tabId, { ...state, stage: nextStage });
      if (nextStage === 'confirmed') {
        await logThreat(state.host, state.risk, 'continued', recordStats);
      }
    } else if (action === 'allowlist') {
      if (allowlistFn) {
        await allowlistFn(state.host).catch(() => undefined);
      }
      await logThreat(state.host, state.risk, 'allowlisted', recordStats);
      await setTabThreat(tabId, { ...state, stage: 'acknowledged' });
      return { ok: true, allowlisted: true };
    } else if (action === 'report_false_positive') {
      await logThreat(state.host, state.risk, 'reported', recordStats);
      await setTabThreat(tabId, { ...state, stage: 'acknowledged' });
      return { ok: true, reported: true };
    } else {
      await logThreat(state.host, state.risk, 'left', recordStats);
      await setTabThreat(tabId, null);
    }
  }
  return { ok: true };
}

export async function checkLoginForms(
  pageOrigin: string,
  forms: unknown[],
  tabId: number | undefined,
  settings: Settings,
  recordStats?: (events: { category: 'threats'; count: number }[]) => Promise<unknown>,
  updateBadgeFn?: (settings: Settings, threat?: RiskResult) => void
): Promise<{ risk: RiskResult }> {
  if (tabId === undefined) {
    return { risk: { score: 0, severity: 'none', reasons: [], confidence: 0 } };
  }
  if (!settings.masterEnabled || !settings.modules.heuristics) {
    return { risk: { score: 0, severity: 'none', reasons: [], confidence: 0.5 } };
  }
  const pageHost = hostOfUrl(pageOrigin);
  if (isSitePaused(settings, pageHost) || isSiteAllowlisted(settings, pageHost)) {
    return { risk: { score: 0, severity: 'none', reasons: [], confidence: 0.5 } };
  }
  const parsedForms = forms.slice(0, 20).map((form) => {
    if (!isRecord(form)) return { actionOrigin: '', hasPasswordField: false };
    return {
      actionOrigin: typeof form['actionOrigin'] === 'string' ? form['actionOrigin'] : '',
      hasPasswordField: form['hasPasswordField'] === true
    };
  });
  const risk = assessThreat({
    hostname: hostOfUrl(pageOrigin),
    url: pageOrigin,
    pageOrigin,
    loginForms: parsedForms
  });
  if (risk.severity === 'high' || risk.severity === 'malicious') {
    const host = hostOfUrl(pageOrigin);
    const previous = await getTabThreat(tabId);
    await setTabThreat(tabId, { host, risk, stage: previous?.stage ?? 'none' });
    await chrome.tabs.sendMessage(tabId, { v: 1, type: 'AUVYQ_SHOW_THREAT', risk, host }).catch(() => undefined);
    await logThreat(host, risk, 'warned', recordStats).catch(() => undefined);
    if (updateBadgeFn) updateBadgeFn(settings, risk);
  }
  return { risk };
}
