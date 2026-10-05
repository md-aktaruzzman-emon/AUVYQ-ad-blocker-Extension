/*
 * Tier-1 deterministic threat heuristics: homoglyphs, typosquatting, redirect chains,
 * foreign-origin login detection. Pure functions -> RiskResult. No ML claims.
 */
import type { RiskResult, RiskSeverity, DomFeatures } from '../../types/schemas.js';
import { normalizeHostname, registrableDomain } from '../domain/normalize.js';
import topDomains from '../../data/top-domains.json';

const TOP_DOMAINS: readonly string[] = topDomains;

const RISKY_TLDS = new Set([
  'zip', 'mov', 'top', 'xyz', 'click', 'country', 'kim', 'work', 'loan', 'men', 'party', 'review', 'stream', 'gq', 'cf', 'tk', 'ml'
]);

const HOMOGLYPH_RANGES: [number, number][] = [
  [0x0400, 0x04FF], // Cyrillic
  [0x0370, 0x03FF], // Greek
  [0x0530, 0x058F], // Armenian
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x06FF]  // Arabic
];

function severityFor(score: number): RiskSeverity {
  if (score >= 85) return 'malicious';
  if (score >= 65) return 'high';
  if (score >= 40) return 'medium';
  if (score >= 15) return 'low';
  return 'none';
}

export function makeRisk(score: number, reasons: string[], confidence: number): RiskResult {
  const clamped = Math.min(100, Math.max(0, Math.round(score)));
  return {
    score: clamped,
    severity: severityFor(clamped),
    reasons: reasons.slice(0, 16),
    confidence: Math.min(1, Math.max(0, confidence))
  };
}

// ---------------------------------------------------------------------------
// Homoglyph detection
// ---------------------------------------------------------------------------

export function detectHomoglyph(hostname: string): boolean {
  const host = normalizeHostname(hostname);
  if (host.length === 0) return false;
  if (host.startsWith('xn--') || host.split('.').some((l) => l.startsWith('xn--'))) return true; // punycode label: requires user scrutiny
  let hasLatin = false;
  let hasNonLatin = false;
  for (const ch of host) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      hasLatin = true;
      continue;
    }
    if (HOMOGLYPH_RANGES.some(([lo, hi]) => code >= lo && code <= hi)) hasNonLatin = true;
  }
  return hasLatin && hasNonLatin;
}

export function detectDeceptiveSubdomain(hostname: string): { suspicious: boolean; target?: string } {
  const host = normalizeHostname(hostname);
  if (host.length === 0 || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return { suspicious: false };
  }
  const base = registrableDomain(host);
  if (host === base) return { suspicious: false };
  const subPrefix = host.slice(0, host.length - base.length).replace(/\.$/, '');
  for (const popular of TOP_DOMAINS) {
    if (subPrefix === popular || subPrefix.startsWith(`${popular}.`) || subPrefix.endsWith(`.${popular}`) || subPrefix.includes(`.${popular}.`)) {
      return { suspicious: true, target: popular };
    }
  }
  return { suspicious: false };
}

// ---------------------------------------------------------------------------
// Typosquatting: Damerau-Levenshtein (optimal string alignment) vs popular domains
// ---------------------------------------------------------------------------

export function damerauLevenshtein(a: string, b: string, maxDistance = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  const lenA = a.length;
  const lenB = b.length;
  const d: number[][] = Array.from({ length: lenA + 1 }, () => new Array<number>(lenB + 1).fill(0));
  for (let i = 0; i <= lenA; i++) d[i][0] = i;
  for (let j = 0; j <= lenB; j++) d[0][j] = j;
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(
        (d[i - 1][j] ?? 0) + 1,
        (d[i][j - 1] ?? 0) + 1,
        (d[i - 1][j - 1] ?? 0) + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (d[i - 2][j - 2] ?? 0) + 1);
      }
      d[i][j] = value;
    }
  }
  return d[lenA][lenB] ?? maxDistance + 1;
}

export interface TyposquatResult {
  suspicious: boolean;
  target?: string;
  distance?: number;
}

