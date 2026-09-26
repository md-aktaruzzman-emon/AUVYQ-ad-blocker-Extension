/*
 * Filter-list parser. Converts adblock-style text into FilterIR.
 * Unknown or malformed syntax is counted as dropped and NEVER throws.
 * Remote/updated lists are DATA ONLY: this parser never evaluates their content.
 */
import type { FilterIR } from '../../types/schemas.js';
import { LIMITS, isRecord } from '../validation/schemas.js';
import { normalizeHostname } from '../domain/normalize.js';
import { validateRe2 } from '../rule-compiler/re2-validate.js';

export interface ParseStats {
  total: number;
  parsed: number;
  dropped: number;
}

export interface ParseResult {
  rules: FilterIR[];
  stats: ParseStats;
}

const RESOURCE_TYPE_MAP: Record<string, string[]> = {
  image: ['image'],
  img: ['image'],
  script: ['script'],
  stylesheet: ['stylesheet'],
  css: ['stylesheet'],
  font: ['font'],
  media: ['media'],
  xmlhttprequest: ['xmlhttprequest'],
  xhr: ['xmlhttprequest'],
  subdocument: ['sub_frame'],
  frame: ['sub_frame'],
  object: ['object'],
  ping: ['ping'],
  websocket: ['websocket'],
  other: ['other']
};

/** A curated fallback set when no explicit $type is given. main_frame is excluded by design. */
export const DEFAULT_RESOURCE_TYPES = [
  'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other'
];

export function parseFilterList(listText: string, listId: string): FilterIR[] {
  return parseFilterListWithStats(listText, listId).rules;
}

export function parseFilterListWithStats(listText: string, listId: string): ParseResult {
  const stats: ParseStats = { total: 0, parsed: 0, dropped: 0 };
  const rules: FilterIR[] = [];

  if (typeof listText !== 'string' || listId.length === 0 || listId.length > 64) {
    return { rules, stats };
  }

  let text = listText.replace(/^\uFEFF/, '');
  if (text.length > LIMITS.filterListBytes) {
    const overflow = text.length - LIMITS.filterListBytes;
    text = text.slice(0, LIMITS.filterListBytes);
    stats.dropped += countLines(text.slice(-overflow)) + 1;
  }

  const lines = text.split(/\r\n|\n|\r/);
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    stats.total += 1;
    if (rawLine.length > LIMITS.filterLineChars) {
      stats.dropped += 1;
      continue;
    }
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('!') || line.startsWith('[Adblock')) {
      continue; // comments and headers are not "rules", not dropped either
    }

    const ir = parseLine(line, listId, i + 1);
    if (ir === null) {
      stats.dropped += 1;
      continue;
    }
    const key = canonicalKey(ir);
    if (seen.has(key)) {
      stats.dropped += 1; // duplicates counted as dropped
      continue;
    }
    seen.add(key);
    rules.push(ir);
    stats.parsed += 1;
  }

  return { rules, stats };
}

function countLines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === '\n' || ch === '\r') n += 1;
  return n;
}

export function canonicalKey(ir: FilterIR): string {
  if (ir.kind === 'network' || ir.kind === 'redirect' || ir.kind === 'removeparam') {
    const net = ir.network;
    if (!net) return `${ir.kind}:?`;
    return [
      ir.kind,
      net.action,
      net.pattern.urlFilter ?? '',
      net.pattern.regex ?? '',
      (net.match.domains ?? []).slice().sort().join(','),
      (net.match.notDomains ?? []).slice().sort().join(','),
      net.match.resourceTypes.slice().sort().join(','),
      net.match.thirdParty === undefined ? '' : String(net.match.thirdParty),
      (net.removeParams ?? []).slice().sort().join(',')
    ].join('|');
  }
  if (ir.kind === 'cosmetic' && ir.cosmetic) {
    return `cosmetic:${ir.cosmetic.domains.slice().sort().join(',')}:${ir.cosmetic.selector}`;
  }
  if (ir.kind === 'scriptlet' && ir.scriptlet) {
    return `scriptlet:${ir.scriptlet.name}:${ir.scriptlet.args.join(',')}`;
  }
  return `${ir.kind}:?`;
}

/** Parses one line. Returns null when the line must be dropped. */
function parseLine(line: string, listId: string, lineNumber: number): FilterIR | null {
  // Control characters and zero-width tricks are hostile input.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/.test(line)) return null;

  // Lines starting with # that are not comments or ## cosmetic rules are unsupported/dropped
  if (line.startsWith('#') && !line.startsWith('##')) return null;

  // Cosmetic exception: #@#
  if (line.includes('#@#')) return null; // cosmetic exceptions unsupported -> dropped
  // Cosmetic or scriptlet
  const cosmeticSplit = findCosmeticSeparator(line);
  if (cosmeticSplit !== null) {
    return parseCosmetic(cosmeticSplit.domains, cosmeticSplit.body, listId, lineNumber);
  }

  let isException = false;
  let rest = line;
  if (rest.startsWith('@@')) {
    isException = true;
    rest = rest.slice(2);
  }
  if (rest.length === 0 || rest === '||') return null;

  // Split options at the LAST '$'
  let patternPart = rest;
  let optionsPart = '';
  const dollar = rest.lastIndexOf('$');
  if (dollar > 0) {
    patternPart = rest.slice(0, dollar);
    optionsPart = rest.slice(dollar + 1);
  }

  if (patternPart.length === 0 || patternPart === '||') return null;
  const options = optionsPart.length > 0 ? optionsPart.split(',') : [];
  return parseNetwork(patternPart, options, isException, listId, lineNumber);
}

