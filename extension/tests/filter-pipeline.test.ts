import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// @ts-expect-error compile-filters is an ESM build tool
import { compileFilters, computeSha256 } from '../tools/compile-filters.mjs';

describe('Filter Compilation Pipeline & Integrity', () => {
  const extensionDir = path.resolve(__dirname, '..');
  const vendorDir = path.join(extensionDir, 'vendor');
  const rulesDir = path.join(extensionDir, 'rules');
  const dataDir = path.join(extensionDir, 'data');
  const licensesDir = path.join(extensionDir, 'licenses');

  it('verifies sources.json schema and upstream source configurations', () => {
    const sourcesPath = path.join(vendorDir, 'sources.json');
    expect(fs.existsSync(sourcesPath)).toBe(true);

    const sources = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
    expect(sources).toHaveProperty('version');
    expect(Array.isArray(sources.sources)).toBe(true);
    expect(sources.sources.length).toBeGreaterThanOrEqual(4);

    for (const src of sources.sources) {
      expect(src).toHaveProperty('id');
      expect(src).toHaveProperty('name');
      expect(src).toHaveProperty('upstreamUrl');
      expect(src).toHaveProperty('localFile');
      expect(src).toHaveProperty('license');
      expect(src).toHaveProperty('attribution');

      const fullLocalPath = path.join(extensionDir, src.localFile);
      expect(fs.existsSync(fullLocalPath)).toBe(true);
    }
  });

  it('generates complete open-source license attributions', () => {
    compileFilters(extensionDir);

    expect(fs.existsSync(path.join(licensesDir, 'EASYLIST-LICENSE.txt'))).toBe(true);
    expect(fs.existsSync(path.join(licensesDir, 'EASYPRIVACY-LICENSE.txt'))).toBe(true);
    expect(fs.existsSync(path.join(licensesDir, 'PETER-LOWE-LICENSE.txt'))).toBe(true);
    expect(fs.existsSync(path.join(licensesDir, 'UBLOCK-LICENSE.txt'))).toBe(true);

    const peterLowe = fs.readFileSync(path.join(licensesDir, 'PETER-LOWE-LICENSE.txt'), 'utf8');
    expect(peterLowe).toContain('Peter Lowe');
    expect(peterLowe).toContain('CC BY 3.0');
  });

  it('produces byte-for-byte deterministic output on repeated compilations', () => {
    const run1Meta = compileFilters(extensionDir);
    const run1Easylist = fs.readFileSync(path.join(rulesDir, 'easylist.json'), 'utf8');
    const run1Easyprivacy = fs.readFileSync(path.join(rulesDir, 'easyprivacy.json'), 'utf8');
    const run1Annoyances = fs.readFileSync(path.join(rulesDir, 'annoyances.json'), 'utf8');
    const run1Css = fs.readFileSync(path.join(dataDir, 'cosmetic', 'generic.css'), 'utf8');

    const run2Meta = compileFilters(extensionDir);
    const run2Easylist = fs.readFileSync(path.join(rulesDir, 'easylist.json'), 'utf8');
    const run2Easyprivacy = fs.readFileSync(path.join(rulesDir, 'easyprivacy.json'), 'utf8');
    const run2Annoyances = fs.readFileSync(path.join(rulesDir, 'annoyances.json'), 'utf8');
    const run2Css = fs.readFileSync(path.join(dataDir, 'cosmetic', 'generic.css'), 'utf8');

    expect(run1Easylist).toBe(run2Easylist);
    expect(run1Easyprivacy).toBe(run2Easyprivacy);
    expect(run1Annoyances).toBe(run2Annoyances);
    expect(run1Css).toBe(run2Css);
    expect(run1Meta.statistics.totalCompiledDnrRules).toBe(run2Meta.statistics.totalCompiledDnrRules);
  });

  it('strictly enforces unique integer rule IDs starting at 1 in each static ruleset', () => {
    const rulesets = ['easylist.json', 'easyprivacy.json', 'annoyances.json'];
    for (const rFile of rulesets) {
      const p = path.join(rulesDir, rFile);
      const rules = JSON.parse(fs.readFileSync(p, 'utf8'));

      expect(rules.length).toBeGreaterThan(0);
      const ids = new Set<number>();
      for (let i = 0; i < rules.length; i++) {
        const rule = rules[i];
        expect(typeof rule.id).toBe('number');
        expect(rule.id).toBe(i + 1);
        expect(ids.has(rule.id)).toBe(false);
        ids.add(rule.id);
      }
    }
  });

  it('detects and eliminates duplicate rule conditions', () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(dataDir, 'filter-metadata.json'), 'utf8'));
    expect(metadata.statistics.duplicatesEliminated).toBeGreaterThan(0);
  });

  it('prevents false-positive over-blocking on sub-path rules by preserving urlFilter', () => {
    const easyprivacy = JSON.parse(fs.readFileSync(path.join(rulesDir, 'easyprivacy.json'), 'utf8'));

    // Rule targeting facebook.com/tr? should NOT block entire facebook.com
    const trRule = easyprivacy.find((r: { condition?: { urlFilter?: string } }) =>
      r.condition?.urlFilter?.includes('/tr?')
    );
    expect(trRule).toBeDefined();
    // Must NOT have requestDomains: ['facebook.com']
    expect(trRule.condition.requestDomains).toBeUndefined();
    expect(trRule.condition.urlFilter).toContain('/tr?');
  });

  it('computes consistent cryptographic SHA-256 hashes of input source files', () => {
    const text = '||doubleclick.net^\n||googleadservices.com^\n';
    const hash = computeSha256(text);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(computeSha256(text));
  });

  it('generates filter-metadata.json recording comprehensive compilation statistics', () => {
    const metaPath = path.join(dataDir, 'filter-metadata.json');
    expect(fs.existsSync(metaPath)).toBe(true);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    expect(meta.engine).toContain('AUVYQ');
    expect(meta.statistics.totalCompiledDnrRules).toBeGreaterThanOrEqual(800);
    expect(meta.statistics.staticRulesets['rules/easylist.json']).toBeGreaterThanOrEqual(500);
    expect(meta.statistics.staticRulesets['rules/easyprivacy.json']).toBeGreaterThanOrEqual(100);
    expect(meta.statistics.staticRulesets['rules/annoyances.json']).toBeGreaterThanOrEqual(20);
    expect(meta.sources['easylist.txt']).toMatch(/^[0-9a-f]{64}$/);
  });
});
