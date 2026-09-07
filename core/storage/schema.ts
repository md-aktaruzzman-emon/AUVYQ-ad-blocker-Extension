/** Central storage keys, defaults and preset configuration. Preset logic lives ONLY here. */
import type { Settings, PresetName } from '../../types/schemas.js';

export const CURRENT_SCHEMA_VERSION = 3;

export const STORAGE_KEYS = {
  settings: 'settings',
  snapshots: 'snapshots',
  siteStats: 'siteStats',
  threatLog: 'threatLog',
  pack: 'pack',
  packRuleIds: 'packRuleIds',
  telemetryQueue: 'telemetryQueue',
  onboardingDone: 'onboardingDone',
  updateState: 'updateState',
  tabThreats: 'tabThreats'
} as const;

type ModuleToggles = Pick<Settings['modules'], 'ads' | 'trackers' | 'cookies' | 'heuristics' | 'fingerprintShields'>;

export interface PresetConfig {
  label: string;
  description: string;
  modules: ModuleToggles;
  developerMode: boolean;
}

/** Presets map to explicit module configurations; nothing else may scatter preset logic. */
export const PRESETS: Record<PresetName, PresetConfig> = {
  basic: {
    label: 'Basic',
    description: 'Blocks ads only. Maximum site compatibility.',
    modules: { ads: true, trackers: false, cookies: false, heuristics: false, fingerprintShields: false },
    developerMode: false
  },
  balanced: {
    label: 'Balanced',
    description: 'Recommended. Ads, trackers and cookie cleanup, quietly.',
    modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: false },
    developerMode: false
  },
  strong: {
    label: 'Strong',
    description: 'Adds stricter heuristic threat detection.',
    modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: false },
    developerMode: false
  },
  maximum: {
    label: 'Maximum',
    description: 'Adds optional fingerprint shields. A few sites may misbehave.',
    modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: true },
    developerMode: false
  },
  expert: {
    label: 'Expert',
    description: 'Full manual control with developer diagnostics.',
    modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: true },
    developerMode: true
  }
};

export const DEFAULT_FP_SHIELDS: Record<string, boolean> = {
  canvas: false,
  webgl: false,
  navigator: false,
  screen: false,
  timing: false
};

export function defaultSettings(): Settings {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    preset: 'balanced',
    masterEnabled: true,
    modules: { ...PRESETS.balanced.modules },
    perSite: {},
    telemetryOptIn: false,
    fpShields: { ...DEFAULT_FP_SHIELDS },
    logRetentionDays: 30,
    developerMode: false,
    theme: 'system'
  };
}
