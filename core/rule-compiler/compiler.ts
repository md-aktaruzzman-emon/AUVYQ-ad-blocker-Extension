/*
 * Rule compiler: validate -> deduplicate -> deterministic sort -> priorities -> DNR conversion.
 * Unsupported network rules are downgraded only when semantics permit; otherwise dropped.
 * Never throws: every failure is counted.
 */
import type { CompiledPack, FilterIR } from '../../types/schemas.js';
import { validateCompiledPack, LIMITS } from '../validation/schemas.js';
import { validateRe2 } from './re2-validate.js';
import { buildCosmeticCss } from '../cosmetic-engine/packs.js';
import { validateScriptlet } from '../scriptlet-engine/validate.js';
import { canonicalKey } from '../rule-parser/parser.js';

type DnrRule = chrome.declarativeNetRequest.Rule;
type ResourceType = chrome.declarativeNetRequest.ResourceType;

export type PackCategory = 'hotfix' | 'trackers' | 'ads';

export interface CompiledRule {
  key: string;
  category: PackCategory;
  rule: DnrRule;
  frequency: number;
  confidence: number;
  /** CSS selector block to fall back to when quota-demoted, or null. */
  cosmeticFallback: string | null;
}

export interface DetailedCompileResult {
  pack: CompiledPack;
  rules: CompiledRule[];
}

const CATEGORY_ORDER: Record<PackCategory, number> = { hotfix: 0, trackers: 1, ads: 2 };

/** Dynamic list rules live in the 1000-7999 range (user/hotfix ranges are managed by the adapter). */
export const DYNAMIC_PRIORITY_BASE = 1000;
export const DYNAMIC_PRIORITY_CAP = 7999;

const KNOWN_RESOURCE_TYPES = new Set<ResourceType>([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'
]);

export function compileRules(irs: FilterIR[]): CompiledPack {
  return compileRulesDetailed(irs).pack;
}

