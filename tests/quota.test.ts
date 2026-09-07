import { describe, it, expect } from 'vitest';
import { scoreRule, applyQuota, type QuotaCandidate, SAFE_DYNAMIC_CAPACITY } from '../core/quota-manager/quota.js';

describe('Quota Manager', () => {
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
});
