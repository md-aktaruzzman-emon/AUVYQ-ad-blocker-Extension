import { describe, it, expect } from 'vitest';
import {
  assessThreat,
  detectBrandKeywordImpersonation,
  detectDomainStructureAnomalies,
  detectHomoglyph,
  typosquatCheck,
  PROTECTED_BRANDS
} from '../core/heuristic/tier1.js';
import { checkMaliciousIntelligence, THREAT_FEED_METADATA } from '../core/threat-intelligence/intel.js';

describe('Advanced Phishing & Threat Detection Engine (Part 7)', () => {
  describe('Verified Local Threat Intelligence', () => {
    it('identifies confirmed malicious domains with high confidence (0.98) and confirmed threatType', () => {
      const knownMalicious = [
        'evil-stealer-harvest.xyz',
        'credential-harvest-login.top',
        'phishing-apple-verify.com',
        'account-verification-paypal.net',
        'malware-traffic-analysis.net'
      ];

      for (const domain of knownMalicious) {
        const intel = checkMaliciousIntelligence(domain);
        expect(intel.isKnownMalicious, `Expected ${domain} to match threat intel`).toBe(true);
        expect(intel.confidence).toBe(0.98);

        const assessment = assessThreat({ url: `https://${domain}/login`, hostname: domain });
        expect(assessment.score).toBeGreaterThanOrEqual(95);
        expect(assessment.severity).toBe('malicious');
        expect(assessment.threatType).toBe('confirmed');
        expect(assessment.reasons.some((r) => r.includes('verified threat intelligence'))).toBe(true);
      }
    });

    it('matches subdomains of confirmed malicious root domains', () => {
      const subHost = 'subdomain.phishing-apple-verify.com';
      const intel = checkMaliciousIntelligence(subHost);
      expect(intel.isKnownMalicious).toBe(true);
      expect(intel.matchedDomain).toBe('phishing-apple-verify.com');
    });

    it('returns valid threat feed metadata without remote network requests', () => {
      expect(THREAT_FEED_METADATA.totalCount).toBeGreaterThanOrEqual(30);
      expect(THREAT_FEED_METADATA.source).toContain('Threat Intelligence');
    });
  });

  describe('Brand Impersonation & Phishing Pattern Detection', () => {
    it('flags unauthorized domains combining protected brand names with auth/security keywords', () => {
      const phishingSamples = [
        { url: 'https://paypal-security-update.com/login', host: 'paypal-security-update.com', brand: 'paypal', kw: 'security' },
        { url: 'https://verify-apple-account.net/', host: 'verify-apple-account.net', brand: 'apple', kw: 'verify' },
        { url: 'https://chase-online-login.xyz/auth', host: 'chase-online-login.xyz', brand: 'chase', kw: 'login' },
        { url: 'https://binance-wallet-recovery.org/', host: 'binance-wallet-recovery.org', brand: 'binance', kw: 'wallet' },
        { url: 'https://microsoft-account-verify.info/', host: 'microsoft-account-verify.info', brand: 'microsoft', kw: 'account' }
      ];

      for (const sample of phishingSamples) {
        const check = detectBrandKeywordImpersonation(sample.url, sample.host);
        expect(check.suspicious, `Expected ${sample.host} to be flagged for impersonating ${sample.brand}`).toBe(true);
        expect(check.brand).toBe(sample.brand);
        expect(check.score).toBeGreaterThanOrEqual(50);

        const assessment = assessThreat({ url: sample.url, hostname: sample.host });
        expect(assessment.score).toBeGreaterThanOrEqual(60);
        expect(assessment.severity === 'high' || assessment.severity === 'malicious').toBe(true);
        expect(assessment.threatType).toBe('heuristic');
      }
    });

    it('strictly preserves authoritative domains owned by the brand', () => {
      const authoritativeSamples = [
        { url: 'https://www.paypal.com/signin', host: 'www.paypal.com' },
        { url: 'https://apple.com/account', host: 'apple.com' },
        { url: 'https://login.microsoftonline.com/common', host: 'login.microsoftonline.com' },
        { url: 'https://aws.amazon.com/console', host: 'aws.amazon.com' },
        { url: 'https://chase.com/secure/login', host: 'chase.com' }
      ];

      for (const sample of authoritativeSamples) {
        const check = detectBrandKeywordImpersonation(sample.url, sample.host);
        expect(check.suspicious, `Expected authoritative domain ${sample.host} NOT to be flagged as impersonator`).toBe(false);
      }
    });

    it('prevents false positives on dictionary words containing brand substrings (word boundary check)', () => {
      const dictionaryWords = [
        { url: 'https://pineapple.com/recipes', host: 'pineapple.com' }, // contains 'apple'
        { url: 'https://grapple.org/store', host: 'grapple.org' },       // contains 'apple'
        { url: 'https://chased.com/about', host: 'chased.com' }          // contains 'chase'
      ];

      for (const item of dictionaryWords) {
        const check = detectBrandKeywordImpersonation(item.url, item.host);
        expect(check.suspicious, `Expected word ${item.host} NOT to trigger brand impersonation`).toBe(false);
      }
    });
  });

  describe('Domain Structure Anomalies', () => {
    it('detects deceptive userinfo credential prefixes (@ symbol in authority)', () => {
      const deceptiveUrl = 'https://google.com@phishing-landing.xyz/auth';
      const result = detectDomainStructureAnomalies(deceptiveUrl, 'phishing-landing.xyz');
      expect(result.suspicious).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(50);
      expect(result.reasons.some((r) => r.includes('@'))).toBe(true);
    });

    it('penalizes public IP addresses used directly as hostnames with login paths', () => {
      const publicIpUrl = 'http://198.51.100.24/signin';
      const result = detectDomainStructureAnomalies(publicIpUrl, '198.51.100.24');
      expect(result.suspicious).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(40);
      expect(result.reasons.some((r) => r.includes('raw public IP'))).toBe(true);
    });

    it('does not penalize private, localhost, or link-local IP addresses', () => {
      const privateIps = ['127.0.0.1', '192.168.1.1', '10.0.0.1', '172.16.0.1'];
      for (const ip of privateIps) {
        const result = detectDomainStructureAnomalies(`http://${ip}:8080/app`, ip);
        expect(result.suspicious, `Private IP ${ip} must not be flagged`).toBe(false);
      }
    });

    it('detects disposable phishing kits with excessive hyphenation (3+ hyphens)', () => {
      const disposableDomain = 'account-security-update-verify-login.com';
      const result = detectDomainStructureAnomalies(`https://${disposableDomain}/`, disposableDomain);
      expect(result.suspicious).toBe(true);
      expect(result.reasons.some((r) => r.includes('excessive hyphenation'))).toBe(true);
    });

    it('detects deeply nested subdomains (5+ labels) obscuring the true domain', () => {
      const nestedHost = 'login.verify.account.portal.attacker.net';
      const result = detectDomainStructureAnomalies(`https://${nestedHost}/`, nestedHost);
      expect(result.suspicious).toBe(true);
      expect(result.reasons.some((r) => r.includes('nested subdomains'))).toBe(true);
    });
  });

  describe('Multi-Signal Corroboration & Zero-Block Weak Signal Rule', () => {
    it('NEVER flags or blocks a website based on a single weak signal (e.g. only a .xyz TLD)', () => {
      // Normal site on a modern TLD with no impersonation, no typosquats, no anomalies
      const techBlog = 'personal-portfolio.xyz';
      const result = assessThreat({ url: `https://${techBlog}/`, hostname: techBlog });

      // Score must be capped at 20, severity must be 'low' or 'none', NOT 'medium' or 'high'
      expect(result.score).toBeLessThanOrEqual(20);
      expect(result.severity === 'none' || result.severity === 'low').toBe(true);
    });

    it('escalates to high risk when multiple corroborating signals are present', () => {
      // Brand impersonation (60) + Risky TLD (20) = 80 -> High Risk
      const multiThreat = assessThreat({
        url: 'https://paypal-verify-account.xyz/login',
        hostname: 'paypal-verify-account.xyz'
      });

      expect(multiThreat.score).toBeGreaterThanOrEqual(70);
      expect(multiThreat.severity === 'high' || multiThreat.severity === 'malicious').toBe(true);
      expect(multiThreat.reasons.length).toBeGreaterThanOrEqual(2);
      expect(multiThreat.signals).toBeDefined();
      expect(multiThreat.signals?.length).toBeGreaterThanOrEqual(2);
    });
  });
});
