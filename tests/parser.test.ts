import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFilterList, parseFilterListWithStats } from '../core/rule-parser/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Filter List Parser', () => {
  it('parses the 80+ line fixture list correctly and counts stats', () => {
    const fixturePath = path.join(__dirname, '../fixtures/filter-list.txt');
    const fixtureText = readFileSync(fixturePath, 'utf8');
    const result = parseFilterListWithStats(fixtureText, 'fixture-list');

    expect(result.stats.total).toBeGreaterThanOrEqual(50);
    expect(result.stats.parsed).toBeGreaterThan(30);
    expect(result.rules.length).toBe(result.stats.parsed);
  });

  it('parses domain-anchored network block rules', () => {
    const text = '||ad-server.example^\n||tracker.net^$third-party\n||pixel.test^$image';
    const rules = parseFilterList(text, 'test-list');
    expect(rules.length).toBe(3);

    const first = rules[0];
    expect(first.kind).toBe('network');
    expect(first.network?.action).toBe('block');
    expect(first.network?.match.domains).toEqual(['ad-server.example']);

    const thirdParty = rules[1];
    expect(thirdParty.network?.match.thirdParty).toBe(true);

    const imageRule = rules[2];
    expect(imageRule.network?.match.resourceTypes).toEqual(['image']);
  });

  it('parses exception (allow) rules with @@ prefix', () => {
    const text = '@@||safe-site.example^$script\n@@||trusted.org^$image,domain=mycorp.test';
    const rules = parseFilterList(text, 'allow-list');
    expect(rules.length).toBe(2);
    expect(rules[0].network?.action).toBe('allow');
    expect(rules[1].network?.action).toBe('allow');
    expect(rules[1].network?.match.domains).toEqual(['trusted.org']);
  });

  it('parses cosmetic rules and separates domains from selectors', () => {
    const text = '##.ad-banner\nexample.com##.sponsor\nforum.test,blog.test##.cookie-nag';
    const rules = parseFilterList(text, 'cosmetics');
    expect(rules.length).toBe(3);

    expect(rules[0].kind).toBe('cosmetic');
    expect(rules[0].cosmetic?.isGeneric).toBe(true);
    expect(rules[0].cosmetic?.selector).toBe('.ad-banner');

    expect(rules[1].cosmetic?.isGeneric).toBe(false);
    expect(rules[1].cosmetic?.domains).toEqual(['example.com']);
    expect(rules[1].cosmetic?.selector).toBe('.sponsor');

    expect(rules[2].cosmetic?.domains).toEqual(['forum.test', 'blog.test']);
    expect(rules[2].cosmetic?.selector).toBe('.cookie-nag');
  });

  it('parses scriptlet injection rules', () => {
    const text = 'example.com##+js(set-constant, gaOptout, true)\ntracker.test##+js(noop-callback, onAdReady)';
    const rules = parseFilterList(text, 'scriptlets');
    expect(rules.length).toBe(2);
    expect(rules[0].kind).toBe('scriptlet');
    expect(rules[0].scriptlet?.name).toBe('set-constant');
    expect(rules[0].scriptlet?.args).toEqual(['gaOptout', 'true']);

    expect(rules[1].scriptlet?.name).toBe('noop-callback');
    expect(rules[1].scriptlet?.args).toEqual(['onAdReady']);
  });

  it('parses $removeparam rules correctly', () => {
    const text = '||campaign.test^$removeparam=utm_source\n||newsletter.example^$removeparam=mc_eid';
    const rules = parseFilterList(text, 'removeparam');
    expect(rules.length).toBe(2);
    expect(rules[0].kind).toBe('removeparam');
    expect(rules[0].network?.action).toBe('modifyQuery');
    expect(rules[0].network?.removeParams).toEqual(['utm_source']);
  });

  it('parses $redirect rules to safe local assets', () => {
    const text = '||pixel.test/track.gif$redirect=1x1.gif\n||script.test/beacon.js$redirect=noop.js';
    const rules = parseFilterList(text, 'redirects');
    expect(rules.length).toBe(2);
    expect(rules[0].kind).toBe('redirect');
    expect(rules[0].network?.redirectTarget).toBe('1x1.gif');
    expect(rules[1].network?.redirectTarget).toBe('noop.js');
  });

  it('deduplicates identical rules and counts them as dropped', () => {
    const text = '||duplicate.test^\n||duplicate.test^\n||duplicate.test^';
    const result = parseFilterListWithStats(text, 'dups');
    expect(result.rules.length).toBe(1);
    expect(result.stats.dropped).toBe(2);
    expect(result.stats.parsed).toBe(1);
  });

  it('safely drops malformed syntax, invalid delimiters, and control characters without throwing', () => {
    const badLines = [
      '#@%adguard-only-rule',
      '##.selector\u0000injected',
      '@@||$invalid-empty-pattern',
      '#@#cosmetic-exception-unsupported',
      '||bad-redirect.test^$redirect=http://evil.com/payload.js',
      '||bad-removeparam.test^$removeparam=*(.*)'
    ].join('\n');

    const result = parseFilterListWithStats(badLines, 'bad');
    expect(result.rules.length).toBe(0);
    expect(result.stats.dropped).toBe(6);
  });

  it('drops lines exceeding maximum allowed line length limit', () => {
    const hugeLine = '||' + 'a'.repeat(3000) + '.test^';
    const result = parseFilterListWithStats(hugeLine, 'huge');
    expect(result.rules.length).toBe(0);
    expect(result.stats.dropped).toBe(1);
  });
});