// Common short dictionary / brand words and known legitimate domains that must never be flagged as typosquats
const KNOWN_LEGITIMATE_DOMAINS = new Set([
  'fox.com', 'ubs.com', 'ring.com', 'king.com', 'mac.com', 'max.com', 'box.com', 'ups.com',
  'x.com', 'email.com', 'okta.com', 'github.io', 'paypal.me', 'redfin.com'
]);

function extractBrandLabel(registrable: string): string {
  const parts = registrable.split('.');
  return parts[0] ?? '';
}

export function typosquatCheck(hostname: string, maxDistance = 2): TyposquatResult {
  const host = normalizeHostname(hostname);
  if (host.length === 0 || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return { suspicious: false };
  }
  const base = registrableDomain(host);
  if (TOP_DOMAINS.includes(base) || KNOWN_LEGITIMATE_DOMAINS.has(base)) return { suspicious: false };

  const baseLabel = extractBrandLabel(base);
  // Short labels (<= 4 chars) are high-entropy acronyms/words (e.g. fox, ubs, ring, mac, king).
  // They must not be flagged by general edit distance unless an explicit digit substitution is present.
  const hasDigitSubstitution = /\d/.test(baseLabel);
  if (baseLabel.length <= 4 && !hasDigitSubstitution) {
    return { suspicious: false };
  }

  let best: { target: string; distance: number } | null = null;
  for (const popular of TOP_DOMAINS) {
    const popularLabel = extractBrandLabel(popular);
    if (baseLabel === popularLabel) {
      // Identical brand label on a legitimate alternate domain (e.g. github.io vs github.com)
      continue;
    }

    // Distance 1 requires candidate and target to be at least 5 chars (or digit substitution present)
    // Distance 2 requires longer words (at least 8 chars) to prevent false positives like okta vs ikea
    const distance = damerauLevenshtein(baseLabel, popularLabel, maxDistance);
    if (distance > 0 && distance <= maxDistance) {
      if (distance === 1 && (baseLabel.length < 5 || popularLabel.length < 5) && !hasDigitSubstitution) {
        continue;
      }
      if (distance === 2 && (baseLabel.length < 8 || popularLabel.length < 8)) {
        continue;
      }
      if (best === null || distance < best.distance) {
        best = { target: popular, distance };
      }
      if (distance === 1) break;
    }
  }
  if (best === null) return { suspicious: false };
  return { suspicious: true, target: best.target, distance: best.distance };
}

// ---------------------------------------------------------------------------
// Redirect-chain scoring
// ---------------------------------------------------------------------------

export interface RedirectAssessment {
  score: number;
  reasons: string[];
}

export function scoreRedirectChain(chain: { url: string }[]): RedirectAssessment {
  const reasons: string[] = [];
  if (chain.length < 2) return { score: 0, reasons };

  const hosts = chain.map((entry) => {
    try {
      return new URL(entry.url).hostname;
    } catch {
      return '';
    }
  }).filter((h) => h.length > 0);

  let score = 0;
  const uniqueHosts = new Set(hosts);
  if (hosts.length >= 4) {
    score += 25;
    reasons.push(`Long redirect chain (${hosts.length} hops)`);
  } else if (hosts.length >= 3) {
    score += 12;
    reasons.push(`Redirect chain (${hosts.length} hops)`);
  }
  if (uniqueHosts.size >= 3) {
    score += 15;
    reasons.push('Redirects cross multiple unrelated domains');
  }

  const first = hosts[0] ?? '';
  const last = hosts[hosts.length - 1] ?? '';
  if (first.length > 0 && last.length > 0) {
    const firstDomain = registrableDomain(first);
    const lastDomain = registrableDomain(last);
    if (firstDomain !== lastDomain) {
      score += 15;
      reasons.push('Redirect leaves the original site');
    }
    const lastTld = lastDomain.split('.').pop() ?? '';
    if (RISKY_TLDS.has(lastTld)) {
      score += 25;
      reasons.push(`Lands on a high-risk domain ending in .${lastTld}`);
    }
  }
  return { score: Math.min(70, score), reasons };
}

// ---------------------------------------------------------------------------
// Foreign-origin login detection
// ---------------------------------------------------------------------------

