import { describe, it, expect } from 'vitest';
import {
  detectHomoglyph,
  damerauLevenshtein,
  typosquatCheck,
  scoreRedirectChain,
  detectForeignLogin,
  assessThreat
} from '../core/heuristic/tier1.js';

describe('Heuristic Threat Engine (Tier 1)', () => {
  it('calculates Damerau-Levenshtein edit distance including transpositions', () => {
    expect(damerauLevenshtein('google', 'google')).toBe(0);
    expect(damerauLevenshtein('goolge', 'google')).toBe(1); // transposition
    expect(damerauLevenshtein('goog1e', 'google')).toBe(1); // substitution
    expect(damerauLevenshtein('gogle', 'google')).toBe(1);  // deletion
    expect(damerauLevenshtein('facebook', 'faceboko')).toBe(1); // transposition
  });

  it('detects typosquatting against bundled popular domains', () => {
    const check1 = typosquatCheck('paypa1.com');
    expect(check1.suspicious).toBe(true);
    expect(check1.target).toBe('paypal.com');

    const check2 = typosquatCheck('goolge.com');
    expect(check2.suspicious).toBe(true);
    expect(check2.target).toBe('google.com');

    // Exact match is not typosquatted
    expect(typosquatCheck('google.com').suspicious).toBe(false);
  });

  it('detects mixed-script homoglyphs and punycode domains', () => {
    // Punycode domain
    expect(detectHomoglyph('xn--pple-43d.com')).toBe(true);

    // Mixed Latin and Cyrillic (e.g. Cyrillic 'а' in 'pаypal')
    const cyrillicA = '\u0430';
    const homoglyphHost = `p${cyrillicA}ypal.com`;
    expect(detectHomoglyph(homoglyphHost)).toBe(true);

    // Pure Latin is not homoglyph
    expect(detectHomoglyph('paypal.com')).toBe(false);
  });

  it('scores redirect chains and penalizes long chains or cross-domain jumps to risky TLDs', () => {
    const singleHop = [{ url: 'https://example.com/landing' }];
    expect(scoreRedirectChain(singleHop).score).toBe(0);

    const safeChain = [
      { url: 'https://mysite.com/a' },
      { url: 'https://mysite.com/b' }
    ];
    expect(scoreRedirectChain(safeChain).score).toBe(0);

    const suspiciousChain = [
      { url: 'https://short.link/123' },
      { url: 'https://tracker-hop1.test/a' },
      { url: 'https://tracker-hop2.test/b' },
      { url: 'https://phishing-landing.xyz/login' }
    ];
    const assessment = scoreRedirectChain(suspiciousChain);
    expect(assessment.score).toBeGreaterThanOrEqual(40);
    expect(assessment.reasons.length).toBeGreaterThan(0);
  });

  it('detects suspicious foreign-origin password form submissions', () => {
    const pageOrigin = 'https://mybank-portal.example';
    const normalForm = [{ actionOrigin: 'https://mybank-portal.example/auth', hasPasswordField: true }];
    expect(detectForeignLogin(pageOrigin, normalForm).score).toBe(0);

    const suspiciousForeign = [{ actionOrigin: 'https://credential-stealer.xyz/harvest', hasPasswordField: true }];
    const detected = detectForeignLogin(pageOrigin, suspiciousForeign);
    expect(detected.score).toBe(70);
    expect(detected.reasons.length).toBeGreaterThan(0);
  });

  it('aggregates threat signals into a comprehensive RiskResult', () => {
    const result = assessThreat({
      url: 'https://paypa1.com/login',
      hostname: 'paypa1.com',
      pageOrigin: 'https://paypa1.com',
      loginForms: [{ actionOrigin: 'https://evil-harvest.xyz/collect', hasPasswordField: true }]
    });

    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.severity === 'high' || result.severity === 'malicious').toBe(true);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.confidence).toBeGreaterThan(0.7);
  });
});
