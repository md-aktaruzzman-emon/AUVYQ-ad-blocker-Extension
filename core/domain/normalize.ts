/*
 * Domain normalization. No unsafe naive suffix matching anywhere in AUVYQ:
 * domain comparisons use label-boundary-aware helpers from this module.
 */

/** Returns the normalized, punycoded ASCII hostname, or '' when the input is not a valid hostname. */
export function normalizeHostname(hostname: string): string {
  if (typeof hostname !== 'string') return '';
  let candidate = hostname.trim().toLowerCase();
  if (candidate.length === 0 || candidate.length > 253) return '';
  // IPv6 literal: [::1] -> ::1
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    const inner = candidate.slice(1, -1);
    return isIpv6(inner) ? inner : '';
  }
  // Strip default ports only when part of an origin string was passed (defensive).
  candidate = candidate.replace(/:80$|:443$/, '');
  // Strip a single trailing dot (root).
  while (candidate.endsWith('.')) candidate = candidate.slice(0, -1);
  if (candidate.length === 0) return '';
  if (isIpv4(candidate)) return candidate;
  if (isIpv6(candidate)) return candidate;
  // Unicode / IDN -> punycode via the URL parser (standard-compliant, no hand-rolled IDNA).
  if (/[^\x00-\x7F]/.test(candidate) || candidate.includes('%')) {
    try {
      const parsed = new URL(`http://${candidate}`);
      candidate = parsed.hostname;
    } catch {
      return '';
    }
  }
  if (!/^[a-z0-9.-]+$/.test(candidate)) return '';
  const labels = candidate.split('.');
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return '';
  if (labels.some((l) => l.startsWith('-') || l.endsWith('-'))) return '';
  if (labels.some((l) => l.length > 63)) return '';
  return candidate;
}

export function isIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

export function isIpv6(value: string): boolean {
  return /^[0-9a-f:]+$/.test(value) && value.includes(':');
}

/**
 * Label-boundary-aware suffix match: `matchSuffix('evil.example.com', 'example.com')` is true,
 * but `matchSuffix('evilexample.com', 'example.com')` is false.
 */
export function matchSuffix(hostname: string, suffix: string): boolean {
  const host = normalizeHostname(hostname);
  const suf = normalizeHostname(suffix);
  if (host.length === 0 || suf.length === 0) return false;
  if (host === suf) return true;
  return host.endsWith(`.${suf}`);
}

/** Registrable-domain approximation: last two labels (or three for common ccTLD second-levels). */
const MULTIPART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'or.jp', 'ne.jp', 'com.au', 'net.au', 'org.au',
  'co.nz', 'com.br', 'com.mx', 'com.tr', 'com.cn', 'com.tw', 'co.in', 'co.za', 'com.sg', 'com.hk'
]);

export function registrableDomain(hostname: string): string {
  const host = normalizeHostname(hostname);
  if (host.length === 0 || isIpv4(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join('.');
  if (MULTIPART_SUFFIXES.has(lastTwo)) return labels.slice(-3).join('.');
  return lastTwo;
}

/** Safe host display form: punycode stays punycode; length capped. */
export function displayHost(hostname: string, maxLen = 64): string {
  const host = normalizeHostname(hostname);
  if (host.length <= maxLen) return host;
  return `${host.slice(0, maxLen - 1)}…`;
}

/**
 * Returns candidate domains from most-specific to least-specific (apex domain).
 * E.g., 'sub.example.com' -> ['sub.example.com', 'example.com'].
 */
export function getDomainCandidates(hostname: string): string[] {
  const host = normalizeHostname(hostname);
  if (host.length === 0 || isIpv4(host) || host.includes(':')) return host.length > 0 ? [host] : [];
  const labels = host.split('.');
  if (labels.length <= 2) return [host];
  const candidates: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) {
    candidates.push(labels.slice(i).join('.'));
  }
  return candidates;
}