export function compileRulesDetailed(irs: FilterIR[]): DetailedCompileResult {
  const seen = new Set<string>();
  const dropped: string[] = [];
  const downgradedToCosmetic: string[] = [];

  // ---- Pass 1: validate + deduplicate ----
  const validIrs: FilterIR[] = [];
  for (const ir of irs) {
    if (validIrs.length >= 60000) {
      dropped.push('limit');
      continue;
    }
    const validation = validateIrShape(ir);
    if (!validation.ok) {
      dropped.push(validation.error);
      continue;
    }
    const key = canonicalKey(ir);
    if (seen.has(key)) {
      dropped.push('duplicate');
      continue;
    }
    seen.add(key);
    validIrs.push(ir);
  }

  // ---- Pass 2: deterministic sort ----
  validIrs.sort((a, b) => canonicalKey(a).localeCompare(canonicalKey(b)));

  // ---- Pass 3: convert ----
  const converted: { key: string; category: PackCategory; rule: DnrRule; demotableTo: string | null }[] = [];
  const cosmeticIrs: FilterIR[] = [];
  const scriptlets = new Map<string, { name: string; args: (string | number)[] }[]>();

  for (const ir of validIrs) {
    if (ir.kind === 'cosmetic' && ir.cosmetic) {
      cosmeticIrs.push(ir);
      continue;
    }
    if (ir.kind === 'scriptlet' && ir.scriptlet) {
      const check = validateScriptlet(ir.scriptlet.name, ir.scriptlet.args);
      if (!check.ok) {
        dropped.push(`scriptlet: ${check.error}`);
        continue;
      }
      const domains = domainScopeOf(ir);
      const targets = domains.length > 0 ? domains : ['(generic)'];
      for (const host of targets) {
        let list = scriptlets.get(host);
        if (list === undefined) {
          list = [];
          scriptlets.set(host, list);
        }
        if (list.length < LIMITS.dispatchEntriesPerHost) {
          list.push({ name: ir.scriptlet.name, args: ir.scriptlet.args });
        }
      }
      continue;
    }
    if (ir.network === undefined) {
      dropped.push('missing-network');
      continue;
    }
    const result = convertNetworkRule(ir);
    if (typeof result === 'string') {
      dropped.push(result);
      continue;
    }
    converted.push({ key: canonicalKey(ir), category: categoryOf(ir), rule: result.rule, demotableTo: result.cosmeticFallback });
  }

  // ---- Pass 4: deterministic priorities + allow-rule elevation ----
  const conditionKey = (r: DnrRule): string => {
    const c = r.condition;
    return [
      c.urlFilter ?? '',
      c.regexFilter ?? '',
      (c.requestDomains ?? []).slice().sort().join(','),
      (c.excludedRequestDomains ?? []).slice().sort().join(','),
      (c.resourceTypes ?? []).slice().sort().join(',')
    ].join('|');
  };

  const BLOCK_PRIORITY_BASE = 1000;
  const BLOCK_PRIORITY_CAP = 6999;
  const ALLOW_PRIORITY_BASE = 7000;
  const ALLOW_PRIORITY_CAP = 7999;

  converted.forEach((entry, idx) => {
    if (entry.rule.action.type === 'allow') return;
    const priority = BLOCK_PRIORITY_BASE + (idx % (BLOCK_PRIORITY_CAP - BLOCK_PRIORITY_BASE + 1));
    entry.rule.priority = priority;
  });

  let allowIdx = 0;
  converted.forEach((entry) => {
    if (entry.rule.action.type !== 'allow') return;
    // Allow rules are guaranteed to sit strictly above all block rules in priority (7000-7999 range)
    const priority = ALLOW_PRIORITY_BASE + (allowIdx % (ALLOW_PRIORITY_CAP - ALLOW_PRIORITY_BASE + 1));
    entry.rule.priority = priority;
    allowIdx += 1;
  });

  // ---- Assemble ----
  const cosmetic = buildCosmeticCss(cosmeticIrs);
  const dnrRules: CompiledPack['dnrRules'] = { hotfix: [], trackers: [], ads: [] };
  const rules: CompiledRule[] = [];
  for (const entry of converted) {
    dnrRules[entry.category].push(entry.rule);
    rules.push({
      key: entry.key,
      category: entry.category,
      rule: entry.rule,
      frequency: 0.5,
      confidence: 0.9,
      cosmeticFallback: entry.demotableTo
    });
  }

  // Stable cosmetic downgrade record (kept for stats visibility; CSS itself is in the pack).
  for (const ir of cosmeticIrs) {
    if (ir.cosmetic && !ir.cosmetic.isGeneric) downgradedToCosmetic.push(ir.cosmetic.domains.join(','));
  }

  const pack: CompiledPack = {
    version: Date.now(),
    dnrRules,
    cosmetic,
    scriptletDispatch: Object.fromEntries([...scriptlets.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    stats: {
      rulesCompiled: rules.length + countCssRules(cosmetic) + countScriptlets(scriptlets),
      dropped: dropped.length,
      downgradedToCosmetic: downgradedToCosmetic.length
    }
  };

  const validated = validateCompiledPack(pack);
  if (!validated.ok) {
    // Compilation must never produce an invalid pack; degrade to an empty safe pack.
    return {
      pack: {
        version: Date.now(),
        dnrRules: { hotfix: [], trackers: [], ads: [] },
        cosmetic: { genericCss: '', perDomain: {} },
        scriptletDispatch: {},
        stats: { rulesCompiled: 0, dropped: dropped.length + 1, downgradedToCosmetic: 0 }
      },
      rules: []
    };
  }

  return { pack: validated.value, rules };
}

function countCssRules(cosmetic: CompiledPack['cosmetic']): number {
  return cosmetic.genericCss.split('\n').filter((l) => l.length > 0).length +
    Object.values(cosmetic.perDomain).reduce((sum, arr) => sum + arr.length, 0);
}

function countScriptlets(map: Map<string, { name: string; args: (string | number)[] }[]>): number {
  let n = 0;
  for (const list of map.values()) n += list.length;
  return n;
}

function categoryOf(ir: FilterIR): PackCategory {
  if (ir.source.listId === 'hotfix') return 'hotfix';
  if (ir.source.listId === 'trackers') return 'trackers';
  return 'ads';
}

function domainScopeOf(ir: FilterIR): string[] {
  if (ir.kind === 'cosmetic' && ir.cosmetic) return ir.cosmetic.domains;
  if (ir.kind === 'scriptlet' && ir.scriptlet?.domains) return ir.scriptlet.domains;
  return [];
}

function validateIrShape(ir: FilterIR): { ok: true } | { ok: false; error: string } {
  if (typeof ir !== 'object' || ir === null) return { ok: false, error: 'not-object' };
  if (typeof ir.source?.listId !== 'string') return { ok: false, error: 'bad-source' };
  if (ir.kind === 'network' || ir.kind === 'redirect' || ir.kind === 'removeparam') {
    if (ir.network === undefined) return { ok: false, error: 'missing-network' };
  }
  return { ok: true };
}

function sanitizeResourceTypes(types: string[]): ResourceType[] | undefined {
  const mapped = types.filter((t): t is ResourceType => KNOWN_RESOURCE_TYPES.has(t as ResourceType));
  if (mapped.length === 0) return undefined;
  return mapped;
}

interface NetworkConversion {
  rule: DnrRule;
  cosmeticFallback: string | null;
}

function convertNetworkRule(ir: FilterIR): NetworkConversion | string {
  const network = ir.network;
  if (network === undefined) return 'missing-network';

  const condition: DnrRule['condition'] = {};
  const resourceTypes = sanitizeResourceTypes(network.match.resourceTypes);
  if (resourceTypes !== undefined) condition.resourceTypes = resourceTypes;
  if (network.match.thirdParty === true) condition.domainType = 'thirdParty';
  if (network.match.thirdParty === false) condition.domainType = 'firstParty';

  const isPatternRule = network.pattern.regex !== undefined || network.pattern.urlFilter !== undefined;
  if (ir.kind === 'removeparam') {
    if (network.match.domains && network.match.domains.length > 0) condition.requestDomains = network.match.domains.slice(0, 64);
    if (network.match.notDomains && network.match.notDomains.length > 0) condition.excludedInitiatorDomains = network.match.notDomains.slice(0, 64);
  } else if (isPatternRule) {
    if (network.match.domains && network.match.domains.length > 0) condition.initiatorDomains = network.match.domains.slice(0, 64);
    if (network.match.notDomains && network.match.notDomains.length > 0) condition.excludedInitiatorDomains = network.match.notDomains.slice(0, 64);
  } else {
    if (network.match.domains && network.match.domains.length > 0) condition.requestDomains = network.match.domains.slice(0, 64);
    if (network.match.notDomains && network.match.notDomains.length > 0) condition.excludedInitiatorDomains = network.match.notDomains.slice(0, 64);
  }

  // Regex rules must be RE2-valid; invalid regex with explicit domains downgrades to
  // a domain-only rule (semantics preserved at domain level), otherwise it is dropped.
  if (network.pattern.regex !== undefined) {
    const re2 = validateRe2(network.pattern.regex);
    if (!re2.valid) {
      if ((condition.requestDomains !== undefined || condition.initiatorDomains !== undefined) && network.action === 'block') {
        // safe downgrade: domain-level block, no path matching
      } else {
        return `invalid-regex:${re2.reason}`;
      }
    } else {
      condition.regexFilter = network.pattern.regex;
    }
  } else if (network.pattern.urlFilter !== undefined) {
    condition.urlFilter = network.pattern.urlFilter;
  }

  if (Object.keys(condition).length === 0) return 'empty-condition';

  let action: DnrRule['action'];
  switch (network.action) {
    case 'allow':
      action = { type: 'allow' };
      break;
    case 'redirect': {
      const target = network.redirectTarget ?? '1x1.gif';
      if (target !== '1x1.gif' && target !== 'noop.js') return 'unsafe-redirect';
      action = { type: 'redirect', redirect: { extensionPath: `/resources/${target}` } };
      break;
    }
    case 'modifyQuery': {
      const params = network.removeParams ?? [];
      if (params.length === 0) return 'empty-removeparams';
      action = { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: params } } } };
      break;
    }
    default:
      action = { type: 'block' };
  }

  const rule: DnrRule = { id: 0, priority: DYNAMIC_PRIORITY_BASE, action, condition };

  // Cosmetic fallback: single-domain image/media blocks can also be hidden via CSS.
  let cosmeticFallback: string | null = null;
  const domains = condition.requestDomains;
  const types = condition.resourceTypes;
  if (network.action === 'block' && domains !== undefined && domains.length === 1 &&
      types !== undefined && types.length > 0 && types.every((t) => t === 'image' || t === 'media')) {
    cosmeticFallback = `img[src*="${domains[0]}"],iframe[src*="${domains[0]}"]{display:none !important}`;
  }

  return { rule, cosmeticFallback };
}
