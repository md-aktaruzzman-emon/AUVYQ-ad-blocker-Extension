/*
 * Tier-1 deterministic threat heuristics: homoglyphs, typosquatting, brand impersonation,
 * structure anomalies, redirect chains, foreign-origin login detection, and local threat intel.
 * Pure functions -> RiskResult. No fake ML claims.
 */
import type { RiskResult, RiskSeverity, DomFeatures, ThreatSignal } from '../../types/schemas.js';
import { normalizeHostname, registrableDomain } from '../domain/normalize.js';
import topDomains from '../../data/top-domains.json';
import { checkMaliciousIntelligence } from '../threat-intelligence/intel.js';

const TOP_DOMAINS: readonly string[] = topDomains;

export const RISKY_TLDS = new Set([
  'zip', 'mov', 'top', 'xyz', 'click', 'country', 'kim', 'work', 'loan', 'men', 'party', 'review', 'stream', 'gq', 'cf', 'tk', 'ml', 'date', 'bid'
]);

export const HOMOGLYPH_RANGES: [number, number][] = [
  [0x0400, 0x04FF], // Cyrillic
  [0x0370, 0x03FF], // Greek
  [0x0530, 0x058F], // Armenian
  [0x0590, 0x05FF], // Hebrew
  [0x0600, 0x06FF]  // Arabic
];

