import { describe, it, expect } from 'vitest';
import {
  calculatePrivacyScore,
  PRIVACY_LIMITATIONS
} from '../core/privacy-score/calculator.js';
import { computePrivacyScore, emptySnapshot } from '../core/stats/snapshot.js';
import { defaultSettings } from '../core/storage/schema.js';

describe('Transparent Privacy Score Engine', () => {
  const fullProtectionSettings = {
    masterEnabled: true,
    modules: {
      ads: true,
      trackers: true,
      cookies: true,
      heuristics: true,
      fingerprintShields: true,
      annoyances: true
    },
    preset: 'maximum'
  };

  describe('Un-Inflated Scoring & Defensive Posture', () => {
    it('awards a solid clean score (Grade A, ~90) for a clean site with all protections active', () => {
      const report = calculatePrivacyScore({
        settings: fullProtectionSettings,
        siteContext: {
          host: 'clean-site.org',
          paused: false,
          trackersBlocked: 0,
          trackersAllowed: 0
        }
      });

      // Defensive posture: 40, Clean site efficacy: 35, Exposure min: 20 -> 95 (A+)
      expect(report.score).toBeGreaterThanOrEqual(85);
      expect(report.score).toBeLessThanOrEqual(95);
      expect(report.grade).toMatch(/A\+?/);
      expect(report.breakdown.defensivePosture).toBe(40);
      expect(report.breakdown.exposureMinimization).toBe(20);
    });

    it('penalizes disabled protection heavily (Score <= 10, Grade F)', () => {
      const report = calculatePrivacyScore({
        settings: {
          masterEnabled: false,
          modules: fullProtectionSettings.modules,
          preset: 'basic'
        },
        siteContext: { host: 'example.com', paused: false }
      });

      expect(report.score).toBeLessThanOrEqual(10);
      expect(report.grade).toBe('F');
      expect(report.breakdown.defensivePosture).toBe(0);
      expect(report.breakdown.interceptionEfficacy).toBe(0);
      expect(report.breakdown.exposureMinimization).toBe(0);
    });

    it('penalizes paused sites heavily due to full tracker exposure', () => {
      const report = calculatePrivacyScore({
        settings: fullProtectionSettings,
        siteContext: {
          host: 'paused-site.com',
          paused: true,
          trackersAllowed: 8
        }
      });

      expect(report.score).toBeLessThanOrEqual(25);
      expect(report.grade).toBe('F');
      expect(report.breakdown.exposureMinimization).toBe(0);
      expect(report.activeDefenses).toContain('Site Protection Paused by User');
    });
  });

  describe('Interception Efficacy & Exposure Deductions', () => {
    it('calculates mathematically honest score when 100% of detected trackers are blocked', () => {
      const report = calculatePrivacyScore({
        settings: fullProtectionSettings,
        siteContext: {
          host: 'heavy-ad-portal.com',
          paused: false,
          trackersBlocked: 15,
          trackersAllowed: 0,
          cookiesCleaned: 5,
          paramsStripped: 3
        }
      });

      // 40 (posture) + 40 (100% block ratio) + 20 (zero allowed) = 100
      expect(report.score).toBe(100);
      expect(report.grade).toBe('A+');
      expect(report.breakdown.interceptionEfficacy).toBe(40);
      expect(report.metrics.trackersBlocked).toBe(15);
      expect(report.metrics.totalTrackersDetected).toBe(15);
    });

    it('deducts exposure score proportionally when trackers bypass or are allowed', () => {
      const report = calculatePrivacyScore({
        settings: fullProtectionSettings,
        siteContext: {
          host: 'leaky-site.example',
          paused: false,
          trackersBlocked: 6,
          trackersAllowed: 4 // 4 unblocked trackers
        }
      });

      // Block ratio = 6/10 = 0.6 -> Efficacy = round(40 * 0.6) = 24
      // Exposure = max(0, 20 - 4*5) = 0
      // Total = 40 + 24 + 0 = 64 (Grade C)
      expect(report.score).toBe(64);
      expect(report.grade).toBe('C');
      expect(report.breakdown.interceptionEfficacy).toBe(24);
      expect(report.breakdown.exposureMinimization).toBe(0);
    });
  });

  describe('Mandatory Disclosures & Limitations', () => {
    it('explicitly includes honesty disclosures refuting complete anonymity claims', () => {
      const report = calculatePrivacyScore({
        settings: fullProtectionSettings,
        siteContext: { host: 'test.com', paused: false }
      });

      expect(report.limitations.length).toBeGreaterThanOrEqual(4);
      expect(report.limitations.some((l) => l.includes('NOT provide complete anonymity'))).toBe(true);
      expect(report.limitations.some((l) => l.includes('First-party data collection'))).toBe(true);
      expect(report.limitations.some((l) => l.includes('outside the extension sandbox'))).toBe(true);
    });
  });

  describe('Backwards Compatibility with Snapshot Computation', () => {
    it('produces valid scores via computePrivacyScore legacy interface', () => {
      const snap = emptySnapshot('2026-11-01');
      snap.trackersBlocked = 12;
      snap.cookiesCleaned = 3;

      const score = computePrivacyScore(snap);
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    });
  });
});
