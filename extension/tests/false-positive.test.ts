import { describe, it, expect, vi, beforeEach } from 'vitest';
import { assessThreat } from '../core/heuristic/tier1.js';
import {
  assessNavigation,
  handleThreatAction,
  checkLoginForms,
  getTabThreat,
  setTabThreat
} from '../platform-chrome/threat-manager/manager.js';
import { defaultSettings } from '../core/storage/schema.js';
import { setSiteAllowlisted, isSiteAllowlisted } from '../core/storage/settings.js';
import type { Settings } from '../types/schemas.js';

describe('False Positive Prevention & Allowlist Management (Part 7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Benchmark Dataset: Zero False Positives on Safe Web Traffic', () => {
    const popularSafeWebsites = [
      'google.com',
      'youtube.com',
      'wikipedia.org',
      'github.com',
      'reddit.com',
      'amazon.com',
      'apple.com',
      'microsoft.com',
      'netflix.com',
      'twitter.com',
      'x.com',
      'bbc.com',
      'theguardian.com',
      'nytimes.com',
      'cnn.com',
      'chase.com',
      'bankofamerica.com',
      'wellsfargo.com',
      'spotify.com',
      'twitch.tv'
    ];

    it('achieves 0% false positive rate across the top 20 verified websites', () => {
      let falsePositives = 0;
      for (const host of popularSafeWebsites) {
        const assessment = assessThreat({ url: `https://${host}/`, hostname: host });
        if (assessment.severity === 'high' || assessment.severity === 'malicious') {
          falsePositives += 1;
        }
        expect(assessment.severity, `Safe domain ${host} must not trigger threat warning`).toBe('none');
        expect(assessment.score).toBeLessThan(40);
      }
      expect(falsePositives).toBe(0);
    });

    it('safely handles legitimate tech blogs and indie projects on modern TLDs (.xyz, .top, .io, .dev)', () => {
      const modernTldSites = [
        'developer-notes.io',
        'my-portfolio-showcase.xyz',
        'indie-creator.top',
        'design-system.dev',
        'docs.mysoftware.app'
      ];

      for (const host of modernTldSites) {
        const assessment = assessThreat({ url: `https://${host}/`, hostname: host });
        expect(assessment.severity === 'high' || assessment.severity === 'malicious',
          `Safe modern TLD domain ${host} should not be high risk`).toBe(false);
        expect(assessment.score).toBeLessThanOrEqual(20);
      }
    });

    it('safely handles deep corporate enterprise subdomains', () => {
      const enterpriseHosts = [
        'portal.dev.internal.aws.amazon.com',
        'console.cloud.google.com',
        'us-east-1.console.aws.amazon.com',
        'auth.corp.internal.apple.com'
      ];

      for (const host of enterpriseHosts) {
        const assessment = assessThreat({ url: `https://${host}/dashboard`, hostname: host });
        expect(assessment.severity).toBe('none');
        expect(assessment.score).toBeLessThan(40);
      }
    });
  });

  describe('User Allowlist & Exception Management', () => {
    it('sets and checks per-site allowlist status reliably in Settings', () => {
      const settings = defaultSettings();
      const testHost = 'custom-internal-portal.corp';

      expect(isSiteAllowlisted(settings, testHost)).toBe(false);

      const allowlistedSettings = setSiteAllowlisted(settings, testHost, true);
      expect(isSiteAllowlisted(allowlistedSettings, testHost)).toBe(true);

      const revokedSettings = setSiteAllowlisted(allowlistedSettings, testHost, false);
      expect(isSiteAllowlisted(revokedSettings, testHost)).toBe(false);
    });

    it('suppresses threat warning banners when navigating to an allowlisted site', async () => {
      const sendMessageSpy = vi.fn(async () => ({}));
      const sessionStore: Record<string, string> = {};

      (globalThis as unknown as { chrome: unknown }).chrome = {
        tabs: { sendMessage: sendMessageSpy, update: vi.fn() },
        storage: {
          session: {
            get: vi.fn(async (key: string) => ({ [key]: sessionStore[key] })),
            set: vi.fn(async (items: Record<string, string>) => { Object.assign(sessionStore, items); }),
            remove: vi.fn(async (key: string) => { delete sessionStore[key]; })
          },
          local: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {})
          }
        }
      };

      const suspiciousHost = 'suspicious-looking-site.xyz';
      const allowlistedSettings: Settings = setSiteAllowlisted(defaultSettings(), suspiciousHost, true);

      // Attempt navigation assessment
      await assessNavigation(101, `https://${suspiciousHost}/`, allowlistedSettings);

      // Warning message must NOT be sent to the tab
      expect(sendMessageSpy).not.toHaveBeenCalled();
    });

    it('suppresses checkLoginForms when origin is allowlisted', async () => {
      const suspiciousOrigin = 'https://suspicious-intranet.xyz';
      const suspiciousHost = 'suspicious-intranet.xyz';
      const allowlistedSettings: Settings = setSiteAllowlisted(defaultSettings(), suspiciousHost, true);

      const forms = [{ actionOrigin: 'https://foreign-collector.test/auth', hasPasswordField: true }];
      const result = await checkLoginForms(suspiciousOrigin, forms, 102, allowlistedSettings);

      expect(result.risk.severity).toBe('none');
      expect(result.risk.score).toBe(0);
    });
  });

  describe('False Positive Reporting & Action Dispatch', () => {
    it('handles "report_false_positive" action and transitions tab stage to acknowledged', async () => {
      const sessionStore: Record<string, string> = {};
      const localStore: Record<string, unknown> = {};

      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: {
          session: {
            get: vi.fn(async (k: string) => ({ [k]: sessionStore[k] })),
            set: vi.fn(async (items: Record<string, string>) => { Object.assign(sessionStore, items); }),
            remove: vi.fn(async (k: string) => { delete sessionStore[k]; })
          },
          local: {
            get: vi.fn(async (k: string) => ({ [k]: localStore[k] })),
            set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(localStore, items); })
          }
        }
      };

      const tabId = 205;
      const host = 'innocent-developer-tool.xyz';
      await setTabThreat(tabId, {
        host,
        risk: { score: 65, severity: 'high', reasons: ['Brand lookalike'], confidence: 0.8 },
        stage: 'warned'
      });

      const outcome = await handleThreatAction(tabId, 'report_false_positive');
      expect(outcome.ok).toBe(true);
      expect(outcome.reported).toBe(true);

      const updated = await getTabThreat(tabId);
      expect(updated?.stage).toBe('acknowledged');
    });

    it('handles "allowlist" action and permanently preserves user exception', async () => {
      const sessionStore: Record<string, string> = {};
      const localStore: Record<string, unknown> = {};
      let allowlistHostCaptured = '';

      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: {
          session: {
            get: vi.fn(async (k: string) => ({ [k]: sessionStore[k] })),
            set: vi.fn(async (items: Record<string, string>) => { Object.assign(sessionStore, items); }),
            remove: vi.fn(async (k: string) => { delete sessionStore[k]; })
          },
          local: {
            get: vi.fn(async (k: string) => ({ [k]: localStore[k] })),
            set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(localStore, items); })
          }
        }
      };

      const tabId = 206;
      const host = 'partner-vendor-login.top';
      await setTabThreat(tabId, {
        host,
        risk: { score: 60, severity: 'high', reasons: ['Suspicious domain'], confidence: 0.75 },
        stage: 'warned'
      });

      const outcome = await handleThreatAction(
        tabId,
        'allowlist',
        undefined,
        async (hostToAllow) => {
          allowlistHostCaptured = hostToAllow;
        }
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.allowlisted).toBe(true);
      expect(allowlistHostCaptured).toBe(host);

      const updated = await getTabThreat(tabId);
      expect(updated?.stage).toBe('acknowledged');
    });
  });
});
