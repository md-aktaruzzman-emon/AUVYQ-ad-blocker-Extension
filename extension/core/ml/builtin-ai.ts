/*
 * AUVYQ Chrome Built-in AI Bridge (Prompt API / Gemini Nano) & Deterministic Fallback Engine.
 * 
 * Provides:
 * 1. Native integration with Chrome 127+/131+ built-in on-device AI (ai.languageModel).
 * 2. Feature detection across modern and legacy shapes.
 * 3. 100% on-device execution (0 cloud network calls, 0 browsing history leaks).
 * 4. Deterministic template fallback engine ensuring instant, high-quality explanations
 *    when Gemini Nano is unavailable, downloading, or disabled.
 */
import type { RiskResult, ThreatSignal } from '../../types/schemas.js';

export type BuiltInAiAvailability = 'readily' | 'after-download' | 'no';

export interface BuiltInAiStatus {
  available: BuiltInAiAvailability;
  supported: boolean;
  engine: 'chrome-builtin-ai' | 'deterministic-template-fallback';
  modelName: string;
}

export interface ThreatExplanation {
  headline: string;
  explanation: string;
  guidance: string;
  source: 'chrome-gemini-nano' | 'deterministic-fallback';
}

export interface PrivacyAdvice {
  rating: string;
  summary: string;
  actionableSteps: string[];
  source: 'chrome-gemini-nano' | 'deterministic-fallback';
}

// Global declaration for TypeScript when running in extension or browser context
declare global {
  interface Window {
    ai?: {
      languageModel?: {
        capabilities(): Promise<{ available: BuiltInAiAvailability }>;
        create(options?: { systemPrompt?: string }): Promise<{
          prompt(text: string): Promise<string>;
          destroy(): void;
        }>;
      };
      canCreateTextSession?(): Promise<BuiltInAiAvailability>;
      createTextSession?(): Promise<{
        prompt(text: string): Promise<string>;
        destroy(): void;
      }>;
    };
  }
}

/**
 * Checks availability of Chrome Built-in AI (Gemini Nano) using modern feature detection.
 */
export async function checkBuiltInAiAvailability(): Promise<BuiltInAiStatus> {
  // Check globalThis or window
  const globalObj = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? (globalThis as unknown as { ai?: Window['ai'] }) : {});

  if (globalObj.ai?.languageModel) {
    try {
      const caps = await globalObj.ai.languageModel.capabilities();
      return {
        available: caps.available,
        supported: true,
        engine: caps.available === 'readily' ? 'chrome-builtin-ai' : 'deterministic-template-fallback',
        modelName: 'Gemini Nano (Built-in)'
      };
    } catch {
      // Fall through on check failure
    }
  }

  // Legacy early experimental Prompt API check
  if (globalObj.ai?.canCreateTextSession) {
    try {
      const avail = await globalObj.ai.canCreateTextSession();
      return {
        available: avail,
        supported: true,
        engine: avail === 'readily' ? 'chrome-builtin-ai' : 'deterministic-template-fallback',
        modelName: 'Gemini Nano (Legacy Prompt API)'
      };
    } catch {
      // Fall through
    }
  }

  return {
    available: 'no',
    supported: false,
    engine: 'deterministic-template-fallback',
    modelName: 'AUVYQ High-Assurance Template Engine'
  };
}

/**
 * Generates an accessible, plain-language explanation of a threat assessment.
 * Prefers on-device Gemini Nano if available; seamlessly falls back to the deterministic template engine.
 */
export async function generateThreatExplanation(
  host: string,
  risk: RiskResult,
  forceFallback = false
): Promise<ThreatExplanation> {
  // If safe or clean, return standard reassurance
  if (risk.score < 25 && risk.severity === 'none') {
    return {
      headline: 'Website Appears Genuine & Secure',
      explanation: `Our automated analysis found no deceptive homoglyphs, brand impersonations, or structural anomalies for ${host}.`,
      guidance: 'You can browse safely. AUVYQ continues standard background ad and tracker blocking.',
      source: 'deterministic-fallback'
    };
  }

  // Attempt Chrome Built-in AI if active and not forced to fallback
  if (!forceFallback) {
    try {
      const aiStatus = await checkBuiltInAiAvailability();
      if (aiStatus.available === 'readily') {
        const geminiResult = await promptGeminiNanoForThreat(host, risk);
        if (geminiResult) return geminiResult;
      }
    } catch {
      // Silently fall through to deterministic template engine
    }
  }

  // High-assurance deterministic template fallback
  return generateDeterministicExplanation(host, risk);
}

/**
 * Internal call to Chrome Built-in Gemini Nano using Prompt API.
 */
async function promptGeminiNanoForThreat(host: string, risk: RiskResult): Promise<ThreatExplanation | null> {
  const globalObj = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? (globalThis as unknown as { ai?: Window['ai'] }) : {});

  if (!globalObj.ai?.languageModel) return null;

  let session: { prompt(text: string): Promise<string>; destroy(): void } | null = null;
  try {
    session = await globalObj.ai.languageModel.create({
      systemPrompt: 'You are AUVYQ, an expert privacy and web security assistant. Explain why a website URL or threat assessment is dangerous in 2 simple, calm, accessible sentences for a non-technical user. Do not use markdown headers or jargon.'
    });

    const promptText = `Website domain: "${host}"\nRisk Score: ${risk.score}/100 (${risk.severity})\nPrimary Reasons: ${risk.reasons.slice(0, 3).join('; ')}\nExplain this threat and recommend a safe action:`;

    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timerId = setTimeout(() => reject(new Error('Prompt API timeout')), 4000);
    });

    const rawResponse = await Promise.race([
      session.prompt(promptText),
      timeoutPromise
    ]);
    if (timerId !== undefined) clearTimeout(timerId);

    const text = rawResponse.trim();

    if (text.length > 20) {
      return {
        headline: `Intelligent Security Warning for ${host}`,
        explanation: text,
        guidance: risk.severity === 'malicious' || risk.score >= 80
          ? 'Recommended action: Do not enter any passwords or personal details. Close this tab or return to safety.'
          : 'Recommended action: Verify the website address in the address bar before proceeding.',
        source: 'chrome-gemini-nano'
      };
    }
  } catch {
    // If Gemini Nano fails (e.g. timeout or context kill), return null to trigger deterministic fallback
  } finally {
    try {
      session?.destroy();
    } catch {
      // Ignore destroy errors
    }
  }

  return null;
}

