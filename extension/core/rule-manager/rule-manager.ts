/*
 * Rule Manager: Comprehensive Rule Lifecycle & Prioritization.
 *
 * Partitioned ID Allocations:
 * - Static Rulesets: 1..9999 (scoped per static JSON ruleset file)
 * - User Custom Rules: 10000..19999 (highest priority, persistent, never evicted)
 * - Dynamic Remote Rules: 20000..28999 (updated via signed update channel)
 * - Session Rules: 30000..34999 (temporary paused-site overrides, master allow rule)
 *
 * Priority Tiers:
 * - Master Allow (Protection Off): 30000
 * - Site-Paused Session Allow: 20000
 * - User Custom Allow Rules: 9500..9999
 * - User Custom Block Rules: 9000..9499
 * - Dynamic Allow Rules: 7000..7999
 * - Dynamic Block Rules: 1000..6999
 * - Static Rules: 1..2 (allow = 2, block = 1)
 */
import { classifyRuleSafety, protectUserRules, SAFE_DYNAMIC_CAPACITY, UNSAFE_DYNAMIC_CAPACITY } from '../quota-manager/quota.js';

export const USER_RULE_ID_MIN = 10000;
export const USER_RULE_ID_MAX = 19999;
export const DYNAMIC_RULE_ID_MIN = 20000;
export const DYNAMIC_RULE_ID_MAX = 28999;
export const SESSION_RULE_ID_MIN = 30000;
export const MASTER_ALLOW_RULE_ID = 30000;

export interface UserFilterRule {
  id: string; // uuid or string key
  rawText: string;
  enabled: boolean;
  createdAt: number;
}

export interface RuleManagerStorage {
  getUserRules(): Promise<UserFilterRule[]>;
  saveUserRules(rules: UserFilterRule[]): Promise<void>;
}

/** Generates a deterministic hash key for a rule condition to prevent duplicates. */
export function conditionFingerprint(condition: chrome.declarativeNetRequest.RuleCondition): string {
  const parts: string[] = [
    condition.urlFilter ?? '',
    condition.regexFilter ?? '',
    (condition.requestDomains ?? []).slice().sort().join(','),
    (condition.excludedRequestDomains ?? []).slice().sort().join(','),
    (condition.initiatorDomains ?? []).slice().sort().join(','),
    (condition.excludedInitiatorDomains ?? []).slice().sort().join(','),
    (condition.resourceTypes ?? []).slice().sort().join(','),
    condition.domainType ?? ''
  ];
  return parts.join('§');
}

/**
 * Converts a simple user domain rule (e.g. "example.com" or "||example.com^")
 * into a valid DNR Rule with priority in the User Custom Rule range.
 */
export function compileUserRule(
  rawText: string,
  numericId: number
): chrome.declarativeNetRequest.Rule | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0 || trimmed.startsWith('!') || trimmed.startsWith('#')) return null;

  let isAllow = false;
  let pattern = trimmed;
  if (pattern.startsWith('@@')) {
    isAllow = true;
    pattern = pattern.slice(2);
  }

  // If user just typed a bare domain e.g. "adserver.com"
  if (!pattern.startsWith('||') && !pattern.startsWith('/') && !pattern.startsWith('http')) {
    pattern = `||${pattern}^`;
  }

  const priority = isAllow ? 9500 : 9000;
  const action: chrome.declarativeNetRequest.RuleAction = {
    type: isAllow ? 'allow' : 'block'
  };

  const condition: chrome.declarativeNetRequest.RuleCondition = {};
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    condition.regexFilter = pattern.slice(1, -1);
  } else {
    condition.urlFilter = pattern;
  }

  return {
    id: numericId,
    priority,
    action,
    condition
  };
}

export interface RuleSyncOutcome {
  success: boolean;
  installedCount: number;
  removedCount: number;
  error?: string;
}

/**
 * Synchronizes dynamic rules atomically with rollback on failure.
 */
export async function syncDynamicRulesAtomically(
  targetRules: chrome.declarativeNetRequest.Rule[]
): Promise<RuleSyncOutcome> {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.getDynamicRules) {
    return { success: true, installedCount: targetRules.length, removedCount: 0 };
  }

  let previousRules: chrome.declarativeNetRequest.Rule[] = [];
  try {
    previousRules = await chrome.declarativeNetRequest.getDynamicRules();
  } catch (err) {
    return { success: false, installedCount: 0, removedCount: 0, error: `fetch current rules failed: ${String(err)}` };
  }

  const removeRuleIds = previousRules.map((r) => r.id);

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds,
      addRules: targetRules
    });
    return {
      success: true,
      installedCount: targetRules.length,
      removedCount: removeRuleIds.length
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    // Rollback attempt
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: targetRules.map((r) => r.id),
        addRules: previousRules
      });
    } catch {
      // Rollback error secondary
    }
    return {
      success: false,
      installedCount: 0,
      removedCount: 0,
      error: `atomic sync failed, rolled back: ${errorMsg}`
    };
  }
}

/**
 * Creates a site pause session rule for a given domain.
 */
export function createSitePauseSessionRule(domain: string, numericId = 20001): chrome.declarativeNetRequest.Rule {
  const cleanDomain = domain.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
  return {
    id: numericId,
    priority: 20000,
    action: { type: 'allow' },
    condition: {
      initiatorDomains: [cleanDomain]
    }
  };
}
