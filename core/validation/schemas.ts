/*
 * Runtime validation at every trust boundary. JSON.parse output is NEVER trusted.
 * Every validator returns a discriminated result: { ok: true, value } | { ok: false, error }.
 */
import type {
  CompiledPack, FilterIR, Settings, Snapshot, RiskResult, ThreatLogEntry,
  UpdateMetadata, TabThreatState, PresetName, RiskSeverity
} from '../../types/schemas.js';
import type { RpcEnvelope } from '../../types/messages.js';

export type Valid<T> = { ok: true; value: T } | { ok: false; error: string };

export function ok<T>(value: T): Valid<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: string): Valid<T> {
  return { ok: false, error };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown, maxItems: number, maxItemLen: number): value is string[] {
  return Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((v) => typeof v === 'string' && v.length <= maxItemLen);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function safeInt(value: unknown, min: number, max: number): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) return value;
  return null;
}

const PRESETS: readonly PresetName[] = ['basic', 'balanced', 'strong', 'maximum', 'expert'];
const SEVERITIES: readonly RiskSeverity[] = ['none', 'low', 'medium', 'high', 'malicious'];

export const LIMITS = {
  rpcPayloadChars: 8 * 1024 * 1024,
  filterListBytes: 8 * 1024 * 1024,
  filterLineChars: 4096,
  selectorChars: 1024,
  scriptletArgChars: 256,
  scriptletArgs: 8,
  backupBytes: 8 * 1024 * 1024,
  threatLogEntries: 500,
  historyDays: 30,
  dispatchEntriesPerHost: 32
} as const;

export function validateSettings(value: unknown): Valid<Settings> {
  if (!isRecord(value)) return fail('settings: not an object');
  const preset = value['preset'];
  if (typeof preset !== 'string' || !PRESETS.includes(preset as PresetName)) return fail('settings: bad preset');
  const modules = value['modules'];
  if (!isRecord(modules)) return fail('settings: bad modules');
  for (const key of ['ads', 'trackers', 'cookies', 'heuristics', 'fingerprintShields']) {
    if (typeof modules[key] !== 'boolean') return fail(`settings: module ${key} not boolean`);
  }
  const perSite = value['perSite'];
  if (!isRecord(perSite)) return fail('settings: bad perSite');
  for (const [host, entry] of Object.entries(perSite)) {
    if (host.length > 253) return fail('settings: perSite host too long');
    if (!isRecord(entry) || typeof entry['paused'] !== 'boolean' || !isStringArray(entry['allowlist'], 32, 253)) {
      return fail('settings: bad perSite entry');
    }
  }
  const fpShields = value['fpShields'];
  if (!isRecord(fpShields)) return fail('settings: bad fpShields');
  for (const v of Object.values(fpShields)) {
    if (typeof v !== 'boolean') return fail('settings: fpShields value not boolean');
  }
  const retention = value['logRetentionDays'];
  if (retention !== 7 && retention !== 30) return fail('settings: bad logRetentionDays');
  const theme = value['theme'];
  if (theme !== 'system' && theme !== 'dark' && theme !== 'light') return fail('settings: bad theme');
  for (const key of ['masterEnabled', 'telemetryOptIn', 'developerMode']) {
    if (typeof value[key] !== 'boolean') return fail(`settings: ${key} not boolean`);
  }
  const schemaVersion = safeInt(value['schemaVersion'], 1, 99);
  if (schemaVersion === null) return fail('settings: bad schemaVersion');
  return ok(value as unknown as Settings);
}

export function validateSnapshot(value: unknown): Valid<Snapshot> {
  if (!isRecord(value)) return fail('snapshot: not an object');
  if (typeof value['day'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value['day'])) return fail('snapshot: bad day');
  const numericKeys = ['adsBlocked', 'trackersBlocked', 'paramsStripped', 'cosmeticHidden', 'threats', 'cookiesCleaned'] as const;
  for (const key of numericKeys) {
    const n = value[key];
    if (!isFiniteNumber(n) || n < 0 || !Number.isSafeInteger(n)) return fail(`snapshot: bad ${key}`);
  }
  if (!isFiniteNumber(value['updatedAt'])) return fail('snapshot: bad updatedAt');
  return ok(value as unknown as Snapshot);
}

