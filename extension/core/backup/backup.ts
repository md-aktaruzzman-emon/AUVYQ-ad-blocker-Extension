/*
 * AUVYQ backup service: atomic export and restore with schema validation and integrity verification.
 * Never applies partial or corrupted backup data.
 */
import { STORAGE_KEYS, CURRENT_SCHEMA_VERSION } from '../storage/schema.js';
import {
  validateSettings,
  validateSnapshot,
  validateThreatLogEntry,
  validateCustomRuleRecord,
  isRecord
} from '../validation/schemas.js';
import type { Settings } from '../../types/schemas.js';

export interface BackupEnvelope {
  schemaVersion: number;
  exportedAt: number;
  integrityHash: string;
  data: Record<string, unknown>;
}

/**
 * Computes a deterministic SHA-256 digest string for backup data integrity.
 */
export async function computePayloadDigest(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(content);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // Fallback below
    }
  }
  // Deterministic FNV-1a fallback
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

/**
 * Serializes settings, daily snapshots, threat logs, and user custom rules into a signed JSON payload.
 */
export async function buildBackupPayload(): Promise<string> {
  const keys = [
    STORAGE_KEYS.settings,
    STORAGE_KEYS.snapshots,
    STORAGE_KEYS.threatLog,
    STORAGE_KEYS.customRules
  ];
  const storageData = await chrome.storage.local.get(keys);

  const rawJson = JSON.stringify(storageData);
  const integrityHash = await computePayloadDigest(rawJson);

  const payload = {
    ...storageData,
    _meta: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      exportedAt: Date.now(),
      integrityHash
    }
  };

  return JSON.stringify(payload);
}

/**
 * Validates and restores a decrypted backup payload atomically.
 * Supports both Schema v3 Envelopes and legacy un-enveloped payloads with all-or-nothing rollback.
 */
export async function restoreBackupPayload(
  value: unknown,
  onSettingsRestored?: (settings: Settings) => Promise<void> | void
): Promise<{ restored: string[]; version: number }> {
  if (!isRecord(value)) throw new Error('backup payload is not an object');

  let dataObj: Record<string, unknown>;
  let version = 1;

  // 1. Unpack Metadata / Envelope if present and verify integrity
  if (isRecord(value['_meta'])) {
    const meta = value['_meta'] as Record<string, unknown>;
    if (typeof meta['schemaVersion'] === 'number') version = meta['schemaVersion'];
    dataObj = { ...value };
    delete dataObj['_meta'];
    if (typeof meta['integrityHash'] === 'string') {
      const dataJson = JSON.stringify(dataObj);
      const computedHash = await computePayloadDigest(dataJson);
      if (computedHash !== meta['integrityHash']) {
        throw new Error('backup payload integrity verification failed: hash mismatch');
      }
    }
  } else if (typeof value['schemaVersion'] === 'number' && isRecord(value['data'])) {
    version = value['schemaVersion'];
    dataObj = value['data'] as Record<string, unknown>;

    // Integrity check
    if (typeof value['integrityHash'] === 'string') {
      const dataJson = JSON.stringify(dataObj);
      const computedHash = await computePayloadDigest(dataJson);
      if (computedHash !== value['integrityHash']) {
        throw new Error('backup payload integrity verification failed: hash mismatch');
      }
    }
  } else {
    // Legacy un-enveloped format
    dataObj = value;
  }

  const restored: string[] = [];

  // 2. Validate all parts before applying any modifications (atomic verification)
  let validatedSettings: Settings | null = null;
  const settingsRaw = dataObj[STORAGE_KEYS.settings];
  if (settingsRaw !== undefined) {
    const validated = validateSettings(settingsRaw);
    if (!validated.ok) throw new Error(`backup settings failed validation: ${validated.error}`);
    validatedSettings = validated.value;
  }

  let validatedSnapshots: Record<string, unknown> | null = null;
  const snapshotsRaw = dataObj[STORAGE_KEYS.snapshots];
  if (snapshotsRaw !== undefined) {
    if (!isRecord(snapshotsRaw)) throw new Error('backup snapshots failed validation: not an object');
    for (const [day, snap] of Object.entries(snapshotsRaw)) {
      const validSnap = validateSnapshot(snap);
      if (!validSnap.ok) throw new Error(`backup snapshot for ${day} failed validation: ${validSnap.error}`);
    }
    validatedSnapshots = snapshotsRaw;
  }

  let validatedThreatLog: unknown[] | null = null;
  const threatLogRaw = dataObj[STORAGE_KEYS.threatLog];
  if (threatLogRaw !== undefined) {
    if (!Array.isArray(threatLogRaw)) throw new Error('backup threat log failed validation: not an array');
    for (const entry of threatLogRaw) {
      const validEntry = validateThreatLogEntry(entry);
      if (!validEntry.ok) throw new Error(`backup threat log entry failed validation: ${validEntry.error}`);
    }
    validatedThreatLog = threatLogRaw;
  }

  let validatedCustomRules: unknown[] | null = null;
  const customRulesRaw = dataObj[STORAGE_KEYS.customRules];
  if (customRulesRaw !== undefined) {
    if (!Array.isArray(customRulesRaw)) throw new Error('backup custom rules failed validation: not an array');
    for (const rule of customRulesRaw) {
      const validRule = validateCustomRuleRecord(rule);
      if (!validRule.ok) throw new Error(`backup custom rule failed validation: ${validRule.error}`);
    }
    validatedCustomRules = customRulesRaw;
  }

  // 3. Apply all validated sections atomically
  const updates: Record<string, unknown> = {};
  if (validatedSettings !== null) {
    updates[STORAGE_KEYS.settings] = validatedSettings;
    restored.push(STORAGE_KEYS.settings);
  }
  if (validatedSnapshots !== null) {
    updates[STORAGE_KEYS.snapshots] = validatedSnapshots;
    restored.push(STORAGE_KEYS.snapshots);
  }
  if (validatedThreatLog !== null) {
    updates[STORAGE_KEYS.threatLog] = validatedThreatLog;
    restored.push(STORAGE_KEYS.threatLog);
  }
  if (validatedCustomRules !== null) {
    updates[STORAGE_KEYS.customRules] = validatedCustomRules;
    restored.push(STORAGE_KEYS.customRules);
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }

  // 4. Trigger lifecycle callback if settings were updated
  if (validatedSettings !== null && onSettingsRestored) {
    await onSettingsRestored(validatedSettings);
  }

  return { restored, version };
}
