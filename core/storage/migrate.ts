/*
 * Deterministic, idempotent, crash-safe storage migration: v1 -> v2 -> v3 -> current.
 * Corrupted records are restored to defaults for that key; unknown state is never erased.
 */
import { CURRENT_SCHEMA_VERSION, defaultSettings, STORAGE_KEYS } from './schema.js';
import { validateSettings, validateSnapshot, isRecord } from '../validation/schemas.js';
import type { Settings, Snapshot } from '../../types/schemas.js';

export interface MigrationResult {
  migrated: boolean;
  fromVersion: number;
  repairs: string[];
}

interface LegacyV1Counters {
  adsBlocked?: unknown;
  trackersBlocked?: unknown;
  paramsStripped?: unknown;
  cosmeticHidden?: unknown;
  threats?: unknown;
  cookiesCleaned?: unknown;
}

function toSafeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function todayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Migrates a raw `chrome.storage.local` snapshot forward. Pure: the caller persists the result.
 * Never throws; every failure mode degrades to defaults with a recorded repair.
 */
export function migrateStorage(raw: Record<string, unknown>, now = new Date()): { data: Record<string, unknown>; result: MigrationResult } {
  const repairs: string[] = [];
  const data: Record<string, unknown> = { ...raw };
  const detected = detectVersion(data);
  let fromVersion = detected;

  if (fromVersion === 1) {
    // v1 stored flat counters on the settings record itself.
    const counters = data[STORAGE_KEYS.settings] as LegacyV1Counters | undefined;
    const day = todayKey(now);
    const snapshot: Snapshot = {
      day,
      adsBlocked: toSafeCount(counters?.['adsBlocked']),
      trackersBlocked: toSafeCount(counters?.['trackersBlocked']),
      paramsStripped: toSafeCount(counters?.['paramsStripped']),
      cosmeticHidden: toSafeCount(counters?.['cosmeticHidden']),
      threats: toSafeCount(counters?.['threats']),
      cookiesCleaned: toSafeCount(counters?.['cookiesCleaned']),
      updatedAt: now.getTime()
    };
    data[STORAGE_KEYS.snapshots] = { [day]: snapshot };
    data[STORAGE_KEYS.settings] = { preset: 'balanced' };
    repairs.push('v1->v2: counters moved to snapshots map');
    fromVersion = 2;
  }

  if (fromVersion === 2) {
    // v2 lacked theme / fpShields defaults and schemaVersion.
    const rawSettings = data[STORAGE_KEYS.settings];
    if (isRecord(rawSettings)) {
      const base = defaultSettings();
      const preset = typeof rawSettings['preset'] === 'string' && ['basic', 'balanced', 'strong', 'maximum', 'expert'].includes(rawSettings['preset'])
        ? rawSettings['preset']
        : base.preset;
      const masterEnabled = typeof rawSettings['masterEnabled'] === 'boolean' ? rawSettings['masterEnabled'] : base.masterEnabled;
      const modules = isRecord(rawSettings['modules']) ? { ...base.modules, ...rawSettings['modules'] } : base.modules;
      const perSite = isRecord(rawSettings['perSite']) ? rawSettings['perSite'] : base.perSite;
      const theme = rawSettings['theme'] === 'light' || rawSettings['theme'] === 'dark' || rawSettings['theme'] === 'system'
        ? rawSettings['theme']
        : 'system';
      const fpShields = isRecord(rawSettings['fpShields']) ? { ...base.fpShields, ...rawSettings['fpShields'] } : base.fpShields;
      const logRetentionDays = rawSettings['logRetentionDays'] === 7 || rawSettings['logRetentionDays'] === 30
        ? rawSettings['logRetentionDays']
        : 7;
      const developerMode = typeof rawSettings['developerMode'] === 'boolean' ? rawSettings['developerMode'] : false;
      const telemetryOptIn = typeof rawSettings['telemetryOptIn'] === 'boolean' ? rawSettings['telemetryOptIn'] : false;

      const v3: Settings = {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        preset: preset as Settings['preset'],
        masterEnabled,
        modules: modules as Settings['modules'],
        perSite: perSite as Settings['perSite'],
        theme: theme as Settings['theme'],
        fpShields: fpShields as Settings['fpShields'],
        logRetentionDays: logRetentionDays as Settings['logRetentionDays'],
        developerMode,
        telemetryOptIn
      };
      data[STORAGE_KEYS.settings] = v3;
      repairs.push('v2->v3: theme and fpShields defaults applied');
    } else {
      data[STORAGE_KEYS.settings] = defaultSettings();
      repairs.push('v2->v3: settings corrupted, restored defaults');
    }
    fromVersion = 3;
  }

  // Final validation pass at the current version.
  const finalSettings = validateSettings(data[STORAGE_KEYS.settings]);
  if (finalSettings.ok) {
    finalSettings.value.schemaVersion = CURRENT_SCHEMA_VERSION;
    data[STORAGE_KEYS.settings] = finalSettings.value;
  } else {
    data[STORAGE_KEYS.settings] = defaultSettings();
    repairs.push('final: settings restored to defaults');
  }

  const snapshots = data[STORAGE_KEYS.snapshots];
  if (isRecord(snapshots)) {
    const clean: Record<string, Snapshot> = {};
    for (const [day, value] of Object.entries(snapshots)) {
      const snap = validateSnapshot(value);
      if (snap.ok) clean[day] = snap.value;
      else repairs.push(`final: dropped corrupted snapshot for ${day}`);
    }
    data[STORAGE_KEYS.snapshots] = clean;
  } else {
    data[STORAGE_KEYS.snapshots] = {};
    repairs.push('final: snapshots map initialized');
  }

  return {
    data,
    result: { migrated: repairs.length > 0, fromVersion: detected, repairs }
  };
}

export function detectVersion(data: Record<string, unknown>): number {
  const settings = data[STORAGE_KEYS.settings];
  if (isRecord(settings) && typeof settings['schemaVersion'] === 'number') {
    return Math.max(1, Math.min(CURRENT_SCHEMA_VERSION, Math.floor(settings['schemaVersion'])));
  }
  if (isRecord(settings) && typeof settings['preset'] === 'string' &&
      data[STORAGE_KEYS.snapshots] === undefined) {
    return 1; // flat counters era
  }
  if (isRecord(settings)) return 2;
  return CURRENT_SCHEMA_VERSION; // fresh install
}