function findCosmeticSeparator(line: string): { domains: string; body: string } | null {
  // Supported separators: ## (cosmetic). Adguard-only separators are dropped.
  for (const sep of ['#@%', '#$%', '#%#', '#?#', '#$?#']) {
    if (line.includes(sep)) return null;
  }
  const idx = line.indexOf('##');
  if (idx < 0) return null;
  const domains = line.slice(0, idx);
  const body = line.slice(idx + 2);
  if (domains.length > 0 && !/^[\w~,. -]+$/.test(domains)) return null;
  return { domains, body };
}

function parseCosmetic(domainPart: string, body: string, listId: string, lineNumber: number): FilterIR | null {
  if (body.length === 0 || body.length > LIMITS.selectorChars) return null;

  const domains = domainPart.length === 0
    ? []
    : domainPart.split(',').map((d) => d.trim()).filter((d) => d.length > 0);
  const notDomains: string[] = [];
  const includeDomains: string[] = [];
  for (const d of domains) {
    if (d.startsWith('~')) notDomains.push(normalizeHostname(d.slice(1)));
    else includeDomains.push(normalizeHostname(d));
  }
  if (includeDomains.some((d) => d.length === 0) || notDomains.some((d) => d.length === 0)) return null;

  if (body.startsWith('+js(')) {
    if (!body.endsWith(')')) return null;
    const inner = body.slice(4, -1);
    const args = splitScriptletArgs(inner);
    if (args.length === 0 || typeof args[0] !== 'string') return null;
    return {
      kind: 'scriptlet',
      source: { listId, line: lineNumber },
      scriptlet: { name: args[0], args: args.slice(1), domains: includeDomains }
    };
  }

  const isGeneric = includeDomains.length === 0;
  return {
    kind: 'cosmetic',
    source: { listId, line: lineNumber },
    cosmetic: { selector: body, domains: includeDomains, isGeneric }
  };
}

function splitScriptletArgs(inner: string): (string | number)[] {
  const args: (string | number)[] = [];
  let current = '';
  let inQuote: string | null = null;
  for (const ch of inner) {
    if (inQuote !== null) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === ',') {
      args.push(parseArg(current));
      current = '';
      continue;
    }
    current += ch;
  }
  if (inQuote !== null) return []; // unbalanced quotes: reject
  args.push(parseArg(current));
  return args.filter((a) => (typeof a === 'string' ? a.length > 0 : true));
}

