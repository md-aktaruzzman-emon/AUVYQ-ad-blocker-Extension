import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  validateCosmeticSelector,
  validateNetworkRule,
  validateCustomRuleInput,
  generateRuleId,
  exportCustomRules,
  importCustomRules,
  compileCustomNetworkRules,
  type CustomRule
} from '../core/rule-manager/custom-rules.js';
import {
  setSitePaused,
  isSitePaused,
  checkExpiredSitePauses
} from '../core/storage/settings.js';
import {
  buildBackupPayload,
  restoreBackupPayload,
  computePayloadDigest
} from '../core/backup/backup.js';
import { defaultSettings, CURRENT_SCHEMA_VERSION, STORAGE_KEYS, matchPreset } from '../core/storage/schema.js';

describe('Part 9: Advanced User Features & Product Engineering Suite', () => {

  // -------------------------------------------------------------------------
  // 1. Custom Rules & Selectors Validation (Task 2)
  // -------------------------------------------------------------------------
  describe('Custom Filter Rule Syntax Validation & Safety', () => {
    it('accepts well-formed, safe CSS cosmetic selectors', () => {
      const validCases = [
        '.ad-banner',
        '#promoted-post',
        'div[data-ad-slot="leaderboard"]',
        'section.sidebar > div.ad-unit',
        'article:has(span.sponsored)',
        'ytd-promoted-video-renderer'
      ];

      for (const sel of validCases) {
        const res = validateCosmeticSelector(sel);
        expect(res.valid, `Expected valid for "${sel}"`).toBe(true);
        expect(res.normalized).toBe(sel);
      }
    });

    it('strictly forbids root layout containers to prevent blanking websites', () => {
      const dangerousRootSelectors = [
        'html', 'body', ':root', 'head', 'main', '*',
        'html > body', 'body > *', 'body *', ':empty'
      ];

      for (const sel of dangerousRootSelectors) {
        const res = validateCosmeticSelector(sel);
        expect(res.valid, `Expected invalid for dangerous root "${sel}"`).toBe(false);
        expect(res.error).toMatch(/forbidden/i);
      }
    });

    it('rejects malformed selectors with unbalanced brackets or forbidden chars', () => {
      expect(validateCosmeticSelector('').valid).toBe(false);
      expect(validateCosmeticSelector('   ').valid).toBe(false);
      expect(validateCosmeticSelector('div[data-ad=').valid).toBe(false);
      expect(validateCosmeticSelector('div:has(span').valid).toBe(false);
      expect(validateCosmeticSelector('div { color: red }').valid).toBe(false);
      expect(validateCosmeticSelector('div <script>').valid).toBe(false);
    });

    it('validates custom network rules and rejects universal wildcards', () => {
      expect(validateNetworkRule('||adserver.example^').valid).toBe(true);
      expect(validateNetworkRule('@@||friendly-analytics.example^').valid).toBe(true);
      expect(validateNetworkRule('trackers.bad.com').valid).toBe(true);

      // Universal wildcards must be rejected
      expect(validateNetworkRule('*').valid).toBe(false);
      expect(validateNetworkRule('||*').valid).toBe(false);
      expect(validateNetworkRule('http*').valid).toBe(false);
      expect(validateNetworkRule('! comment line').valid).toBe(false);
    });

    it('validates regular expressions in custom network rules and rejects invalid syntax', () => {
      expect(validateNetworkRule('/^https?:\\/\\/.*\\.tracking\\.com\\//').valid).toBe(true);
      expect(validateNetworkRule('/(/').valid).toBe(false);
      expect(validateNetworkRule('/[a-z+/').valid).toBe(false);
      expect(validateNetworkRule('/*test/').valid).toBe(false);
    });

    it('generates unique collision-resistant rule IDs', () => {
      const id1 = generateRuleId();
      const id2 = generateRuleId();
      expect(id1).toMatch(/^cr_[a-z0-9]+_[a-z0-9]+$/);
      expect(id2).toMatch(/^cr_[a-z0-9]+_[a-z0-9]+$/);
      expect(id1).not.toBe(id2);
    });

    it('compiles user custom network rules with reserved user priority (9000-9999)', () => {
      const rules: CustomRule[] = [
        {
          id: 'cr_1',
          type: 'network',
          rawText: '||evil-tracker.example^',
          enabled: true,
          createdAt: Date.now()
        },
        {
          id: 'cr_2',
          type: 'network',
          rawText: '@@||allowed-site.example^',
          enabled: true,
          createdAt: Date.now()
        },
        {
          id: 'cr_3',
          type: 'network',
          rawText: '||disabled-tracker.example^',
          enabled: false,
          createdAt: Date.now()
        }
      ];

      const dnrRules = compileCustomNetworkRules(rules);
      expect(dnrRules.length).toBe(2);

      // Block rule: priority 9000
      expect(dnrRules[0].id).toBe(10000);
      expect(dnrRules[0].priority).toBe(9000);
      expect(dnrRules[0].action.type).toBe('block');
      expect(dnrRules[0].condition.urlFilter).toBe('||evil-tracker.example^');

      // Allow rule: priority 9500
      expect(dnrRules[1].id).toBe(10001);
      expect(dnrRules[1].priority).toBe(9500);
      expect(dnrRules[1].action.type).toBe('allow');
    });

    it('exports and imports custom rules in Adblock Plus and JSON formats', () => {
      const sampleRules: CustomRule[] = [
        {
          id: 'cr_101',
          type: 'cosmetic',
          domain: 'reddit.com',
          rawText: '.promotedlink',
          enabled: true,
          createdAt: 1730000000000
        },
        {
          id: 'cr_102',
          type: 'network',
          rawText: '||telemetry-beacon.org^',
          enabled: true,
          createdAt: 1730000000000
        }
      ];

      // 1. Text export
      const textExport = exportCustomRules(sampleRules, 'text');
      expect(textExport).toContain('reddit.com##.promotedlink');
      expect(textExport).toContain('||telemetry-beacon.org^');

      // 2. Text import
      const importedFromText = importCustomRules(textExport);
      expect(importedFromText.errors.length).toBe(0);
      expect(importedFromText.imported.length).toBe(2);
      expect(importedFromText.imported[0].type).toBe('cosmetic');
      expect(importedFromText.imported[0].domain).toBe('reddit.com');
      expect(importedFromText.imported[0].rawText).toBe('.promotedlink');
      expect(importedFromText.imported[1].type).toBe('network');

      // 3. JSON export & import
      const jsonExport = exportCustomRules(sampleRules, 'json');
      const importedFromJson = importCustomRules(jsonExport);
      expect(importedFromJson.errors.length).toBe(0);
      expect(importedFromJson.imported.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Website Protection Controls & Expiring Pause (Task 3)
  // -------------------------------------------------------------------------
  describe('Website Protection Controls with Expiring Alarm-Backed Pause', () => {
    it('sets site pause with optional expiration duration', () => {
      const initial = defaultSettings();
      const now = Date.now();

      // Pause for 15 minutes
      const paused15m = setSitePaused(initial, 'news.example.com', true, 15);
      const siteConfig = paused15m.perSite['news.example.com'];
      expect(siteConfig).toBeDefined();
      expect(siteConfig.paused).toBe(true);
      expect(typeof siteConfig.pausedUntil).toBe('number');
      expect(siteConfig.pausedUntil!).toBeGreaterThanOrEqual(now + 14 * 60 * 1000);
      expect(siteConfig.pausedUntil!).toBeLessThanOrEqual(now + 16 * 60 * 1000);

      // Verify isSitePaused recognizes active pause
      expect(isSitePaused(paused15m, 'news.example.com')).toBe(true);
    });

    it('automatically unpauses when the pause duration expires', () => {
      const settings = defaultSettings();
      const pastTimestamp = Date.now() - 5000; // Expired 5 seconds ago

      settings.perSite['expired.example.com'] = {
        paused: true,
        allowlist: [],
        pausedUntil: pastTimestamp
      };

      // isSitePaused returns false when expired
      expect(isSitePaused(settings, 'expired.example.com')).toBe(false);

      // checkExpiredSitePauses cleans up the entry
      const checkResult = checkExpiredSitePauses(settings);
      expect(checkResult.expiredHosts).toContain('expired.example.com');
      expect(checkResult.settings.perSite['expired.example.com'].paused).toBe(false);
      expect(checkResult.settings.perSite['expired.example.com'].pausedUntil).toBeNull();
    });

    it('unpauses immediately when toggled to resume', () => {
      let settings = defaultSettings();
      settings = setSitePaused(settings, 'shop.example.com', true, 60);
      expect(isSitePaused(settings, 'shop.example.com')).toBe(true);

      // Resume protection
      settings = setSitePaused(settings, 'shop.example.com', false);
      expect(isSitePaused(settings, 'shop.example.com')).toBe(false);
      expect(settings.perSite['shop.example.com'].pausedUntil).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Encrypted Vault Backup Schema v3 & Integrity Validation (Task 7)
  // -------------------------------------------------------------------------
  describe('Backup Payload Schema Version 3 & Integrity Verification', () => {
    let mockStorage: Record<string, unknown> = {};

    beforeEach(() => {
      mockStorage = {};
      (globalThis as unknown as { chrome: unknown }).chrome = {
        storage: {
          local: {
            get: vi.fn(async (keys: string[]) => {
              const res: Record<string, unknown> = {};
              for (const k of keys) {
                if (mockStorage[k] !== undefined) res[k] = mockStorage[k];
              }
              return res;
            }),
            set: vi.fn(async (items: Record<string, unknown>) => {
              Object.assign(mockStorage, items);
            })
          }
        }
      };
    });

    it('builds backup payload including Schema v3 metadata, integrity hash, and custom rules', async () => {
      mockStorage[STORAGE_KEYS.settings] = defaultSettings();
      mockStorage[STORAGE_KEYS.snapshots] = {
        '2026-11-01': {
          day: '2026-11-01',
          adsBlocked: 142,
          trackersBlocked: 56,
          paramsStripped: 18,
          cosmeticHidden: 33,
          threats: 1,
          cookiesCleaned: 12,
          updatedAt: Date.now()
        }
      };
      mockStorage[STORAGE_KEYS.threatLog] = [];
      mockStorage[STORAGE_KEYS.customRules] = [
        {
          id: 'cr_test_1',
          type: 'cosmetic',
          domain: 'portal.example',
          rawText: '.banner-ad',
          enabled: true,
          createdAt: Date.now()
        }
      ];

      const payloadString = await buildBackupPayload();
      expect(typeof payloadString).toBe('string');

      const parsed = JSON.parse(payloadString);
      // Top-level storage keys preserved
      expect(parsed[STORAGE_KEYS.settings]).toBeDefined();
      expect(parsed[STORAGE_KEYS.snapshots]).toBeDefined();
      expect(parsed[STORAGE_KEYS.customRules]).toBeDefined();

      // _meta envelope present
      expect(parsed._meta).toBeDefined();
      expect(parsed._meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(typeof parsed._meta.integrityHash).toBe('string');
      expect(parsed._meta.integrityHash.length).toBeGreaterThan(0);
    });

    it('restores backup payload and verifies integrity checksum', async () => {
      const initialSettings = defaultSettings();
      initialSettings.theme = 'light';

      const customRules: CustomRule[] = [
        {
          id: 'cr_restore_1',
          type: 'cosmetic',
          rawText: '#cookie-notice',
          enabled: true,
          createdAt: Date.now()
        }
      ];

      mockStorage = {
        [STORAGE_KEYS.settings]: initialSettings,
        [STORAGE_KEYS.customRules]: customRules
      };

      const payloadString = await buildBackupPayload();
      const parsed = JSON.parse(payloadString);

      // Clear storage
      mockStorage = {};

      let callbackInvoked = false;
      const result = await restoreBackupPayload(parsed, async () => {
        callbackInvoked = true;
      });

      expect(result.restored).toContain(STORAGE_KEYS.settings);
      expect(result.restored).toContain(STORAGE_KEYS.customRules);
      expect(callbackInvoked).toBe(true);

      // Verify restored storage contents
      expect(mockStorage[STORAGE_KEYS.settings]).toBeDefined();
      expect((mockStorage[STORAGE_KEYS.settings] as { theme: string }).theme).toBe('light');
      expect(Array.isArray(mockStorage[STORAGE_KEYS.customRules])).toBe(true);
    });

    it('strictly rejects tampered or corrupted backup payloads where integrity hash fails', async () => {
      mockStorage[STORAGE_KEYS.settings] = defaultSettings();
      const payloadString = await buildBackupPayload();
      const parsed = JSON.parse(payloadString);

      // Tamper with settings
      parsed[STORAGE_KEYS.settings].theme = 'dark';
      // Invalidate integrityHash
      parsed._meta.integrityHash = 'tampered_hash_00000000000000000000000000000000';

      await expect(restoreBackupPayload(parsed)).rejects.toThrow(/integrity verification failed/i);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Protection Profiles & Tier Mapping (Task 6)
  // -------------------------------------------------------------------------
  describe('Protection Profiles (Standard, Strict, Custom) Tier Mapping', () => {
    it('maps standard everyday modules cleanly to balanced preset', () => {
      const standardSettings = defaultSettings();
      expect(standardSettings.preset).toBe('balanced');
      expect(standardSettings.modules.ads).toBe(true);
      expect(standardSettings.modules.trackers).toBe(true);
      expect(standardSettings.modules.cookies).toBe(true);
      expect(standardSettings.modules.heuristics).toBe(true);
      expect(standardSettings.modules.annoyances).toBe(false);
      expect(standardSettings.modules.fingerprintShields).toBe(false);

      expect(matchPreset(standardSettings)).toBe('balanced');
    });

    it('maps strict high-security modules cleanly to maximum preset', () => {
      const strictSettings = defaultSettings();
      strictSettings.modules.ads = true;
      strictSettings.modules.trackers = true;
      strictSettings.modules.cookies = true;
      strictSettings.modules.heuristics = true;
      strictSettings.modules.annoyances = true;
      strictSettings.modules.fingerprintShields = true;
      strictSettings.fpShields = { canvas: true, webgl: true, navigator: true, screen: true, timing: true };

      expect(matchPreset(strictSettings)).toBe('maximum');
    });

    it('maps granular custom toggles cleanly to expert preset', () => {
      const customSettings = defaultSettings();
      customSettings.modules.ads = true;
      customSettings.modules.trackers = false; // Custom deviation
      customSettings.developerMode = true;

      expect(matchPreset(customSettings)).toBe('expert');
    });
  });
});
