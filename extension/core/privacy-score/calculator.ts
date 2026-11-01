/*
 * AUVYQ Privacy Score Calculation Engine.
 * Provides transparent, measurable, and un-inflated privacy scoring.
 * Separates defensive posture, interception efficacy, and exposure minimization.
 * Explicitly documents calculation limitations; never implies total anonymity.
 */

export interface PrivacyScoreInput {
  settings?: {
    masterEnabled?: boolean;
    modules?: {
      trackers?: boolean;
      cookies?: boolean;
      fingerprintShields?: boolean;
      heuristics?: boolean;
      ads?: boolean;
      annoyances?: boolean;
    };
    preset?: string;
  };
  siteContext?: {
    host?: string;
    paused?: boolean;
    trackersBlocked?: number;
    trackersAllowed?: number;
    cookiesCleaned?: number;
    paramsStripped?: number;
  };
  snapshot?: {
    adsBlocked?: number;
    trackersBlocked?: number;
    paramsStripped?: number;
    cosmeticHidden?: number;
    threats?: number;
    cookiesCleaned?: number;
  };
  observedTrackers?: {
    totalAttempts?: number;
    blockedAttempts?: number;
    allowedAttempts?: number;
  };
}

export interface PrivacyScoreReport {
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
  breakdown: {
    defensivePosture: number;      // max 40
    interceptionEfficacy: number;  // max 40
    exposureMinimization: number;  // max 20
  };
  metrics: {
    trackersBlocked: number;
    trackersAllowed: number;
    cookiesCleaned: number;
    paramsStripped: number;
    totalTrackersDetected: number;
  };
  activeDefenses: string[];
  limitations: string[];
}

export const PRIVACY_LIMITATIONS: readonly string[] = [
  'A high privacy score indicates aggressive interception of known third-party tracking networks; it does NOT provide complete anonymity, hide your IP address, or replace a VPN or Tor.',
  'First-party data collection (account activity, searches, and form submissions on the website you directly visit) cannot be blocked without breaking essential site functionality.',
  'Browser-level telemetry, operating system identifiers, and ISP network-level logging operate outside the extension sandbox.',
  'Fingerprinting shields standardize known hardware and API surfaces, but advanced behavioral profiling (keystroke dynamics, mouse dynamics) cannot be fully eliminated.'
];

/**
 * Calculates a transparent, un-inflated privacy score based on verified data.
 */
export function calculatePrivacyScore(input: PrivacyScoreInput): PrivacyScoreReport {
  const masterEnabled = input.settings?.masterEnabled ?? true;
  const modules = input.settings?.modules ?? {
    ads: true,
    trackers: true,
    cookies: true,
    heuristics: true,
    fingerprintShields: false,
    annoyances: false
  };
  const sitePaused = input.siteContext?.paused ?? false;

  // Trackers and cookies counts from siteContext or snapshot
  const trackersBlocked = (input.siteContext?.trackersBlocked ?? 0) + (input.snapshot?.trackersBlocked ?? 0);
  const trackersAllowed = input.siteContext?.trackersAllowed ?? (input.observedTrackers?.allowedAttempts ?? 0);
  const cookiesCleaned = (input.siteContext?.cookiesCleaned ?? 0) + (input.snapshot?.cookiesCleaned ?? 0);
  const paramsStripped = (input.siteContext?.paramsStripped ?? 0) + (input.snapshot?.paramsStripped ?? 0);

  const totalTrackersDetected = trackersBlocked + trackersAllowed;

  const activeDefenses: string[] = [];

  // -------------------------------------------------------------------------
  // 1. Defensive Posture Sub-score (max 40 pts)
  // -------------------------------------------------------------------------
  let defensivePosture = 0;

  if (masterEnabled && !sitePaused) {
    defensivePosture += 10; // Master protection active
    activeDefenses.push('Master Shield Active');

    if (modules.trackers) {
      defensivePosture += 10;
      activeDefenses.push('Third-Party Tracker Blocking');
    }
    if (modules.cookies) {
      defensivePosture += 10;
      activeDefenses.push('Tracking Cookie Guard & Expiration Truncation');
    }
    if (modules.fingerprintShields) {
      defensivePosture += 5;
      activeDefenses.push('Fingerprint Surface Normalization');
    }
    if (modules.heuristics) {
      defensivePosture += 5;
      activeDefenses.push('Heuristic Threat & Typosquat Detection');
    }
  } else if (sitePaused) {
    // Protection explicitly paused for this domain
    defensivePosture = 5;
    activeDefenses.push('Site Protection Paused by User');
  } else {
    // Master protection disabled
    defensivePosture = 0;
    activeDefenses.push('Protection Disabled');
  }

  // -------------------------------------------------------------------------
  // 2. Interception Efficacy Sub-score (max 40 pts)
  // -------------------------------------------------------------------------
  let interceptionEfficacy = 0;

  if (!masterEnabled || sitePaused) {
    // Zero interception efficacy when disabled or paused
    interceptionEfficacy = 0;
  } else if (totalTrackersDetected === 0) {
    // Baseline clean site: when no trackers exist, award 35 clean points (not 40 to avoid artificial 100%)
    interceptionEfficacy = 35;
  } else {
    const blockRatio = trackersBlocked / totalTrackersDetected;
    interceptionEfficacy = Math.round(40 * blockRatio);
  }

  // -------------------------------------------------------------------------
  // 3. Exposure Minimization Sub-score (max 20 pts)
  // -------------------------------------------------------------------------
  let exposureMinimization = 20;

  if (!masterEnabled || sitePaused) {
    exposureMinimization = 0; // Complete exposure
  } else if (trackersAllowed > 0) {
    // Deduct 5 points per allowed/unblocked tracker domain down to 0
    exposureMinimization = Math.max(0, 20 - trackersAllowed * 5);
  }

  // Total Score clamped between 0 and 100
  const score = Math.max(0, Math.min(100, defensivePosture + interceptionEfficacy + exposureMinimization));

  // Determine Letter Grade
  let grade: PrivacyScoreReport['grade'] = 'F';
  if (score >= 95) grade = 'A+';
  else if (score >= 85) grade = 'A';
  else if (score >= 70) grade = 'B';
  else if (score >= 55) grade = 'C';
  else if (score >= 40) grade = 'D';
  else grade = 'F';

  return {
    score,
    grade,
    breakdown: {
      defensivePosture,
      interceptionEfficacy,
      exposureMinimization
    },
    metrics: {
      trackersBlocked,
      trackersAllowed,
      cookiesCleaned,
      paramsStripped,
      totalTrackersDetected
    },
    activeDefenses,
    limitations: [...PRIVACY_LIMITATIONS]
  };
}