function parseArg(raw: string): string | number {
  const trimmed = raw.trim();
  if (/^-?\d{1,9}$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function parseNetwork(
  patternPart: string,
  options: string[],
  isException: boolean,
  listId: string,
  lineNumber: number
): FilterIR | null {
  if (patternPart.length === 0 || patternPart.length > 512) return null;

  let thirdParty: boolean | undefined;
  const resourceTypes = new Set<string>();
  let domainList: string[] = [];
  let notDomainList: string[] = [];
  let important = false;
  let removeParam: string | null = null;
  let redirectTarget: string | null = null;

  for (const option of options) {
    if (option === 'third-party') thirdParty = true;
    else if (option === 'first-party') thirdParty = false;
    else if (option === 'important') important = true;
    else if (option.startsWith('domain=')) {
      const parsed = parseDomainOption(option.slice('domain='.length));
      if (parsed === null) return null;
      domainList = parsed.domains;
      notDomainList = parsed.notDomains;
    } else if (option.startsWith('removeparam')) {
      if (isException) return null;
      const eq = option.indexOf('=');
      removeParam = eq > 0 ? option.slice(eq + 1) : '*';
    } else if (option.startsWith('redirect=')) {
      if (isException) return null;
      redirectTarget = option.slice('redirect='.length);
    } else if (option === 'redirect') {
      if (isException) return null;
      redirectTarget = '1x1.gif';
    } else if (RESOURCE_TYPE_MAP[option] !== undefined) {
      for (const t of RESOURCE_TYPE_MAP[option]) resourceTypes.add(t);
    } else {
      return null; // unknown option: drop the rule (safe)
    }
  }

  // $removeparam handling
  if (removeParam !== null && removeParam !== '*') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(removeParam)) return null;
    const { domains } = extractAnchoredDomains(patternPart);
    if (domains.length === 0 && domainList.length === 0) return null; // global unscoped removeparam refused
    return {
      kind: 'removeparam',
      source: { listId, line: lineNumber },
      network: {
        match: {
          domains: domains.length > 0 ? domains : domainList,
          notDomains: notDomainList,
          resourceTypes: ['main_frame'],
          thirdParty
        },
        pattern: { isRegexValidRE2: true },
        action: 'modifyQuery',
        removeParams: [removeParam]
      }
    };
  }
  if (removeParam === '*') {
    return null; // blanket query rewrite refused: too broad to be safe
  }

  // Redirect rules must target known-safe extension resources.
  if (redirectTarget !== null) {
    const safe = redirectTarget === '1x1.gif' || redirectTarget === 'noop.js';
    if (!safe) return null;
  }

  const kind: FilterIR['kind'] = redirectTarget !== null ? 'redirect' : 'network';

  // Pure-domain rules become requestDomains conditions (modern DNR keys).
  const { domains: anchoredDomains, pathPart } = extractAnchoredDomains(patternPart);
  if (anchoredDomains.length > 0 && (pathPart.length === 0 || pathPart === '*' || pathPart === '^')) {
    return {
      kind,
      source: { listId, line: lineNumber },
      network: {
        match: {
          domains: anchoredDomains,
          notDomains: notDomainList,
          resourceTypes: resourceTypes.size > 0 ? [...resourceTypes] : [...DEFAULT_RESOURCE_TYPES],
          thirdParty
        },
        pattern: { urlFilter: undefined, isRegexValidRE2: true },
        action: isException ? 'allow' : redirectTarget ? 'redirect' : 'block',
        redirectTarget: redirectTarget ?? undefined
      }
    };
  }

  if (isException && anchoredDomains.length === 0 && domainList.length === 0) return null;

  // Regex / urlFilter path.
  const regex = patternToRegex(patternPart);
  if (regex === null) return null;
  const re2 = validateRe2(regex);
  if (!re2.valid) return null;

  return {
    kind,
    source: { listId, line: lineNumber },
    network: {
      match: {
        domains: domainList,
        notDomains: notDomainList,
        resourceTypes: resourceTypes.size > 0 ? [...resourceTypes] : [...DEFAULT_RESOURCE_TYPES],
        thirdParty
      },
      pattern: { regex, isRegexValidRE2: true },
      action: isException ? 'allow' : redirectTarget ? 'redirect' : 'block',
      redirectTarget: redirectTarget ?? undefined
    }
  };
}

function parseDomainOption(value: string): { domains: string[]; notDomains: string[] } | null {
  if (value.length === 0 || value.length > 4096) return null;
  const domains: string[] = [];
  const notDomains: string[] = [];
  for (const part of value.split('|')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith('~')) {
      const host = normalizeHostname(trimmed.slice(1));
      if (host.length === 0) return null;
      notDomains.push(host);
    } else {
      const host = normalizeHostname(trimmed);
      if (host.length === 0) return null;
      domains.push(host);
    }
  }
  if (domains.length > 64 || notDomains.length > 64) return null;
  return { domains, notDomains };
}

/** Extracts `||host` anchored domains; returns the remaining path part after the host. */
function extractAnchoredDomains(pattern: string): { domains: string[]; pathPart: string } {
  if (!pattern.startsWith('||')) return { domains: [], pathPart: pattern };
  let rest = pattern.slice(2);
  if (rest.startsWith('*.')) rest = rest.slice(2);
  const separatorIdx = rest.search(/[/^*|]/);
  const hostPart = separatorIdx >= 0 ? rest.slice(0, separatorIdx) : rest;
  const pathPart = separatorIdx >= 0 ? rest.slice(separatorIdx) : '';
  const host = normalizeHostname(hostPart);
  if (host.length === 0) return { domains: [], pathPart: pattern };
  return { domains: [host], pathPart };
}

/** Converts an adblock pattern to an RE2-compatible regex, or null when impossible. */
export function patternToRegex(pattern: string): string | null {
  let source = pattern;
  let prefix = '';
  if (source.startsWith('||')) {
    source = source.slice(2);
    prefix = '^[a-z][a-z0-9+.-]*://([^/?#]+\\.)?';
  } else if (source.startsWith('|')) {
    source = source.slice(1);
    prefix = '^';
  }
  let suffix = '';
  if (source.endsWith('|')) {
    source = source.slice(0, -1);
    suffix = '$';
  }
  if (source.length === 0) return null;

  let out = '';
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '^') {
      out += '([/?#]|$)';
      continue;
    }
    if (ch === '*') {
      out += '.*';
      continue;
    }
    if (/[a-zA-Z0-9_.\-]/.test(ch)) {
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) return null;
      out += `\\${next}`;
      i += 1;
      continue;
    }
    out += `\\${ch}`;
  }
  return `${prefix}${out}${suffix}`;
}

/** Guard used by tooling/tests to reject absurd inputs before parsing. */
export function looksLikeRecord(value: unknown): boolean {
  return isRecord(value);
}