// High-value target brands frequently targeted in phishing & credential theft
export const PROTECTED_BRANDS: Record<string, string[]> = {
  paypal: ['paypal.com', 'paypal.me'],
  apple: ['apple.com', 'icloud.com'],
  google: ['google.com', 'google.co.uk', 'youtube.com', 'gmail.com'],
  microsoft: ['microsoft.com', 'live.com', 'office.com', 'outlook.com', 'microsoftonline.com', 'login.microsoftonline.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'aws.amazon.com'],
  netflix: ['netflix.com'],
  chase: ['chase.com'],
  bankofamerica: ['bankofamerica.com'],
  wellsfargo: ['wellsfargo.com'],
  citi: ['citi.com', 'citigroup.com'],
  capitalone: ['capitalone.com'],
  binance: ['binance.com'],
  coinbase: ['coinbase.com'],
  kraken: ['kraken.com'],
  metamask: ['metamask.io'],
  ledger: ['ledger.com'],
  trezor: ['trezor.io'],
  trustwallet: ['trustwallet.com'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  facebook: ['facebook.com', 'meta.com'],
  instagram: ['instagram.com'],
  twitter: ['twitter.com', 'x.com'],
  discord: ['discord.com', 'discord.gg'],
  telegram: ['telegram.org', 't.me'],
  dhl: ['dhl.com'],
  fedex: ['fedex.com'],
  ups: ['ups.com'],
  usps: ['usps.com'],
  dropbox: ['dropbox.com'],
  adobe: ['adobe.com']
};

export const AUTH_ACTION_KEYWORDS = new Set([
  'login', 'signin', 'sign-in', 'log-in', 'verify', 'verification',
  'security', 'account', 'authenticate', 'wallet', 'recover', 'recovery',
  'restore', 'update', 'billing', 'invoice', 'password', 'credential',
  'confirm', 'confirmation', 'unlock', 'support', 'helpdesk', 'validate'
]);

function severityFor(score: number): RiskSeverity {
  if (score >= 85) return 'malicious';
  if (score >= 65) return 'high';
  if (score >= 40) return 'medium';
  if (score >= 15) return 'low';
  return 'none';
}

export function makeRisk(
  score: number,
  reasons: string[],
  confidence: number,
  threatType: 'confirmed' | 'heuristic' = 'heuristic',
  threatSource?: string,
  signals?: ThreatSignal[]
): RiskResult {
  const clamped = Math.min(100, Math.max(0, Math.round(score)));
  return {
    score: clamped,
    severity: severityFor(clamped),
    reasons: reasons.slice(0, 16),
    confidence: Math.min(1, Math.max(0, confidence)),
    threatType,
    threatSource,
    signals
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
// Brand Impersonation & Phishing Pattern Detection
// ---------------------------------------------------------------------------

export interface BrandImpersonationResult {
  suspicious: boolean;
  brand?: string;
  actionKeyword?: string;
  score: number;
  reason?: string;
}

export function detectBrandKeywordImpersonation(urlStr: string, hostname: string): BrandImpersonationResult {
  const host = normalizeHostname(hostname);
  if (host.length === 0 || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    return { suspicious: false, score: 0 };
  }

  const base = registrableDomain(host);
  const hostLabels = host.split('.');
  const baseLabels = base.split('.');
  const primaryBaseLabel = baseLabels[0] ?? '';

  // Extract path and query tokens
  let pathAndQuery = '';
  try {
    const parsed = new URL(urlStr);
    pathAndQuery = `${parsed.pathname} ${parsed.search}`.toLowerCase();
  } catch {
    // retain empty
  }

  for (const [brand, authoritativeDomains] of Object.entries(PROTECTED_BRANDS)) {
    // Check if the current domain is legitimately owned by or authoritative for this brand
    const isAuthoritative = authoritativeDomains.some(
      (auth) => base === auth || base.endsWith(`.${auth}`) || host === auth || host.endsWith(`.${auth}`)
    );
    if (isAuthoritative) continue;

    // Check if brand name appears as a discrete label or token in the host
    // (Boundary check ensures 'pineapple.com' or 'grapple.com' does not match 'apple')
    const brandMatchesInHost = hostLabels.some(
      (lbl) => lbl === brand || lbl.startsWith(`${brand}-`) || lbl.endsWith(`-${brand}`) || lbl.includes(`-${brand}-`)
    );

    if (brandMatchesInHost) {
      // Find corroborating auth/action keywords in host or path
      let matchedKeyword = '';
      for (const kw of AUTH_ACTION_KEYWORDS) {
        if (
          primaryBaseLabel.includes(kw) ||
          host.includes(kw) ||
          pathAndQuery.includes(kw)
        ) {
          matchedKeyword = kw;
          break;
        }
      }

      if (matchedKeyword.length > 0) {
        return {
          suspicious: true,
          brand,
          actionKeyword: matchedKeyword,
          score: 70,
          reason: `Domain impersonates ${brand} with action keyword "${matchedKeyword}" on an unauthorized domain (${base})`
        };
      }

      // If the brand is the primary label of an unauthorized domain (e.g. paypal-portal.com or apple-device.net)
      if (primaryBaseLabel.includes(brand) && primaryBaseLabel !== brand) {
        return {
          suspicious: true,
          brand,
          score: 50,
          reason: `Domain uses lookalike brand identifier "${brand}" on an unauthorized registration (${base})`
        };
      }
    }
  }

  return { suspicious: false, score: 0 };
}

// ---------------------------------------------------------------------------
// Domain Structure Anomalies
// ---------------------------------------------------------------------------

export interface StructureAnomalyResult {
  suspicious: boolean;
  score: number;
  reasons: string[];
}

function isPrivateIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  const parts = ip.split('.').map(Number);
  if (parts.length === 4) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
  }
  return false;
}

export function detectDomainStructureAnomalies(urlStr: string, hostname: string): StructureAnomalyResult {
  const reasons: string[] = [];
  let score = 0;
  const host = normalizeHostname(hostname);

  // 1. Raw Public IP Address as Hostname
  const isIpv4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  if (isIpv4 && !isPrivateIp(host)) {
    const hasLoginContext = /login|signin|password|verify|account|wallet/i.test(urlStr);
    score += hasLoginContext ? 45 : 25;
    reasons.push(`Website host is a raw public IP address (${host}) rather than a registered domain`);
  }

  // 2. Embedded Credentials / Userinfo Exploit (e.g. https://google.com@evil.com)
  try {
    const parsed = new URL(urlStr);
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      score += 55;
      reasons.push('URL contains embedded user credentials or deceptive userinfo prefix (@) before hostname');
    }
  } catch {
    // retain
  }

  // 3. Excessive Hyphenation (3+ hyphens typical of disposable phishing kit domains)
  const base = registrableDomain(host);
  const hyphenCount = (base.match(/-/g) ?? []).length;
  if (hyphenCount >= 3) {
    score += 20;
    reasons.push(`Domain contains excessive hyphenation (${hyphenCount} hyphens), typical of disposable phishing kits`);
  }

  // 4. Excessive Subdomain Depth (4+ subdomains on an unknown non-top domain)
  const labels = host.split('.');
  if (labels.length >= 5 && !isIpv4 && !TOP_DOMAINS.includes(base) && !KNOWN_LEGITIMATE_DOMAINS.has(base)) {
    score += 20;
    reasons.push(`Hostname uses deeply nested subdomains (${labels.length} levels) to obscure the true domain`);
  }

  return {
    suspicious: score > 0,
    score,
    reasons
  };
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

export function isKnownSsoProvider(hostname: string): boolean {
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
// Aggregate Threat Assessment Engine
// ---------------------------------------------------------------------------

export interface HeuristicInput extends DomFeatures {}

export function assessThreat(input: HeuristicInput): RiskResult {
  const host = normalizeHostname(input.hostname);

  // 1. Check local curated threat intelligence (Abuse.ch URLhaus / verified phishing list)
  if (host.length > 0) {
    const intel = checkMaliciousIntelligence(host);
    if (intel.isKnownMalicious) {
      return makeRisk(
        95,
        [`Confirmed malicious domain in verified threat intelligence (${intel.matchedDomain ?? host})`],
        0.98,
        'confirmed',
        intel.source,
        [{ category: 'threat_intelligence', description: `Listed in verified community threat feed (${intel.source ?? 'URLhaus'})`, weight: 95 }]
      );
    }
  }

  // 2. Corroborating heuristic analysis
  const reasons: string[] = [];
  const signals: ThreatSignal[] = [];
  let score = 0;
  let strongSignals = 0;
  let weakSignals = 0;

  if (host.length > 0) {
    // A. Homoglyph & Punycode lookalike detection
    if (detectHomoglyph(host)) {
      score += 55;
      strongSignals += 1;
      const desc = 'Hostname uses look-alike Unicode characters (possible impersonation)';
      reasons.push(desc);
      signals.push({ category: 'homoglyph', description: desc, weight: 55 });
    }

    // B. Typosquatting against top popular domains
    const typo = typosquatCheck(host);
    if (typo.suspicious) {
      score += 50;
      strongSignals += 1;
      const desc = `Domain closely resembles the popular site ${typo.target}`;
      reasons.push(desc);
      signals.push({ category: 'typosquat', description: desc, weight: 50 });
    }

    // C. Deceptive Subdomains
    const deceptive = detectDeceptiveSubdomain(host);
    if (deceptive.suspicious && deceptive.target) {
      score += 55;
      strongSignals += 1;
      const desc = `Deceptive subdomain impersonating ${deceptive.target}`;
      reasons.push(desc);
      signals.push({ category: 'deceptive_subdomain', description: desc, weight: 55 });
    }

    // D. Brand Impersonation + Auth Keywords
    const brandImp = detectBrandKeywordImpersonation(input.url, host);
    if (brandImp.suspicious && brandImp.reason) {
      score += brandImp.score;
      strongSignals += 1;
      reasons.push(brandImp.reason);
      signals.push({ category: 'brand_impersonation', description: brandImp.reason, weight: brandImp.score });
    }

    // E. Domain Structure Anomalies
    const structure = detectDomainStructureAnomalies(input.url, host);
    if (structure.suspicious) {
      score += structure.score;
      if (structure.score >= 40) strongSignals += 1;
      else weakSignals += 1;
      reasons.push(...structure.reasons);
      for (const r of structure.reasons) {
        signals.push({ category: 'structure_anomaly', description: r, weight: structure.score });
      }
    }

    // F. Risky TLDs
    const tld = registrableDomain(host).split('.').pop() ?? '';
    if (RISKY_TLDS.has(tld)) {
      score += 20;
      weakSignals += 1;
      const desc = `Domain uses a high-risk ending (.${tld})`;
      reasons.push(desc);
      signals.push({ category: 'risky_tld', description: desc, weight: 20 });
    }
  }

  // G. Redirect Chain
  if (input.redirectChain !== undefined && input.redirectChain.length >= 2) {
    const redirect = scoreRedirectChain(input.redirectChain);
    score += redirect.score;
    if (redirect.score >= 40) strongSignals += 1;
    else if (redirect.reasons.length > 0) weakSignals += 1;
    reasons.push(...redirect.reasons);
    for (const r of redirect.reasons) {
      signals.push({ category: 'redirect_chain', description: r, weight: redirect.score });
    }
  }

  // H. Foreign Origin Login Form Submissions
  if (input.loginForms !== undefined && input.pageOrigin !== undefined && input.loginForms.length > 0) {
    const login = detectForeignLogin(input.pageOrigin, input.loginForms);
    score += login.score;
    if (login.score >= 40) strongSignals += 1;
    else if (login.reasons.length > 0) weakSignals += 1;
    reasons.push(...login.reasons);
    for (const r of login.reasons) {
      signals.push({ category: 'foreign_login', description: r, weight: login.score });
    }
  }

  // -------------------------------------------------------------------------
  // Corroboration Rule: NEVER block on a single weak signal!
  // If only a single weak signal fired (e.g. only a .xyz TLD), cap score at 20 (low risk).
  // -------------------------------------------------------------------------
  if (strongSignals === 0 && weakSignals <= 1) {
    score = Math.min(20, score);
  }

  const totalSignals = strongSignals + weakSignals;
  const confidence = totalSignals === 0
    ? 0.5
    : Math.min(0.95, 0.55 + strongSignals * 0.15 + weakSignals * 0.05);

  return makeRisk(score, reasons, confidence, 'heuristic', undefined, signals);
}
