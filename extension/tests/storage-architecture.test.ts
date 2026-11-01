import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadSettings } from '../core/storage/settings.js';
import { buildBackupPayload, restoreBackupPayload } from '../core/backup/backup.js';
import { STORAGE_KEYS, CURRENT_SCHEMA_VERSION, defaultSettings } from '../core/storage/schema.js';
import type { Settings } from '../types/schemas.js';

describe('Storage Architecture, Persistence & Atomic Backup Suite', () => {
  let localStorageMock: Record<string, unknown> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorageMock = {};

    (globalThis as unknown as { chrome: unknown }).chrome = {
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
          })
        }
      }
    };
  });

  describe('Storage Migration Write-Back Persistence', () => {
    it('persists upgraded v3 schema back to disk when loading legacy v1 state', async () => {
      // Legacy v1 flat structure
      localStorageMock[STORAGE_KEYS.settings] = {
        preset: 'balanced',
        adsBlocked: 42,
        trackersBlocked: 17
      };

      const setSpy = vi.spyOn(chrome.storage.local, 'set');

      const settings = await loadSettings();

      // Verified returned settings has updated schema version
      expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(settings.preset).toBe('balanced');

      // Crucial: chrome.storage.local.set was called to persist the migrated state
      expect(setSpy).toHaveBeenCalled();
      const persistedSettings = localStorageMock[STORAGE_KEYS.settings] as Settings;
      expect(persistedSettings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(localStorageMock[STORAGE_KEYS.snapshots]).toBeDefined();
    });

    it('does not trigger redundant write-backs when settings and snapshots are already on current schema', async () => {
      const current = defaultSettings();
      localStorageMock[STORAGE_KEYS.settings] = current;
      localStorageMock[STORAGE_KEYS.snapshots] = {};

      const setSpy = vi.spyOn(chrome.storage.local, 'set');
      const loaded = await loadSettings();

      expect(loaded.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  describe('Atomic Backup Export', () => {
    it('serializes settings, snapshots, and threat logs into a complete JSON string', async () => {
      const settings = defaultSettings();
      const snapshots = {
        '2026-10-31': {
          day: '2026-10-31',
          adsBlocked: 10,
          trackersBlocked: 5,
          paramsStripped: 0,
          cosmeticHidden: 0,
          threats: 0,
          cookiesCleaned: 2,
          updatedAt: Date.now()
        }
      };
      const threatLog = [
        { time: 1700000000000, severity: 'high', host: 'bad.example', reason: 'Typosquat', action: 'blocked' }
      ];

      localStorageMock[STORAGE_KEYS.settings] = settings;
      localStorageMock[STORAGE_KEYS.snapshots] = snapshots;
      localStorageMock[STORAGE_KEYS.threatLog] = threatLog;

      const payloadString = await buildBackupPayload();
      expect(typeof payloadString).toBe('string');

      const parsed = JSON.parse(payloadString);
      expect(parsed[STORAGE_KEYS.settings].schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(parsed[STORAGE_KEYS.snapshots]['2026-10-31'].adsBlocked).toBe(10);
      expect(parsed[STORAGE_KEYS.threatLog][0].host).toBe('bad.example');
    });
  });

  describe('Atomic Backup Restore & Schema Validation', () => {
    it('successfully restores valid backup and invokes callback', async () => {
      const backupSettings = defaultSettings();
      backupSettings.theme = 'light';
      backupSettings.preset = 'strong';

      const backupData = {
        [STORAGE_KEYS.settings]: backupSettings,
        [STORAGE_KEYS.snapshots]: {
          '2026-11-01': {
            day: '2026-11-01',
            adsBlocked: 50,
            trackersBlocked: 20,
            paramsStripped: 0,
            cosmeticHidden: 0,
            threats: 1,
            cookiesCleaned: 0,
            updatedAt: Date.now()
          }
        },
        [STORAGE_KEYS.threatLog]: []
      };

      const callback = vi.fn(async () => undefined);
      const res = await restoreBackupPayload(backupData, callback);

      expect(res.restored).toContain(STORAGE_KEYS.settings);
      expect(res.restored).toContain(STORAGE_KEYS.snapshots);
      expect(res.restored).toContain(STORAGE_KEYS.threatLog);

      expect((localStorageMock[STORAGE_KEYS.settings] as Settings).theme).toBe('light');
      expect((localStorageMock[STORAGE_KEYS.settings] as Settings).preset).toBe('strong');
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ preset: 'strong', theme: 'light' }));
    });

    it('atomically rejects backup with corrupted settings and preserves existing state', async () => {
      // Existing clean state
      const cleanSettings = defaultSettings();
      cleanSettings.theme = 'dark';
      localStorageMock[STORAGE_KEYS.settings] = cleanSettings;

      const setSpy = vi.spyOn(chrome.storage.local, 'set');

      const invalidPayload = {
        [STORAGE_KEYS.settings]: {
          schemaVersion: 'invalid', // Schema validation failure!
          preset: 12345
        }
      };

      await expect(restoreBackupPayload(invalidPayload)).rejects.toThrow('backup settings failed validation');

      // Storage write must NOT have been called
      expect(setSpy).not.toHaveBeenCalled();
      // Existing data intact
      expect((localStorageMock[STORAGE_KEYS.settings] as Settings).theme).toBe('dark');
    });

    it('atomically rejects backup with corrupted snapshot metrics', async () => {
      const validSettings = defaultSettings();
      const invalidSnapshotPayload = {
        [STORAGE_KEYS.settings]: validSettings,
        [STORAGE_KEYS.snapshots]: {
          '2026-11-01': { adsBlocked: -999 } // Invalid negative number!
        }
      };

      const setSpy = vi.spyOn(chrome.storage.local, 'set');

      await expect(restoreBackupPayload(invalidSnapshotPayload)).rejects.toThrow('backup snapshot for 2026-11-01 failed validation');
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('atomically rejects backup with malformed threat log entries', async () => {
      const validSettings = defaultSettings();
      const invalidThreatPayload = {
        [STORAGE_KEYS.settings]: validSettings,
        [STORAGE_KEYS.threatLog]: [
          { host: 'not-enough-fields' } // Missing time, severity, reason, action
        ]
      };

      const setSpy = vi.spyOn(chrome.storage.local, 'set');

      await expect(restoreBackupPayload(invalidThreatPayload)).rejects.toThrow('backup threat log entry failed validation');
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('rejects non-object backup inputs', async () => {
      await expect(restoreBackupPayload('not-json-object')).rejects.toThrow('backup payload is not an object');
      await expect(restoreBackupPayload(null)).rejects.toThrow('backup payload is not an object');
      await expect(restoreBackupPayload(12345)).rejects.toThrow('backup payload is not an object');
    });
  });
});
