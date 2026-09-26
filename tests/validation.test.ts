import { describe, it, expect } from 'vitest';
import {
  validateRpcEnvelope,
  validateSettings,
  validateSnapshot,
  validateRiskResult,
  validateUpdateMetadata,
  validateCompiledPack,
  validateHostnameInput
} from '../core/validation/schemas.js';

describe('Runtime Validation at Trust Boundaries', () => {
  it('validates RPC envelopes and rejects malformed messages', () => {
    expect(validateRpcEnvelope({ v: 1, type: 'GET_SNAPSHOT', requestId: 'req-1' }).ok).toBe(true);
    expect(validateRpcEnvelope({ v: 2, type: 'GET_SNAPSHOT', requestId: 'req-1' }).ok).toBe(false);
    expect(validateRpcEnvelope({ v: 1, type: '', requestId: 'req-1' }).ok).toBe(false);
    expect(validateRpcEnvelope({ v: 1, type: 'GET_SNAPSHOT' }).ok).toBe(false);
    expect(validateRpcEnvelope(null).ok).toBe(false);
    expect(validateRpcEnvelope('not-an-object').ok).toBe(false);
  });

  it('validates settings and rejects invalid presets, missing modules, or bad retention', () => {
    const validSettings = {
      schemaVersion: 3,
      preset: 'balanced',
      masterEnabled: true,
      modules: {
        ads: true,
        trackers: true,
        cookies: true,
        heuristics: true,
        fingerprintShields: false
      },
      perSite: {},
      telemetryOptIn: false,
      fpShields: { canvas: false, webgl: false, navigator: false, screen: false, timing: false },
      logRetentionDays: 7,
      theme: 'dark',
      developerMode: false
    };

    expect(validateSettings(validSettings).ok).toBe(true);

    // Invalid preset
    expect(validateSettings({ ...validSettings, preset: 'god-mode' }).ok).toBe(false);

    // Invalid logRetentionDays (must be 7 or 30)
    expect(validateSettings({ ...validSettings, logRetentionDays: 14 }).ok).toBe(false);

    // Missing required boolean in modules
    expect(validateSettings({ ...validSettings, modules: { ads: true } }).ok).toBe(false);
  });

  it('validates snapshots and rejects negative or non-integer counters', () => {
    const validSnapshot = {
      day: '2026-09-05',
      adsBlocked: 10,
      trackersBlocked: 5,
      paramsStripped: 2,
      cosmeticHidden: 8,
      threats: 0,
      cookiesCleaned: 1,
      updatedAt: Date.now()
    };

    expect(validateSnapshot(validSnapshot).ok).toBe(true);
    expect(validateSnapshot({ ...validSnapshot, adsBlocked: -5 }).ok).toBe(false);
    expect(validateSnapshot({ ...validSnapshot, day: 'invalid-date' }).ok).toBe(false);
    expect(validateSnapshot({ ...validSnapshot, trackersBlocked: 'five' }).ok).toBe(false);
  });

  it('validates risk results strictly', () => {
    expect(validateRiskResult({ score: 75, severity: 'high', reasons: ['Typosquat'], confidence: 0.85 }).ok).toBe(true);
    expect(validateRiskResult({ score: 150, severity: 'high', reasons: [], confidence: 0.85 }).ok).toBe(false);
    expect(validateRiskResult({ score: 50, severity: 'extreme', reasons: [], confidence: 0.85 }).ok).toBe(false);
    expect(validateRiskResult({ score: 50, severity: 'medium', reasons: [], confidence: 1.5 }).ok).toBe(false);
  });

  it('validates update metadata packages, URLs and hashes', () => {
    const validMeta = {
      version: '1.2.0',
      createdAt: new Date().toISOString(),
      packages: [
        {
          id: 'main-pack',
          url: 'https://updates.auvyq.org/v1/main.pack',
          sha256: 'a'.repeat(64),
          signature: 'sig_base64_payload'
        }
      ]
    };

    expect(validateUpdateMetadata(validMeta).ok).toBe(true);

    // Insecure HTTP url rejected
    const insecureMeta = {
      ...validMeta,
      packages: [{ ...validMeta.packages[0], url: 'http://insecure.test/pack' }]
    };
    expect(validateUpdateMetadata(insecureMeta).ok).toBe(false);

    // Bad sha256 hash length
    const badHashMeta = {
      ...validMeta,
      packages: [{ ...validMeta.packages[0], sha256: 'short' }]
    };
    expect(validateUpdateMetadata(badHashMeta).ok).toBe(false);
  });

  it('validates compiled pack structure', () => {
    const validPack = {
      version: 1,
      dnrRules: { hotfix: [], trackers: [], ads: [] },
      cosmetic: { genericCss: '##.ad', perDomain: {} },
      scriptletDispatch: {},
      stats: { rulesCompiled: 10, dropped: 0, downgradedToCosmetic: 0 }
    };

    expect(validateCompiledPack(validPack).ok).toBe(true);
    expect(validateCompiledPack({ ...validPack, dnrRules: null }).ok).toBe(false);
  });

  it('validates hostname inputs against injection and invalid length', () => {
    expect(validateHostnameInput('example.com').ok).toBe(true);
    expect(validateHostnameInput('sub.domain-test.co.uk').ok).toBe(true);
    expect(validateHostnameInput('').ok).toBe(false);
    expect(validateHostnameInput('host with spaces').ok).toBe(false);
    expect(validateHostnameInput('<script>').ok).toBe(false);
  });
});