/**
 * Deterministic template engine: guarantees instant, human-readable explanations
 * without external dependencies, LLM hallucination risks, or network requirements.
 */
export function generateDeterministicExplanation(host: string, risk: RiskResult): ThreatExplanation {
  const signals = risk.signals || [];
  const primaryReason = risk.reasons[0] || 'Suspicious domain behavior';

  // 1. Confirmed threat intel
  if (risk.threatType === 'confirmed' || primaryReason.includes('threat intelligence')) {
    return {
      headline: 'Known Malicious or Phishing Website',
      explanation: `This domain (${host}) is officially cataloged in verified threat intelligence databases as a malicious host actively engaged in credential harvesting or malware distribution.`,
      guidance: 'Action: AUVYQ strongly advises closing this tab immediately. Do not submit passwords or download files.',
      source: 'deterministic-fallback'
    };
  }

  // 2. Homoglyph deception
  const homoglyphSignal = signals.find((s) => s.category === 'homoglyph' || s.description.includes('Homoglyph') || s.description.includes('Cyrillic'));
  if (homoglyphSignal) {
    return {
      headline: 'Visual Lookalike (Homoglyph) Attack Detected',
      explanation: `This website replaces standard Latin letters in "${host}" with foreign alphabet lookalikes (such as Cyrillic or Greek characters) to mimic a well-known service.`,
      guidance: 'Action: This is a common tactic to steal login credentials. Do not attempt to log in. Close this page.',
      source: 'deterministic-fallback'
    };
  }

  // 3. Deceptive Subdomains
  const subdomainSignal = signals.find((s) => s.category === 'deceptive_subdomain' || s.description.includes('subdomain'));
  if (subdomainSignal) {
    return {
      headline: 'Deceptive Brand Subdomain Detected',
      explanation: `The address includes a recognizable brand name in its prefix, but the actual destination server belongs to an unrelated third party (${host}).`,
      guidance: 'Action: Verify the real domain ending before proceeding. Authentic companies never host sign-in pages on third-party domains.',
      source: 'deterministic-fallback'
    };
  }

  // 4. Brand Impersonation + Security Keywords
  const brandSignal = signals.find((s) => s.category === 'brand_impersonation' || s.description.includes('impersonating'));
  if (brandSignal) {
    return {
      headline: 'Suspected Brand Impersonation',
      explanation: `This unverified domain combines a protected commercial brand name with account verification keywords (${primaryReason}).`,
      guidance: 'Action: If you received a link via email or message directing you here, it is almost certainly a phishing attempt.',
      source: 'deterministic-fallback'
    };
  }

  // 5. Structure anomalies (Raw IP, @ userinfo, hyphens)
  const structSignal = signals.find((s) => s.category === 'structure_anomaly' || s.category.startsWith('ml_'));
  if (structSignal) {
    return {
      headline: 'Abnormal Technical Structure Detected',
      explanation: `The web address uses anomalous structural patterns (${primaryReason}) frequently observed in disposable scam infrastructure.`,
      guidance: 'Action: Proceed with caution. Verify that you typed the address correctly and check for HTTPS security.',
      source: 'deterministic-fallback'
    };
  }

  // Default fallback for general heuristic alerts
  return {
    headline: `Heuristic Security Notice for ${host}`,
    explanation: `AUVYQ detected multiple anomalous indicators (${primaryReason}). The site score is ${risk.score}/100.`,
    guidance: 'Action: Avoid entering sensitive credentials or payment cards unless you are completely confident of this origin.',
    source: 'deterministic-fallback'
  };
}

/**
 * Generates explainable, actionable privacy recommendations for a website.
 */
export function generatePrivacyAdvice(
  host: string,
  privacyScore: number,
  trackersBlocked: number,
  cookiesTruncated: number,
  hasThirdPartyCmp: boolean
): PrivacyAdvice {
  let rating = 'Excellent';
  if (privacyScore < 50) rating = 'Poor';
  else if (privacyScore < 70) rating = 'Moderate';
  else if (privacyScore < 85) rating = 'Good';

  const steps: string[] = [];

  if (trackersBlocked > 5) {
    steps.push(`This site deployed ${trackersBlocked} third-party tracking beacons. Keep Tracker Shield active.`);
  }

  if (cookiesTruncated > 0) {
    steps.push(`AUVYQ truncated persistent tracking cookies on this site to 24 hours to prevent cross-session profiling.`);
  }

  if (hasThirdPartyCmp) {
    steps.push('A consent management dialog was detected on this origin. AUVYQ automatically clicks "Reject All" where available.');
  }

  if (privacyScore < 60) {
    steps.push('Recommendation: Consider switching to the "Strict (Maximum)" protection profile for this domain.');
  } else {
    steps.push('Standard protection profile is maintaining high privacy with zero site breakage.');
  }

  return {
    rating,
    summary: `Privacy rating for ${host} is ${rating} (${privacyScore}/100). AUVYQ active defenses are screening requests locally.`,
    actionableSteps: steps,
    source: 'deterministic-fallback'
  };
}
