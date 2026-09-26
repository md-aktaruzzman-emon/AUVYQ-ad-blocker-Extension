/*
 * Cosmetic engine: selector validation and CSS assembly.
 * Selectors are strictly validated before any CSS string is ever built —
 * the content injector never sees raw list text.
 */
import type { FilterIR } from '../../types/schemas.js';
import { LIMITS } from '../validation/schemas.js';

export interface CosmeticBuild {
  genericCss: string;
  perDomain: Record<string, string[]>;
}

const FORBIDDEN_SELECTOR_TOKENS = [
  '{', '}', '<', '>', '@', '\\', 'url(', 'expression', 'javascript:', 'behavior',
  'import', 'charset', '/*', '*/', ';'
];

export interface SelectorCheck {
  valid: boolean;
  reason?: string;
}

export function validateSelector(selector: string): SelectorCheck {
  if (typeof selector !== 'string' || selector.length === 0) return { valid: false, reason: 'empty' };
  if (selector.length > LIMITS.selectorChars) return { valid: false, reason: 'too-long' };
  const lowered = selector.toLowerCase();
  for (const token of FORBIDDEN_SELECTOR_TOKENS) {
    if (lowered.includes(token)) return { valid: false, reason: `forbidden: ${token}` };
  }
  // Allowlist of characters that can legitimately appear in a CSS selector.
  // eslint-disable-next-line no-control-regex
  if (!/^[a-zA-Z0-9_\u00A0-\uFFFF\s.#\[\]()>:~+*,='"|^$-]+$/.test(selector)) {
    return { valid: false, reason: 'charset' };
  }
  return { valid: true };
}

function cssRuleFor(selector: string): string {
  return `${selector}{display:none !important}`;
}

/** Builds generic and per-domain CSS from validated cosmetic IRs. Deterministic output. */
export function buildCosmeticCss(irs: FilterIR[]): CosmeticBuild {
  const genericSelectors = new Set<string>();
  const perDomain = new Map<string, Set<string>>();

  for (const ir of irs) {
    if (ir.kind !== 'cosmetic' || !ir.cosmetic) continue;
    const check = validateSelector(ir.cosmetic.selector);
    if (!check.valid) continue;

    if (ir.cosmetic.isGeneric || ir.cosmetic.domains.length === 0) {
      genericSelectors.add(ir.cosmetic.selector);
      continue;
    }
    for (const domain of ir.cosmetic.domains) {
      let set = perDomain.get(domain);
      if (set === undefined) {
        set = new Set<string>();
        perDomain.set(domain, set);
      }
      set.add(ir.cosmetic.selector);
    }
  }

  const genericCssParts: string[] = [];
  for (const selector of [...genericSelectors].sort()) {
    genericCssParts.push(cssRuleFor(selector));
  }

  const perDomainOut: Record<string, string[]> = {};
  for (const domain of [...perDomain.keys()].sort()) {
    const selectors = perDomain.get(domain);
    if (!selectors) continue;
    perDomainOut[domain] = [...selectors].sort().map(cssRuleFor);
  }

  return { genericCss: genericCssParts.join('\n'), perDomain: perDomainOut };
}