export function validateRiskResult(value: unknown): Valid<RiskResult> {
  if (!isRecord(value)) return fail('risk: not an object');
  const score = value['score'];
  if (!isFiniteNumber(score) || score < 0 || score > 100) return fail('risk: bad score');
  if (typeof value['severity'] !== 'string' || !SEVERITIES.includes(value['severity'] as RiskSeverity)) {
    return fail('risk: bad severity');
  }
  if (!isStringArray(value['reasons'], 16, 200)) return fail('risk: bad reasons');
  const confidence = value['confidence'];
  if (!isFiniteNumber(confidence) || confidence < 0 || confidence > 1) return fail('risk: bad confidence');
  return ok(value as unknown as RiskResult);
}

export function validateThreatLogEntry(value: unknown): Valid<ThreatLogEntry> {
  if (!isRecord(value)) return fail('threat entry: not an object');
  if (!isFiniteNumber(value['time']) || (value['time'] as number) <= 0) return fail('threat entry: bad time');
  if (typeof value['severity'] !== 'string' || !SEVERITIES.includes(value['severity'] as RiskSeverity)) {
    return fail('threat entry: bad severity');
  }
  if (typeof value['host'] !== 'string' || value['host'].length > 253) return fail('threat entry: bad host');
  if (typeof value['reason'] !== 'string' || value['reason'].length > 200) return fail('threat entry: bad reason');
  if (!['warned', 'left', 'blocked', 'continued'].includes(value['action'] as string)) {
    return fail('threat entry: bad action');
  }
  return ok(value as unknown as ThreatLogEntry);
}

export function validateFilterIR(value: unknown): Valid<FilterIR> {
  if (!isRecord(value)) return fail('ir: not an object');
  const kind = value['kind'];
  if (kind !== 'network' && kind !== 'cosmetic' && kind !== 'scriptlet' && kind !== 'redirect' && kind !== 'removeparam') {
    return fail('ir: bad kind');
  }
  const source = value['source'];
  if (!isRecord(source) || typeof source['listId'] !== 'string' || source['listId'].length > 64 ||
      !isFiniteNumber(source['line'])) return fail('ir: bad source');
  if (kind === 'cosmetic') {
    const cosmetic = value['cosmetic'];
    if (!isRecord(cosmetic) || typeof cosmetic['selector'] !== 'string' ||
        cosmetic['selector'].length > LIMITS.selectorChars || !isStringArray(cosmetic['domains'], 64, 253) ||
        typeof cosmetic['isGeneric'] !== 'boolean') return fail('ir: bad cosmetic');
  }
  if (kind === 'scriptlet') {
    const scriptlet = value['scriptlet'];
    if (!isRecord(scriptlet) || typeof scriptlet['name'] !== 'string' || scriptlet['name'].length > 64) {
      return fail('ir: bad scriptlet');
    }
    const args = scriptlet['args'];
    if (!Array.isArray(args) || args.length > LIMITS.scriptletArgs ||
        !args.every((a) => typeof a === 'string' || typeof a === 'number')) return fail('ir: bad scriptlet args');
  }
  if (kind === 'network' || kind === 'redirect' || kind === 'removeparam') {
    const network = value['network'];
    if (!isRecord(network)) return fail('ir: bad network');
    const match = network['match'];
    if (!isRecord(match) || !Array.isArray(match['resourceTypes'])) return fail('ir: bad network match');
    const pattern = network['pattern'];
    if (!isRecord(pattern) || typeof pattern['isRegexValidRE2'] !== 'boolean') return fail('ir: bad network pattern');
    const action = network['action'];
    if (action !== 'block' && action !== 'allow' && action !== 'redirect' && action !== 'modifyQuery') {
      return fail('ir: bad network action');
    }
  }
  return ok(value as unknown as FilterIR);
}

