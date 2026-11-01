/*
 * AUVYQ Verified Threat Intelligence Engine.
 * Local-first, zero-telemetry threat lookup against curated and signed community feeds.
 * Sources: Abuse.ch URLhaus, community phishing feeds. No remote code execution.
 */
import maliciousData from '../../data/malicious-domains.json';
import { normalizeHostname, registrableDomain } from '../domain/normalize.js';

export interface ThreatIntelResult {
  isKnownMalicious: boolean;
  source?: string;
  category?: 'malware' | 'phishing' | 'scam' | 'credential_harvesting';
  confidence: number;
  matchedDomain?: string;
}

const MALICIOUS_DOMAINS_SET: ReadonlySet<string> = new Set(
  Array.isArray(maliciousData?.domains)
    ? maliciousData.domains.map((d: string) => normalizeHostname(d)).filter((d: string) => d.length > 0)
    : []
);

export const THREAT_FEED_METADATA = {
  version: maliciousData?.version ?? 'unknown',
  source: maliciousData?.source ?? 'Local Verified Threat Intelligence',
  updatedAt: maliciousData?.updatedAt ?? 'unknown',
  totalCount: MALICIOUS_DOMAINS_SET.size
};

/**
 * Checks a hostname against verified threat intelligence.
 * Evaluates exact hostname and registrable base domain.
 * $O(1)$ lookup with zero external network requests.
 */
export function checkMaliciousIntelligence(hostname: string): ThreatIntelResult {
  const norm = normalizeHostname(hostname);
  if (norm.length === 0) {
    return { isKnownMalicious: false, confidence: 0 };
  }

  // 1. Direct match on full hostname
  if (MALICIOUS_DOMAINS_SET.has(norm)) {
    return {
      isKnownMalicious: true,
      source: THREAT_FEED_METADATA.source,
      category: 'phishing',
      confidence: 0.98,
      matchedDomain: norm
    };
  }

  // 2. Match on registrable domain (e.g. sub.evil-stealer-harvest.xyz)
  const base = registrableDomain(norm);
  if (base.length > 0 && MALICIOUS_DOMAINS_SET.has(base)) {
    return {
      isKnownMalicious: true,
      source: THREAT_FEED_METADATA.source,
      category: 'phishing',
      confidence: 0.98,
      matchedDomain: base
    };
  }

  return { isKnownMalicious: false, confidence: 0 };
}
