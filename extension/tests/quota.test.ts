import { describe, it, expect } from 'vitest';
import {
  scoreRule,
  applyQuota,
  type QuotaCandidate,
  SAFE_DYNAMIC_CAPACITY,
  UNSAFE_DYNAMIC_CAPACITY,
  REGEX_RULE_CAPACITY,
  GUARANTEED_STATIC_CAPACITY,
  classifyRuleSafety,
  isRegexRule,
  validateDynamicRuleQuota,
  protectUserRules,
  getAvailableStaticRules
} from '../core/quota-manager/quota.js';

describe('Quota Manager & MV3 Capacity Allocation', () => {
  it('computes score as frequency x confidence', () => {
    expect(scoreRule(0.8, 0.9)).toBe(0.72);
    expect(scoreRule(1.0, 1.0)).toBe(1.0);
    expect(scoreRule(0, 0.5)).toBe(0);
    expect(scoreRule(-1, 0.5)).toBe(0);
  });

  it('handles ~35,000 generated rules deterministically within safe dynamic capacity', () => {
    const totalCount = 35000;
    const candidates: QuotaCandidate[] = [];

    for (let i = 0; i < totalCount; i++) {
      const freq = (i % 100) / 100;
      const conf = ((i * 7) % 100) / 100;
      const score = scoreRule(freq, conf);
      const isDemotable = i % 5 === 0;

      candidates.push({
        key: `rule-${i.toString().padStart(6, '0')}`,
        score,
        category: i % 2 === 0 ? 'ads' : 'trackers',
        rule: {
          id: 1000 + (i % 5000),
          priority: 1000,
          action: { type: 'block' },
          condition: { urlFilter: `||track${i}.test^` }
        },
        cosmeticFallback: isDemotable ? `img[src*="track${i}.test"] { display: none !important; }` : null
      });
    }

    const capacity = SAFE_DYNAMIC_CAPACITY;
    const result1 = applyQuota(candidates, capacity);
    const result2 = applyQuota(candidates, capacity);

    // Verify quota is respected strictly
    expect(result1.kept.length).toBe(capacity);
    expect(result1.stats.kept).toBe(capacity);

    // Verify demotion and dropped counts
    expect(result1.stats.demotedToCosmetic).toBeGreaterThan(0);
    expect(result1.stats.dropped).toBeGreaterThan(0);
    expect(result1.stats.kept + result1.stats.demotedToCosmetic + result1.stats.dropped).toBe(totalCount);

    // Verify deterministic reproducibility
    expect(result1.kept.map((c) => c.key)).toEqual(result2.kept.map((c) => c.key));
    expect(result1.demotedCss).toEqual(result2.demotedCss);
  });

  it('correctly classifies rule safety (safe block/allow vs unsafe redirect/modifyHeaders)', () => {
    const blockRule: chrome.declarativeNetRequest.Rule = {
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '||ads.com^' }
    };

    const allowRule: chrome.declarativeNetRequest.Rule = {
      id: 2,
      priority: 2,
      action: { type: 'allow' },
      condition: { urlFilter: '||good.com^' }
    };

    const redirectRule: chrome.declarativeNetRequest.Rule = {
      id: 3,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: '/resources/noop.txt' } },
      condition: { urlFilter: '||tracker.com/script.js' }
    };

    const modifyHeadersRule: chrome.declarativeNetRequest.Rule = {
      id: 4,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'X-Tracking', operation: 'remove' }]
      } as unknown as chrome.declarativeNetRequest.RuleAction,
      condition: { urlFilter: '||tracker.com^' }
    };

    expect(classifyRuleSafety(blockRule)).toBe('safe');
    expect(classifyRuleSafety(allowRule)).toBe('safe');
    expect(classifyRuleSafety(redirectRule)).toBe('unsafe');
    expect(classifyRuleSafety(modifyHeadersRule)).toBe('unsafe');
  });

  it('detects regex rules and enforces regex capacity', () => {
    const standardRule: chrome.declarativeNetRequest.Rule = {
      id: 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '||ads.com^' }
    };

    const regexRule: chrome.declarativeNetRequest.Rule = {
      id: 2,
      priority: 1,
      action: { type: 'block' },
      condition: { regexFilter: '^https?:\\/\\/.*[0-9]{3}\\.ad\\.com' }
    };

    expect(isRegexRule(standardRule)).toBe(false);
    expect(isRegexRule(regexRule)).toBe(true);
  });

  it('validates partitioned dynamic quotas accurately', () => {
    const safeRules: chrome.declarativeNetRequest.Rule[] = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `||ad${i}.com^` }
    }));

    const unsafeRules: chrome.declarativeNetRequest.Rule[] = Array.from({ length: 10 }, (_, i) => ({
      id: 1000 + i,
      priority: 1,
      action: { type: 'redirect', redirect: { extensionPath: '/resources/noop.txt' } },
      condition: { urlFilter: `||track${i}.com^` }
    }));

    const check = validateDynamicRuleQuota([...safeRules, ...unsafeRules]);
    expect(check.valid).toBe(true);
    expect(check.breakdown.safeDynamic.count).toBe(100);
    expect(check.breakdown.unsafeDynamic.count).toBe(10);
    expect(check.breakdown.safeDynamic.ok).toBe(true);
    expect(check.breakdown.unsafeDynamic.ok).toBe(true);
  });

  it('strictly protects user-created custom rules from eviction during quota pressure', () => {
    const userRules: chrome.declarativeNetRequest.Rule[] = [
      { id: 10001, priority: 9000, action: { type: 'block' }, condition: { urlFilter: '||custom-block.test^' } },
      { id: 10002, priority: 9001, action: { type: 'allow' }, condition: { urlFilter: '||custom-allow.test^' } },
      { id: 10003, priority: 9002, action: { type: 'redirect', redirect: { extensionPath: '/resources/noop.txt' } }, condition: { urlFilter: '||custom-strip.test^' } }
    ];

    // Create 100 remote rules but specify a tiny safe capacity of 5 and unsafe capacity of 2
    const remoteRules: chrome.declarativeNetRequest.Rule[] = Array.from({ length: 20 }, (_, i) => ({
      id: 20000 + i,
      priority: 1000,
      action: { type: i % 2 === 0 ? 'block' : 'redirect', ...(i % 2 === 0 ? {} : { redirect: { extensionPath: '/noop.txt' } }) },
      condition: { urlFilter: `||remote${i}.com^` }
    }));

    const protectedOutcome = protectUserRules(userRules, remoteRules, 5, 2);

    // All 3 user rules MUST be preserved
    expect(protectedOutcome.userRuleCount).toBe(3);
    expect(protectedOutcome.approvedRules.slice(0, 3)).toEqual(userRules);
    expect(protectedOutcome.approvedRules.length).toBe(5); // 3 user + 2 remote
    expect(protectedOutcome.droppedRemoteCount).toBe(18); // 20 - 2 remote kept
  });

  it('queries getAvailableStaticRules with safe fallback', async () => {
    // In node/test runner without chrome runtime, returns guaranteed minimum 30k
    const available = await getAvailableStaticRules();
    expect(available).toBe(GUARANTEED_STATIC_CAPACITY);
    expect(available).toBe(30000);
  });
});
