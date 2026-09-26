/*
 * Regression tests for the BUNDLED protection data:
 *   - data/default-filters.txt must parse with ZERO dropped rules and compile
 *     into a non-empty dynamic pack (otherwise first-run blocking is silent-dead).
 *   - rules/ads-trackers.json must be well-formed DNR (unique ids, non-empty
 *     batched requestDomains, no main_frame blocking).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilterListWithStats } from '../core/rule-parser/parser.js';
import { compileRulesDetailed } from '../core/rule-compiler/compiler.js';
import adsTrackersJson from '../rules/ads-trackers.json';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('bundled default filter pack', () => {
  const listText = readFileSync(path.join(__dirname, '../data/default-filters.txt'), 'utf8');

  it('parses with zero dropped rules', () => {
    const { stats } = parseFilterListWithStats(listText, 'default');
    expect(stats.parsed).toBeGreaterThan(0);
    expect(stats.dropped).toBe(0);
  });

  it('compiles into a non-empty DNR pack', () => {
    const { rules } = parseFilterListWithStats(listText, 'default');
    const compiled = compileRulesDetailed(rules);
    expect(compiled.pack.stats.dropped).toBe(0);
    expect(compiled.rules.length).toBeGreaterThan(0);
    // Every compiled rule must carry a real condition (no empty blocks).
    for (const entry of compiled.rules) {
      expect(Object.keys(entry.rule.condition).length).toBeGreaterThan(0);
    }
  });
});

describe('bundled static ad/tracker ruleset', () => {
  it('is well-formed: unique ids, batched domains, never blocks main_frame', () => {
    const rules = adsTrackersJson as Array<{ id: number; condition: { requestDomains?: string[]; resourceTypes?: string[] } }>;
    expect(rules.length).toBeGreaterThan(0);
    const ids = new Set<number>();
    for (const rule of rules) {
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
      expect(rule.condition.requestDomains?.length).toBeGreaterThan(0);
      expect(rule.condition.requestDomains?.every((d) => d.includes('.'))).toBe(true);
      expect(rule.condition.resourceTypes).not.toContain('main_frame');
    }
  });
});
