/** Settings service: validated load/save, preset application, per-site state. */
import type { Settings, PresetName } from '../../types/schemas.js';
import { STORAGE_KEYS, defaultSettings, PRESETS, CURRENT_SCHEMA_VERSION, matchPreset, MAXIMUM_FP_SHIELDS, DEFAULT_FP_SHIELDS } from './schema.js';
import { migrateStorage } from './migrate.js';
import { validateSettings } from '../validation/schemas.js';
import { normalizeHostname } from '../domain/normalize.js';

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const migrated = migrateStorage(raw);
  const validated = validateSettings(migrated.data[STORAGE_KEYS.settings]);
  if (validated.ok) return validated.value;
  return defaultSettings();
}

export async function saveSettings(settings: Settings): Promise<void> {
  const validated = validateSettings(settings);
  if (!validated.ok) throw new Error(`refusing to save invalid settings: ${validated.error}`);
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: validated.value });
}

export type SettingsPatch = Partial<Omit<Settings, 'modules' | 'fpShields'>> & {
  modules?: Partial<Settings['modules']>;
  fpShields?: Partial<Settings['fpShields']>;
};

/** Applies a validated partial patch; returns the next settings value with derived preset. */
export function applyPatch(current: Settings, patch: SettingsPatch): Settings {
  const next: Settings = { ...current, modules: { ...current.modules }, fpShields: { ...current.fpShields } };
  if (typeof patch.masterEnabled === 'boolean') next.masterEnabled = patch.masterEnabled;
  if (typeof patch.telemetryOptIn === 'boolean') next.telemetryOptIn = patch.telemetryOptIn;
  if (typeof patch.developerMode === 'boolean') next.developerMode = patch.developerMode;
  if (patch.logRetentionDays === 7 || patch.logRetentionDays === 30) next.logRetentionDays = patch.logRetentionDays;
  if (patch.theme === 'system' || patch.theme === 'dark' || patch.theme === 'light') next.theme = patch.theme;

  let modulesChanged = false;
  if (patch.modules !== undefined) {
    const modules = patch.modules as Record<string, unknown>;
    for (const key of Object.keys(next.modules) as (keyof Settings['modules'])[]) {
      if (typeof modules[key] === 'boolean' && next.modules[key] !== modules[key]) {
        next.modules[key] = modules[key] as boolean;
        modulesChanged = true;
      }
    }
  }

  let shieldsChanged = false;
  if (patch.fpShields !== undefined) {
    const shields = patch.fpShields as Record<string, unknown>;
    for (const key of Object.keys(next.fpShields)) {
      if (typeof shields[key] === 'boolean' && next.fpShields[key] !== shields[key]) {
        next.fpShields[key] = shields[key] as boolean;
        shieldsChanged = true;
      }
    }
    if (shieldsChanged && patch.modules?.fingerprintShields === undefined) {
      const anyShieldActive = Object.values(next.fpShields).some(Boolean);
      if (next.modules.fingerprintShields !== anyShieldActive) {
        next.modules.fingerprintShields = anyShieldActive;
        modulesChanged = true;
      }
    }
  }

  if (patch.preset !== undefined) {
    next.preset = patch.preset;
  } else if (modulesChanged || shieldsChanged) {
    next.preset = matchPreset(next);
  }

  return next;
}

/** Preset application is centralized: preset -> explicit module configuration. */
export function applyPreset(settings: Settings, preset: PresetName): Settings {
  const config = PRESETS[preset];
  if (config === undefined) return settings;

  if (preset === 'expert') {
    return {
      ...settings,
      preset: 'expert',
      developerMode: config.developerMode,
      schemaVersion: CURRENT_SCHEMA_VERSION
    };
  }

  const fpShields = preset === 'maximum'
    ? { ...MAXIMUM_FP_SHIELDS }
    : { ...DEFAULT_FP_SHIELDS };

  return {
    ...settings,
    preset,
    modules: { ...config.modules },
    fpShields,
    developerMode: config.developerMode,
    schemaVersion: CURRENT_SCHEMA_VERSION
  };
}

export function isSitePaused(settings: Settings, host: string): boolean {
  const normalized = normalizeHostname(host);
  if (normalized.length === 0) return false;
  return settings.perSite[normalized]?.paused === true;
}

export function setSitePaused(settings: Settings, host: string, paused: boolean): Settings {
  const normalized = normalizeHostname(host);
  if (normalized.length === 0) return settings;
  const existing = settings.perSite[normalized] ?? { paused: false, allowlist: [] };
  return {
    ...settings,
    perSite: {
      ...settings.perSite,
      [normalized]: { ...existing, paused }
    }
  };
}
