/*
 * Quota management for Chrome Declarative Net Request (DNR) API.
 * Modernized for Chrome MV3 (Chrome 121+ specification).
 *
 * Quota Limits & Safety Margins:
 * - Guaranteed Static Rules per extension: 30,000 (additional draw from shared global pool)
 * - Safe Dynamic Rules: 30,000 (AUVYQ maintains a 28,000 safety budget)
 * - Unsafe Dynamic Rules (redirect / modifyHeaders / removeparam): 5,000 (AUVYQ maintains 4,500 budget)
 * - Session Rules: 5,000 (AUVYQ maintains 4,500 budget)
 * - Regex Rules: 1,000 (AUVYQ maintains 900 budget)
 * - Maximum Enabled Static Rulesets: 10 concurrently
 *
 * User custom rules are strictly protected and NEVER evicted or dropped to make room for remote rules.
 */
import type { PackCategory, CompiledRule } from '../rule-compiler/compiler.js';

export const GUARANTEED_STATIC_CAPACITY = 30000;
export const SAFE_DYNAMIC_CAPACITY = 28000;
export const UNSAFE_DYNAMIC_CAPACITY = 4500;
export const SESSION_RULE_CAPACITY = 4500;
export const REGEX_RULE_CAPACITY = 900;
export const MAX_ENABLED_STATIC_RULESETS = 10;

export type RuleSafety = 'safe' | 'unsafe';

/**
 * Classifies a DNR rule as safe or unsafe.
 * Unsafe rules modify headers or redirect (e.g. $removeparam), subject to the strict 5,000 cap.
 */
export function classifyRuleSafety(rule: chrome.declarativeNetRequest.Rule): RuleSafety {
  const actionType = rule.action?.type;
  if (actionType === 'redirect' || actionType === 'modifyHeaders') {
    return 'unsafe';
  }
  return 'safe';
}

/** Determines if a rule utilizes regular expressions, subject to the 1,000 regex quota. */
export function isRegexRule(rule: chrome.declarativeNetRequest.Rule): boolean {
  return typeof rule.condition?.regexFilter === 'string' && rule.condition.regexFilter.length > 0;
}

/** score = frequency x confidence, clamped to a stable range [0, 1]. */
export function scoreRule(frequency: number, confidence: number): number {
  const f = Number.isFinite(frequency) ? Math.min(Math.max(frequency, 0), 1) : 0;
  const c = Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0;
  return Math.round(f * c * 1e6) / 1e6;
}

export interface QuotaCandidate {
  key: string;
  score: number;
  category: PackCategory;
  rule: CompiledRule['rule'];
  cosmeticFallback: string | null;
}

export interface QuotaResult {
  kept: QuotaCandidate[];
  demotedCss: string[];
  dropped: number;
  stats: {
    kept: number;
    demotedToCosmetic: number;
    dropped: number;
  };
}

/**
 * Deterministic: sort by score desc, then key asc; keep the top `capacity`;
 * demote demotable overflow, drop the rest. Same input always yields the same output.
 */
export function applyQuota(candidates: QuotaCandidate[], capacity: number): QuotaResult {
  const cap = Math.max(0, Math.floor(capacity));
  const sorted = candidates.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.key.localeCompare(b.key);
  });

  const kept: QuotaCandidate[] = [];
  const demotedCss: string[] = [];
  let dropped = 0;
  const demotedKeys = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const candidate = sorted[i];
    if (kept.length < cap) {
      kept.push(candidate);
      continue;
    }
    if (candidate.cosmeticFallback !== null && !demotedKeys.has(candidate.cosmeticFallback)) {
      demotedKeys.add(candidate.cosmeticFallback);
      demotedCss.push(candidate.cosmeticFallback);
    } else {
      dropped += 1;
    }
  }

  return {
    kept,
    demotedCss,
    dropped,
    stats: {
      kept: kept.length,
      demotedToCosmetic: demotedCss.length,
      dropped
    }
  };
}

export interface QuotaBreakdown {
  safeDynamic: { count: number; capacity: number; ok: boolean };
  unsafeDynamic: { count: number; capacity: number; ok: boolean };
  regexRules: { count: number; capacity: number; ok: boolean };
  totalDynamic: { count: number; capacity: number; ok: boolean };
}

/**
 * Validates a list of DNR rules against Chrome MV3 partitioned dynamic quotas.
 */
