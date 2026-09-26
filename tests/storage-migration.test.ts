import { describe, it, expect } from 'vitest';
import { migrateStorage, detectVersion } from '../core/storage/migrate.js';
import { CURRENT_SCHEMA_VERSION, STORAGE_KEYS, defaultSettings } from '../core/storage/schema.js';
import type { Settings } from '../types/schemas.js';

describe('Storage Versioning & Migration', () => {
  it('migrates v1 schema (flat counters) to current schema version', () => {
    const v1State = {
      [STORAGE_KEYS.settings]: {
        preset: 'balanced',
        adsBlocked: 42,
        trackersBlocked: 17,
        paramsStripped: 5
      }
    };

    const { data, result } = migrateStorage(v1State);
    expect(result.migrated).toBe(true);
    expect(result.fromVersion).toBe(1);

    const settings = data[STORAGE_KEYS.settings] as Settings;
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(settings.preset).toBe('balanced');

    const snapshots = data[STORAGE_KEYS.snapshots] as Record<string, { adsBlocked: number }>;
    const keys = Object.keys(snapshots);
    expect(keys.length).toBe(1);
    expect(snapshots[keys[0]].adsBlocked).toBe(42);
  });

  it('migrates v2 schema with missing theme and fpShields safely', () => {
    const v2State = {
      [STORAGE_KEYS.settings]: {
        schemaVersion: 2,
        preset: 'strong',
        masterEnabled: true,
        modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: true },
        perSite: {},
        telemetryOptIn: false,
        logRetentionDays: 30,
        developerMode: false
      },
      [STORAGE_KEYS.snapshots]: {}
    };

    const { data, result } = migrateStorage(v2State);
    expect(result.migrated).toBe(true);
    const settings = data[STORAGE_KEYS.settings] as Settings;
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(settings.preset).toBe('strong');
    expect(settings.theme).toBe('system');
    expect(settings.fpShields).toBeDefined();
  });

  it('restores corrupted settings records to valid defaults with recorded repairs', () => {
    const corruptedState = {
      [STORAGE_KEYS.settings]: {
        schemaVersion: 'not-a-number',
        preset: 'invalid-preset-mode',
        masterEnabled: 'yes'
      }
    };

    const { data, result } = migrateStorage(corruptedState);
    expect(result.migrated).toBe(true);
    expect(result.repairs.length).toBeGreaterThan(0);

    const settings = data[STORAGE_KEYS.settings] as Settings;
    expect(settings.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(settings.preset).toBe('balanced');
    expect(settings.masterEnabled).toBe(true);
  });

  it('is idempotent: running migration twice on current state yields no additional modifications', () => {
    const initialState = {
      [STORAGE_KEYS.settings]: defaultSettings(),
      [STORAGE_KEYS.snapshots]: {}
    };

    const firstPass = migrateStorage(initialState);
    const secondPass = migrateStorage(firstPass.data);

    expect(secondPass.result.migrated).toBe(false);
    expect(secondPass.result.repairs.length).toBe(0);
    expect(secondPass.data).toEqual(firstPass.data);
  });
});
