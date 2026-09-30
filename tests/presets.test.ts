import { describe, it, expect } from 'vitest';
import { PRESETS, defaultSettings, matchPreset } from '../core/storage/schema.js';
import { applyPreset, applyPatch } from '../core/storage/settings.js';
import { validateSettings } from '../core/validation/schemas.js';
import type { Settings } from '../types/schemas.js';

describe('Protection Presets & Canonical State Synchronization', () => {
  it('has all 5 presets properly configured in PRESETS metadata', () => {
    const keys = ['basic', 'balanced', 'strong', 'maximum', 'expert'] as const;
    for (const key of keys) {
      expect(PRESETS[key]).toBeDefined();
      expect(typeof PRESETS[key].label).toBe('string');
      expect(typeof PRESETS[key].description).toBe('string');
      expect(typeof PRESETS[key].tag).toBe('string');
      expect(PRESETS[key].modules).toBeDefined();
    }
  });

  it('applies the Basic preset correctly', () => {
    const initial = defaultSettings();
    const updated = applyPreset(initial, 'basic');

    expect(updated.preset).toBe('basic');
    expect(updated.modules).toEqual({
      ads: true,
      trackers: false,
      cookies: false,
      heuristics: false,
      fingerprintShields: false
    });
    expect(matchPreset(updated)).toBe('basic');
    expect(validateSettings(updated).ok).toBe(true);
  });

  it('applies the Balanced preset correctly', () => {
    const initial = applyPreset(defaultSettings(), 'basic');
    const updated = applyPreset(initial, 'balanced');

    expect(updated.preset).toBe('balanced');
    expect(updated.modules).toEqual({
      ads: true,
      trackers: true,
      cookies: true,
      heuristics: true,
      fingerprintShields: false
    });
    expect(matchPreset(updated)).toBe('balanced');
    expect(validateSettings(updated).ok).toBe(true);
  });

  it('applies the Strong preset correctly', () => {
    const initial = defaultSettings();
    const updated = applyPreset(initial, 'strong');

    expect(updated.preset).toBe('strong');
    expect(updated.modules.ads).toBe(true);
    expect(updated.modules.trackers).toBe(true);
    expect(updated.modules.cookies).toBe(true);
    expect(updated.modules.heuristics).toBe(true);
    expect(updated.modules.fingerprintShields).toBe(false);
    expect(matchPreset(updated)).toBe('strong');
    expect(validateSettings(updated).ok).toBe(true);
  });

  it('applies the Maximum preset correctly', () => {
    const initial = defaultSettings();
    const updated = applyPreset(initial, 'maximum');

    expect(updated.preset).toBe('maximum');
    expect(updated.modules).toEqual({
      ads: true,
      trackers: true,
      cookies: true,
      heuristics: true,
      fingerprintShields: true
    });
    expect(matchPreset(updated)).toBe('maximum');
    expect(validateSettings(updated).ok).toBe(true);
  });

  it('applies Expert preset without overwriting existing custom module settings', () => {
    const customModules = {
      ads: true,
      trackers: false,
      cookies: true,
      heuristics: false,
      fingerprintShields: true
    };
    const initial: Settings = {
      ...defaultSettings(),
      modules: customModules
    };

    const updated = applyPreset(initial, 'expert');
    expect(updated.preset).toBe('expert');
    expect(updated.modules).toEqual(customModules);
    expect(matchPreset(updated)).toBe('expert');
    expect(validateSettings(updated).ok).toBe(true);
  });

  it('automatically derives Expert preset when an individual module is toggled to custom state', () => {
    const initial = applyPreset(defaultSettings(), 'balanced');
    expect(initial.preset).toBe('balanced');

    // Turn off tracker blocking -> now custom
    const patched = applyPatch(initial, { modules: { trackers: false } });
    expect(patched.preset).toBe('expert');
    expect(patched.modules.trackers).toBe(false);
    expect(patched.modules.ads).toBe(true);
  });

  it('automatically recognizes standard preset when modules are set back to match standard profile', () => {
    const custom: Settings = {
      ...defaultSettings(),
      preset: 'expert',
      modules: {
        ads: true,
        trackers: false,
        cookies: false,
        heuristics: false,
        fingerprintShields: false
      }
    };

    expect(matchPreset(custom)).toBe('basic');

    const patched = applyPatch(custom, { modules: { trackers: true, cookies: true, heuristics: true } });
    expect(patched.preset).toBe('balanced');
  });

  it('rejects invalid preset names during schema validation', () => {
    const invalid = {
      ...defaultSettings(),
      preset: 'ultra-defense'
    };
    const result = validateSettings(invalid);
    expect(result.ok).toBe(false);
  });

  it('preserves user selected light or dark theme across all preset changes and module patches', () => {
    const lightSettings: Settings = {
      ...defaultSettings(),
      theme: 'light'
    };

    const presets = ['basic', 'balanced', 'strong', 'maximum', 'expert'] as const;
    for (const preset of presets) {
      const updated = applyPreset(lightSettings, preset);
      expect(updated.theme).toBe('light');
      expect(updated.preset).toBe(preset);
    }

    const patched = applyPatch(lightSettings, { modules: { ads: false } });
    expect(patched.theme).toBe('light');
    expect(patched.preset).toBe('expert');
  });
});
