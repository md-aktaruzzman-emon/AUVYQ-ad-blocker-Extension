import { describe, it, expect } from 'vitest';
import { PRESETS, defaultSettings, matchPreset, DEFAULT_FP_SHIELDS } from '../core/storage/schema.js';
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
      fingerprintShields: false,
      annoyances: false
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
      fingerprintShields: false,
      annoyances: false
    });
    expect(matchPreset(updated)).toBe('balanced');
    expect(validateSettings(updated).ok).toBe(true);
  });

  it('applies the Strong preset correctly and is distinct from Balanced', () => {
    const initial = defaultSettings();
    const updated = applyPreset(initial, 'strong');

    expect(updated.preset).toBe('strong');
    expect(updated.modules.ads).toBe(true);
    expect(updated.modules.trackers).toBe(true);
    expect(updated.modules.cookies).toBe(true);
    expect(updated.modules.heuristics).toBe(true);
    expect(updated.modules.fingerprintShields).toBe(false);
    expect(updated.modules.annoyances).toBe(true);
    // Verified distinct from balanced
    expect(PRESETS.strong.modules).not.toEqual(PRESETS.balanced.modules);
    expect(matchPreset(updated)).toBe('strong');
    expect(validateSettings(updated).ok).toBe(true);
  });

  it('applies the Maximum preset correctly with all fingerprint shields enabled', () => {
    const initial = defaultSettings();
    const updated = applyPreset(initial, 'maximum');

    expect(updated.preset).toBe('maximum');
    expect(updated.modules).toEqual({
      ads: true,
      trackers: true,
      cookies: true,
      heuristics: true,
      fingerprintShields: true,
      annoyances: true
    });
    expect(updated.fpShields).toEqual({
      canvas: true,
      webgl: true,
      navigator: true,
      screen: true,
      timing: true
    });
    expect(matchPreset(updated)).toBe('maximum');
    expect(validateSettings(updated).ok).toBe(true);

    // Switching back to balanced resets fpShields to default
    const reset = applyPreset(updated, 'balanced');
    expect(reset.modules.fingerprintShields).toBe(false);
    expect(reset.fpShields).toEqual(DEFAULT_FP_SHIELDS);
    expect(matchPreset(reset)).toBe('balanced');
  });

  it('synchronizes fpShields and modules.fingerprintShields during partial patches', () => {
    const initial = defaultSettings();
    expect(initial.modules.fingerprintShields).toBe(false);

    // Toggling an individual shield on enables modules.fingerprintShields and sets preset to expert
    const patched1 = applyPatch(initial, { fpShields: { canvas: true } });
    expect(patched1.modules.fingerprintShields).toBe(true);
    expect(patched1.fpShields.canvas).toBe(true);
    expect(patched1.preset).toBe('expert');

    // Toggling all shields to true while having all modules matches maximum preset
    const maxPatched = applyPatch(patched1, {
      modules: { annoyances: true },
      fpShields: { webgl: true, navigator: true, screen: true, timing: true }
    });
    expect(maxPatched.preset).toBe('maximum');

    // Disabling one shield in maximum makes it expert
    const expertShield = applyPatch(maxPatched, { fpShields: { timing: false } });
    expect(expertShield.preset).toBe('expert');

    // Disabling all shields disables modules.fingerprintShields
    const allDisabled = applyPatch(expertShield, {
      fpShields: { canvas: false, webgl: false, navigator: false, screen: false, timing: false }
    });
    expect(allDisabled.modules.fingerprintShields).toBe(false);
  });

  it('applies Expert preset without overwriting existing custom module settings', () => {
    const customModules = {
      ads: true,
      trackers: false,
      cookies: true,
      heuristics: false,
      fingerprintShields: true,
      annoyances: false
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
        fingerprintShields: false,
        annoyances: false
      }
    };

    expect(matchPreset(custom)).toBe('basic');

    const patched = applyPatch(custom, { modules: { trackers: true, cookies: true, heuristics: true, annoyances: false } });
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

  it('correctly applies preset combined with other setting fields', () => {
    const initial = defaultSettings();
    const withPreset = applyPreset(initial, 'basic');
    const withPatch = applyPatch(withPreset, { telemetryOptIn: true, theme: 'light' });

    expect(withPatch.preset).toBe('basic');
    expect(withPatch.modules.trackers).toBe(false);
    expect(withPatch.telemetryOptIn).toBe(true);
    expect(withPatch.theme).toBe('light');
  });

  it('handles rapid sequential preset switches deterministically', () => {
    let current = defaultSettings();
    const sequence = ['basic', 'balanced', 'strong', 'maximum', 'expert', 'basic'] as const;
    for (const target of sequence) {
      current = applyPreset(current, target);
      expect(current.preset).toBe(target);
      expect(validateSettings(current).ok).toBe(true);
    }
    expect(current.preset).toBe('basic');
    expect(current.modules.trackers).toBe(false);
  });
});