export interface LoginFormInput {
  actionOrigin: string;
  hasPasswordField: boolean;
}

const SSO_IDP_PROVIDERS = new Set([
  'okta.com',
  'auth0.com',
  'onelogin.com',
  'microsoftonline.com',
  'login.microsoftonline.com',
  'login.live.com',
  'accounts.google.com',
  'appleid.apple.com',
  'id.apple.com',
  'pingidentity.com',
  'cognito.com',
  'firebaseapp.com',
  'supabase.co'
]);

function isKnownSsoProvider(hostname: string): boolean {
  const norm = normalizeHostname(hostname);
  const reg = registrableDomain(norm);
  if (SSO_IDP_PROVIDERS.has(norm) || SSO_IDP_PROVIDERS.has(reg)) return true;
  for (const sso of SSO_IDP_PROVIDERS) {
    if (norm.endsWith(`.${sso}`)) return true;
  }
  return false;
}

export function detectForeignLogin(pageOrigin: string, forms: LoginFormInput[]): RedirectAssessment {
  const reasons: string[] = [];
  let score = 0;
  let pageHost = '';
  try {
    pageHost = new URL(pageOrigin).hostname;
  } catch {
    return { score: 0, reasons };
  }
  for (const form of forms) {
    if (!form.hasPasswordField) continue;
    let actionHost = '';
    let actionOrigin = '';
    try {
      const parsed = new URL(form.actionOrigin);
      actionHost = parsed.hostname;
      actionOrigin = parsed.origin;
    } catch {
      continue;
    }
    if (actionOrigin === pageOrigin) continue;
    if (actionHost.length > 0 && actionHost !== pageHost) {
      if (isKnownSsoProvider(actionHost)) {
        // Legitimate SSO authentication provider (e.g. Okta, Auth0, Google, Microsoft)
        continue;
      }
      const foreignDomain = registrableDomain(actionHost);
      const pageDomain = registrableDomain(pageHost);
      score = Math.max(score, foreignDomain === pageDomain ? 35 : 70);
      reasons.push(
        foreignDomain === pageDomain
          ? 'Password form submits to a different subdomain'
          : 'Password form submits to a completely different site'
      );
    }
  }
  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Aggregate assessment
// ---------------------------------------------------------------------------

export interface HeuristicInput extends DomFeatures {}

export function assessThreat(input: HeuristicInput): RiskResult {
  const reasons: string[] = [];
  let score = 0;
  let signals = 0;

  const host = normalizeHostname(input.hostname);
  if (host.length > 0) {
    if (detectHomoglyph(host)) {
      score += 55;
      signals += 1;
      reasons.push('Hostname uses look-alike Unicode characters (possible impersonation)');
    }
    const typo = typosquatCheck(host);
    if (typo.suspicious) {
      score += 50;
      signals += 1;
      reasons.push(`Domain closely resembles the popular site ${typo.target}`);
    }
    const deceptive = detectDeceptiveSubdomain(host);
    if (deceptive.suspicious && deceptive.target) {
      score += 55;
      signals += 1;
      reasons.push(`Deceptive subdomain impersonating ${deceptive.target}`);
    }
    const tld = registrableDomain(host).split('.').pop() ?? '';
    if (RISKY_TLDS.has(tld)) {
      score += 20;
      signals += 1;
      reasons.push(`Domain uses a high-risk ending (.${tld})`);
    }
  }

  if (input.redirectChain !== undefined && input.redirectChain.length >= 2) {
    const redirect = scoreRedirectChain(input.redirectChain);
    score += redirect.score;
    signals += redirect.reasons.length > 0 ? 1 : 0;
    reasons.push(...redirect.reasons);
  }

  if (input.loginForms !== undefined && input.pageOrigin !== undefined && input.loginForms.length > 0) {
    const login = detectForeignLogin(input.pageOrigin, input.loginForms);
    score += login.score;
    signals += login.reasons.length > 0 ? 1 : 0;
    reasons.push(...login.reasons);
  }

  const confidence = signals === 0 ? 0.5 : Math.min(0.95, 0.6 + signals * 0.12);
  return makeRisk(score, reasons, confidence);
}