export function validateCompiledPack(value: unknown): Valid<CompiledPack> {
  if (!isRecord(value)) return fail('pack: not an object');
  if (!isFiniteNumber(value['version'])) return fail('pack: bad version');
  const dnr = value['dnrRules'];
  if (!isRecord(dnr)) return fail('pack: bad dnrRules');
  for (const key of ['hotfix', 'trackers', 'ads']) {
    if (!Array.isArray(dnr[key])) return fail(`pack: dnrRules.${key} not array`);
  }
  const cosmetic = value['cosmetic'];
  if (!isRecord(cosmetic) || typeof cosmetic['genericCss'] !== 'string' ||
      cosmetic['genericCss'].length > 2 * 1024 * 1024) return fail('pack: bad cosmetic');
  if (!isRecord(cosmetic['perDomain'])) return fail('pack: bad cosmetic perDomain');
  const dispatch = value['scriptletDispatch'];
  if (!isRecord(dispatch)) return fail('pack: bad scriptletDispatch');
  for (const [host, entries] of Object.entries(dispatch)) {
    if (host.length > 253 || !Array.isArray(entries) || entries.length > LIMITS.dispatchEntriesPerHost) {
      return fail('pack: bad scriptletDispatch host');
    }
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry['name'] !== 'string' || !Array.isArray(entry['args'])) {
        return fail('pack: bad scriptlet entry');
      }
    }
  }
  const stats = value['stats'];
  if (!isRecord(stats) || !isFiniteNumber(stats['rulesCompiled']) || !isFiniteNumber(stats['dropped']) ||
      !isFiniteNumber(stats['downgradedToCosmetic'])) return fail('pack: bad stats');
  return ok(value as unknown as CompiledPack);
}

export function validateUpdateMetadata(value: unknown): Valid<UpdateMetadata> {
  if (!isRecord(value)) return fail('update meta: not an object');
  if (typeof value['version'] !== 'string' || !/^\d+\.\d+\.\d+$/.test(value['version'])) {
    return fail('update meta: bad version');
  }
  if (typeof value['createdAt'] !== 'string') return fail('update meta: bad createdAt');
  const packages = value['packages'];
  if (!Array.isArray(packages) || packages.length === 0 || packages.length > 16) {
    return fail('update meta: bad packages');
  }
  for (const pkg of packages) {
    if (!isRecord(pkg)) return fail('update meta: bad package');
    if (typeof pkg['id'] !== 'string' || pkg['id'].length > 64) return fail('update meta: bad package id');
    if (typeof pkg['url'] !== 'string' || !/^https:\/\//.test(pkg['url'])) return fail('update meta: package url must be https');
    if (typeof pkg['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(pkg['sha256'])) return fail('update meta: bad sha256');
    if (typeof pkg['signature'] !== 'string' || pkg['signature'].length > 512 || pkg['signature'].length === 0) {
      return fail('update meta: bad signature');
    }
  }
  return ok(value as unknown as UpdateMetadata);
}

export function validateRpcEnvelope(value: unknown): Valid<RpcEnvelope> {
  if (!isRecord(value)) return fail('rpc: not an object');
  if (value['v'] !== 1) return fail('rpc: bad version');
  if (typeof value['type'] !== 'string' || value['type'].length === 0 || value['type'].length > 48) {
    return fail('rpc: bad type');
  }
  if (typeof value['requestId'] !== 'string' || value['requestId'].length === 0 || value['requestId'].length > 64) {
    return fail('rpc: bad requestId');
  }
  return ok(value as unknown as RpcEnvelope);
}

export function validateTabThreatState(value: unknown): Valid<TabThreatState> {
  if (!isRecord(value)) return fail('tab state: not an object');
  if (typeof value['host'] !== 'string' || value['host'].length > 253) return fail('tab state: bad host');
  const risk = validateRiskResult(value['risk']);
  if (!risk.ok) return fail(`tab state: ${risk.error}`);
  if (!['none', 'warned', 'confirmed', 'acknowledged'].includes(value['stage'] as string)) {
    return fail('tab state: bad stage');
  }
  return ok(value as unknown as TabThreatState);
}

export function validateHostnameInput(value: unknown): Valid<string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return fail('host: bad length');
  // Reject characters that can never appear in a punycode/ASCII hostname.
  if (!/^[a-zA-Z0-9.\-_:\[\]]+$/.test(value)) return fail('host: bad characters');
  return ok(value);
}
