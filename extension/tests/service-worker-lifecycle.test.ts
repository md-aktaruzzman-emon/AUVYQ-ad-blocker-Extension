import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ensureInitialized,
  ensureAlarms,
  syncNetworkBlocking,
  getCachedSettings,
  setCachedSettings,
  resetLifecycleForTesting,
  ALARMS,
  STATIC_RULESET_IDS,
  MASTER_ALLOW_RULE_ID
} from '../platform-chrome/lifecycle/lifecycle.js';
import {
  getTabThreat,
  setTabThreat,
  validateTabState,
  logThreat
} from '../platform-chrome/threat-manager/manager.js';
import { STORAGE_KEYS, defaultSettings } from '../core/storage/schema.js';
import { LIMITS } from '../core/validation/schemas.js';
import type { RiskResult, Settings } from '../types/schemas.js';

type AlarmInfo = { periodInMinutes?: number; delayInMinutes?: number; when?: number };

describe('MV3 Service Worker Lifecycle & Reliability', () => {
  let localStorageMock: Record<string, unknown> = {};
  let sessionStorageMock: Record<string, unknown> = {};
  let alarmsMock: Record<string, AlarmInfo> = {};
  let enabledRulesets: string[] = [];
  let sessionRules: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    resetLifecycleForTesting();
    localStorageMock = {};
    sessionStorageMock = {};
    alarmsMock = {};
    enabledRulesets = [];
    sessionRules = [];

    // Comprehensive Chrome MV3 API Mock
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: 'auvyq-test-extension-id',
        getURL: (p: string) => `chrome-extension://auvyq-test-extension-id/${p}`
      },
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (typeof keys === 'string') {
              return { [keys]: localStorageMock[keys] };
            }
            if (Array.isArray(keys)) {
              const res: Record<string, unknown> = {};
              for (const k of keys) {
                if (k in localStorageMock) res[k] = localStorageMock[k];
              }
              return res;
            }
            return { ...localStorageMock };
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(localStorageMock, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete localStorageMock[k];
          })
        },
        session: {
          get: vi.fn(async (keys?: string | string[]) => {
            if (typeof keys === 'string') {
              return { [keys]: sessionStorageMock[keys] };
            }
            if (Array.isArray(keys)) {
              const res: Record<string, unknown> = {};
              for (const k of keys) {
                if (k in sessionStorageMock) res[k] = sessionStorageMock[k];
              }
              return res;
            }
            return { ...sessionStorageMock };
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(sessionStorageMock, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete sessionStorageMock[k];
          })
        }
      },
      alarms: {
        create: vi.fn((name: string, info: AlarmInfo) => {
          alarmsMock[name] = info;
        })
      },
      declarativeNetRequest: {
        setExtensionActionOptions: vi.fn(async () => undefined),
        updateEnabledRulesets: vi.fn(async (options: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) => {
          if (options.enableRulesetIds) {
            for (const id of options.enableRulesetIds) {
              if (!enabledRulesets.includes(id)) enabledRulesets.push(id);
            }
          }
          if (options.disableRulesetIds) {
            enabledRulesets = enabledRulesets.filter((id) => !options.disableRulesetIds?.includes(id));
          }
        }),
        updateSessionRules: vi.fn(async (options: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }) => {
          sessionRules.push(options);
        }),
        getSessionRules: vi.fn(async () => [])
      },
      action: {
        setBadgeText: vi.fn(async () => undefined),
        setBadgeBackgroundColor: vi.fn(async () => undefined),
        setTitle: vi.fn(async () => undefined)
      },
      tabs: {
        sendMessage: vi.fn(async () => undefined),
        create: vi.fn(async () => ({} as chrome.tabs.Tab))
      }
    };
  });

  describe('Single-Flight Initialization Mutex', () => {
    it('initializes settings and caches them correctly', async () => {
      const initialSettings = defaultSettings();
      initialSettings.theme = 'dark';
      localStorageMock[STORAGE_KEYS.settings] = initialSettings;

      const loaded = await ensureInitialized();
      expect(loaded.theme).toBe('dark');
      expect(getCachedSettings()?.theme).toBe('dark');
    });

    it('deduplicates concurrent wakeups into a single initialization run', async () => {
      let settingsLoadCount = 0;
      const initialSettings = defaultSettings();
      localStorageMock[STORAGE_KEYS.settings] = initialSettings;
      localStorageMock[STORAGE_KEYS.snapshots] = {};

      const originalGet = chrome.storage.local.get;
      (chrome.storage.local.get as unknown) = vi.fn(async (k) => {
        if (Array.isArray(k) && k.includes(STORAGE_KEYS.settings)) {
          settingsLoadCount += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        return originalGet(k);
      });

      // Simulate 5 simultaneous tab openings or events waking the SW
      const promises = [
        ensureInitialized(),
        ensureInitialized(),
        ensureInitialized(),
        ensureInitialized(),
        ensureInitialized()
      ];

      const results = await Promise.all(promises);

      // All 5 promises receive identical settings instance
      expect(results.length).toBe(5);
      expect(results[0]).toBe(results[1]);
      expect(results[0]).toBe(results[4]);
      // Single-flight ensures only 1 initial storage fetch happened for settings
      expect(settingsLoadCount).toBe(1);
    });
  });

  describe('MV3 Alarm Idempotency', () => {
    it('registers all required periodic lifecycle alarms', async () => {
      await ensureAlarms();

      expect(alarmsMock).toHaveProperty(ALARMS.statsFlush);
      expect(alarmsMock).toHaveProperty(ALARMS.retention);
      expect(alarmsMock).toHaveProperty(ALARMS.offscreenIdle);
      expect(alarmsMock).toHaveProperty(ALARMS.updateCheck);
      expect(alarmsMock).toHaveProperty('auvyq-cookie-sweep');

      expect(alarmsMock[ALARMS.statsFlush].periodInMinutes).toBe(1);
      expect(alarmsMock[ALARMS.retention].periodInMinutes).toBe(360);
      expect(alarmsMock[ALARMS.updateCheck].periodInMinutes).toBe(720);
    });

    it('safely tolerates repeated calls without error', async () => {
      await ensureAlarms();
      await ensureAlarms();
      expect(Object.keys(alarmsMock).length).toBe(5);
    });
  });

  describe('DeclarativeNetRequest Ruleset & Session Rule Synchronization', () => {
    it('enables static DNR rulesets and clears master session allow rule when enabled', async () => {
      const settings = defaultSettings();
      settings.masterEnabled = true;
      settings.modules.ads = true;
      settings.modules.trackers = true;
      settings.modules.annoyances = true;

      await syncNetworkBlocking(true, settings);

      expect(enabledRulesets).toContain('main');
      expect(enabledRulesets).toContain('ads');
      expect(enabledRulesets).toContain('trackers');
      expect(enabledRulesets).toContain('annoyances');
      expect(enabledRulesets).toContain('ads-trackers');

      // Verifies removal of master allow rule (ID 30000)
      const lastSessionRuleCall = sessionRules[sessionRules.length - 1];
      expect(lastSessionRuleCall?.removeRuleIds).toContain(MASTER_ALLOW_RULE_ID);
      expect(lastSessionRuleCall?.addRules).toBeUndefined();
    });

    it('disables all static rulesets and installs master session allow rule when disabled', async () => {
      await syncNetworkBlocking(false);

      // Disables static rules
      for (const id of STATIC_RULESET_IDS) {
        expect(enabledRulesets).not.toContain(id);
      }

      // Master allow rule added to session rules
      const lastSessionRuleCall = sessionRules[sessionRules.length - 1];
      expect(lastSessionRuleCall?.removeRuleIds).toContain(MASTER_ALLOW_RULE_ID);
      expect(lastSessionRuleCall?.addRules).toBeDefined();
      expect(lastSessionRuleCall?.addRules?.[0]?.id).toBe(MASTER_ALLOW_RULE_ID);
      expect(lastSessionRuleCall?.addRules?.[0]?.priority).toBe(30000);
      expect(lastSessionRuleCall?.addRules?.[0]?.action?.type).toBe('allow');
    });
  });

  describe('Session Storage Tab Threat Management', () => {
    const sampleRisk: RiskResult = {
      score: 85,
      confidence: 0.95,
      reasons: ['High typosquatting distance against paypal.com'],
      severity: 'malicious'
    };

    it('sets, retrieves, and validates tab threat state in chrome.storage.session', async () => {
      const tabId = 42;
      await setTabThreat(tabId, { host: 'paypa1.example.com', risk: sampleRisk, stage: 'warned' });

      const threat = await getTabThreat(tabId);
      expect(threat).not.toBeNull();
      expect(threat?.host).toBe('paypa1.example.com');
      expect(threat?.risk.severity).toBe('malicious');
      expect(threat?.stage).toBe('warned');
    });

    it('cleans up tab threat state when tab is closed (state set to null)', async () => {
      const tabId = 42;
      await setTabThreat(tabId, { host: 'paypa1.example.com', risk: sampleRisk, stage: 'warned' });
      expect(await getTabThreat(tabId)).not.toBeNull();

      await setTabThreat(tabId, null);
      expect(await getTabThreat(tabId)).toBeNull();
      expect(sessionStorageMock[`${STORAGE_KEYS.tabThreats}:${tabId}`]).toBeUndefined();
    });

    it('gracefully handles and rejects corrupted session state data', () => {
      expect(validateTabState(null)).toBeNull();
      expect(validateTabState({})).toBeNull();
      expect(validateTabState({ host: 123, risk: sampleRisk })).toBeNull();
      expect(validateTabState({ host: 'example.com', risk: { score: 'not-a-num' }, stage: 'warned' })).toBeNull();
      expect(validateTabState({ host: 'example.com', risk: sampleRisk, stage: 'invalid-stage' })).toBeNull();
    });

    it('logs threats to chrome.storage.local capped at max limit (500)', async () => {
      const mockRecordStats = vi.fn(async () => undefined);

      // Pre-fill LIMITS.threatLogEntries (500) entries
      const existingEntries = Array.from({ length: LIMITS.threatLogEntries }, (_, i) => ({
        time: Date.now() - i * 1000,
        severity: 'medium' as const,
        host: `suspicious-${i}.example`,
        reason: 'Suspicious domain',
        action: 'warned' as const
      }));
      localStorageMock[STORAGE_KEYS.threatLog] = existingEntries;

      // Add 2 new threats
      await logThreat('threat1.example', sampleRisk, 'warned', mockRecordStats);
      await logThreat('threat2.example', sampleRisk, 'blocked', mockRecordStats);

      const saved = localStorageMock[STORAGE_KEYS.threatLog] as Array<{ host: string }>;
      expect(saved.length).toBe(LIMITS.threatLogEntries); // capped at LIMITS.threatLogEntries (500)
      expect(saved[0].host).toBe('threat2.example');
      expect(saved[1].host).toBe('threat1.example');
      expect(mockRecordStats).toHaveBeenCalledTimes(2);
    });
  });
});