export function validateDynamicRuleQuota(rules: chrome.declarativeNetRequest.Rule[]): {
  valid: boolean;
  breakdown: QuotaBreakdown;
  errors: string[];
} {
  let safeCount = 0;
  let unsafeCount = 0;
  let regexCount = 0;

  for (const rule of rules) {
    if (classifyRuleSafety(rule) === 'unsafe') {
      unsafeCount++;
    } else {
      safeCount++;
    }
    if (isRegexRule(rule)) {
      regexCount++;
    }
  }

  const errors: string[] = [];
  const safeOk = safeCount <= SAFE_DYNAMIC_CAPACITY;
  const unsafeOk = unsafeCount <= UNSAFE_DYNAMIC_CAPACITY;
  const regexOk = regexCount <= REGEX_RULE_CAPACITY;
  const totalOk = rules.length <= SAFE_DYNAMIC_CAPACITY;

  if (!safeOk) errors.push(`safe dynamic rules (${safeCount}) exceed capacity (${SAFE_DYNAMIC_CAPACITY})`);
  if (!unsafeOk) errors.push(`unsafe dynamic rules (${unsafeCount}) exceed capacity (${UNSAFE_DYNAMIC_CAPACITY})`);
  if (!regexOk) errors.push(`regex rules (${regexCount}) exceed capacity (${REGEX_RULE_CAPACITY})`);
  if (!totalOk) errors.push(`total dynamic rules (${rules.length}) exceed capacity (${SAFE_DYNAMIC_CAPACITY})`);

  return {
    valid: safeOk && unsafeOk && regexOk && totalOk,
    breakdown: {
      safeDynamic: { count: safeCount, capacity: SAFE_DYNAMIC_CAPACITY, ok: safeOk },
      unsafeDynamic: { count: unsafeCount, capacity: UNSAFE_DYNAMIC_CAPACITY, ok: unsafeOk },
      regexRules: { count: regexCount, capacity: REGEX_RULE_CAPACITY, ok: regexOk },
      totalDynamic: { count: rules.length, capacity: SAFE_DYNAMIC_CAPACITY, ok: totalOk }
    },
    errors
  };
}

/**
 * Protects user-created custom rules from eviction.
 * User rules always take priority; remote list rules fill remaining capacity.
 */
export function protectUserRules(
  userRules: chrome.declarativeNetRequest.Rule[],
  remoteRules: chrome.declarativeNetRequest.Rule[],
  safeCapacity = SAFE_DYNAMIC_CAPACITY,
  unsafeCapacity = UNSAFE_DYNAMIC_CAPACITY
): {
  approvedRules: chrome.declarativeNetRequest.Rule[];
  droppedRemoteCount: number;
  userRuleCount: number;
} {
  const approved: chrome.declarativeNetRequest.Rule[] = [];
  let userSafe = 0;
  let userUnsafe = 0;

  // 1. User rules are unconditionally added first
  for (const r of userRules) {
    if (classifyRuleSafety(r) === 'unsafe') {
      userUnsafe++;
    } else {
      userSafe++;
    }
    approved.push(r);
  }

  // 2. Remote rules fill the remaining budget up to capacity
  let currentSafe = userSafe;
  let currentUnsafe = userUnsafe;
  let droppedRemote = 0;

  for (const r of remoteRules) {
    const isUnsafe = classifyRuleSafety(r) === 'unsafe';
    if (isUnsafe) {
      if (currentUnsafe < unsafeCapacity && approved.length < safeCapacity) {
        approved.push(r);
        currentUnsafe++;
      } else {
        droppedRemote++;
      }
    } else {
      if (currentSafe < safeCapacity && approved.length < safeCapacity) {
        approved.push(r);
        currentSafe++;
      } else {
        droppedRemote++;
      }
    }
  }

  return {
    approvedRules: approved,
    droppedRemoteCount: droppedRemote,
    userRuleCount: userRules.length
  };
}

/**
 * Queries the available static rule count from the browser runtime where supported.
 * Falls back safely to GUARANTEED_STATIC_CAPACITY (30,000) if unavailable.
 */
export async function getAvailableStaticRules(): Promise<number> {
  const dnr = typeof chrome !== 'undefined'
    ? (chrome.declarativeNetRequest as unknown as { getAvailableStaticRuleCount?: () => Promise<number> })
    : undefined;
  if (dnr?.getAvailableStaticRuleCount) {
    try {
      return await dnr.getAvailableStaticRuleCount();
    } catch {
      return GUARANTEED_STATIC_CAPACITY;
    }
  }
  return GUARANTEED_STATIC_CAPACITY;
}
