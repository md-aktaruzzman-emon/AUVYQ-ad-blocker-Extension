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

export type ModuleToggles = Pick<Settings['modules'], 'ads' | 'trackers' | 'cookies' | 'heuristics' | 'fingerprintShields'>;

export interface PresetConfig {
  label: string;
  description: string;
  tag: string;
  recommended?: boolean;
  modules: ModuleToggles;
  developerMode: boolean;
}

/** Presets map to explicit module configurations; nothing else may scatter preset logic. */
export const PRESETS: Record<PresetName, PresetConfig> = {
  basic: {
    label: 'Basic',
    description: 'Essential ad blocking with maximum compatibility.',
    tag: 'Best when you want simple ad blocking with minimal site impact.',
    recommended: false,
    modules: { ads: true, trackers: false, cookies: false, heuristics: false, fingerprintShields: false },
    developerMode: false
  },
  balanced: {
    label: 'Balanced',
    description: 'Everyday ad, tracker, cookie, and threat protection.',
    tag: 'Recommended for most browsing.',
    recommended: true,
    modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: false },
    developerMode: false
  },
  strong: {
    label: 'Strong',
    description: 'Stronger tracking and threat protection.',
    tag: 'More protection with a higher chance of website compatibility issues.',
    recommended: false,
    modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: false },
    developerMode: false
  },
  maximum: {
    label: 'Maximum',
    description: 'Maximum available protection, including fingerprint defenses.',
    tag: 'Strongest protection. Some websites may require additional adjustments.',
    recommended: false,
    modules: { ads: true, trackers: true, cookies: true, heuristics: true, fingerprintShields: true },
    developerMode: false
  },
  expert: {
    label: 'Expert',
    description: 'Full manual control over protection modules.',
    tag: 'Configure each protection module individually.',
    recommended: false,
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

/**
 * Derives the active preset from the canonical module configuration.
 * If modules match a standard preset profile, returns that preset name.
 * If modules have been customized, returns 'expert'.
 */
export function matchPreset(settings: Pick<Settings, 'modules' | 'preset'>): PresetName {
  const m = settings.modules;
  if (!m) return 'balanced';

  // Basic: ads only
  if (m.ads === true && m.trackers === false && m.cookies === false && m.heuristics === false && m.fingerprintShields === false) {
    return 'basic';
  }

  // Maximum: all 5 modules active
  if (m.ads === true && m.trackers === true && m.cookies === true && m.heuristics === true && m.fingerprintShields === true) {
    return 'maximum';
  }

  // Balanced or Strong profile: ads + trackers + cookies + heuristics, fpShields off
  if (m.ads === true && m.trackers === true && m.cookies === true && m.heuristics === true && m.fingerprintShields === false) {
    if (settings.preset === 'strong') return 'strong';
    return 'balanced';
  }

  // Custom configuration not matching standard presets
  return 'expert';
}

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
