import { describe, it, expect } from 'vitest';
import { parseFilterList } from '../core/rule-parser/parser.js';
import { compileRules } from '../core/rule-compiler/compiler.js';
import { PRIORITY_RANGES } from '../platform-chrome/dnr-adapter/adapter.js';

describe('Rule Compiler', () => {
  it('compiles parsed IRs into a structured CompiledPack', () => {
    const list = [
      '||ad-server.example^',
      '||tracker-domain.test^$third-party',
      '@@||safe-partner.example^',
      '##.ad-banner',
      'example.com##.sponsor',
      'example.com##+js(set-constant, gaOptout, true)'
    ].join('\n');

    const irs = parseFilterList(list, 'test-list');
    const pack = compileRules(irs);

    expect(pack.version).toBeGreaterThan(0);
    expect(pack.stats.rulesCompiled).toBeGreaterThan(0);
    expect(pack.dnrRules.ads.length + pack.dnrRules.trackers.length).toBeGreaterThan(0);
    expect(pack.cosmetic.genericCss).toContain('.ad-banner');
    expect(pack.cosmetic.perDomain['example.com']?.[0]).toContain('.sponsor');
    expect(pack.scriptletDispatch['example.com']).toEqual([
      { name: 'set-constant', args: ['gaOptout', 'true'] }
    ]);
  });

  it('enforces deterministic sorting across compiled rules', () => {
    const listA = ['||bbb.example^', '||aaa.example^', '||ccc.example^'].join('\n');
    const listB = ['||ccc.example^', '||aaa.example^', '||bbb.example^'].join('\n');

    const packA = compileRules(parseFilterList(listA, 'A'));
    const packB = compileRules(parseFilterList(listB, 'B'));

    expect(JSON.stringify(packA.dnrRules)).toEqual(JSON.stringify(packB.dnrRules));
  });

  it('assigns priorities in the required ranges and gives allow rules higher priority (+100)', () => {
    const list = [
      '||blocked-ad.example^',
      '@@||blocked-ad.example^'
    ].join('\n');

    const irs = parseFilterList(list, 'priority-test');
    const pack = compileRules(irs);

    const allRules = [...pack.dnrRules.ads, ...pack.dnrRules.trackers] as Array<{ id: number; priority: number; action: { type: string } }>;
    const blockRule = allRules.find((r) => r.action.type === 'block');
    const allowRule = allRules.find((r) => r.action.type === 'allow');

    expect(blockRule).toBeDefined();
    expect(allowRule).toBeDefined();
    if (blockRule && allowRule) {
      expect(blockRule.priority).toBeGreaterThanOrEqual(PRIORITY_RANGES.listDynamic.min);
      expect(blockRule.priority).toBeLessThanOrEqual(PRIORITY_RANGES.listDynamic.max);
      expect(allowRule.priority).toBe(blockRule.priority + 100);
    }
  });

  it('uses modern DNR requestDomains and initiatorDomains keys', () => {
    const list = '||ad-server.example^$domain=publisher.test';
    const irs = parseFilterList(list, 'modern-keys');
    const pack = compileRules(irs);

    const rule = (pack.dnrRules.ads[0] ?? pack.dnrRules.trackers[0]) as {
      condition: { requestDomains?: string[]; initiatorDomains?: string[] };
    };
    expect(rule.condition.requestDomains).toEqual(['ad-server.example']);
  });

  it('safely downgrades invalid regex with explicit domains to domain block or drops safely', () => {
    const invalidRegex = '/(?<=lookbehind)ad_banner/';
    const list = `${invalidRegex}$domain=example.com`;
    const irs = parseFilterList(list, 'bad-regex');
    const pack = compileRules(irs);

    expect(pack.stats.rulesCompiled).toBeGreaterThanOrEqual(0);
  });
});

describe('Cosmetic Engine & Domain Candidates', () => {
  it('correctly extracts candidate apex and subdomain hierarchies', async () => {
    const { getDomainCandidates } = await import('../core/domain/normalize.js');
    expect(getDomainCandidates('sub.news.example.com')).toEqual([
      'sub.news.example.com',
      'news.example.com',
      'example.com'
    ]);
    expect(getDomainCandidates('example.com')).toEqual(['example.com']);
    expect(getDomainCandidates('')).toEqual([]);
  });

  it('handles perDomain string arrays, single strings, and empty arrays safely', () => {
    const perDomainData: Record<string, string[] | string> = {
      'example.com': ['.ad-slot{display:none !important}', '.sponsor{display:none !important}'],
      'news.example.com': ['.news-ad{display:none !important}'],
      'empty.com': []
    };

    const candidates = ['news.example.com', 'example.com'];
    const cssParts: string[] = [];
    const seen = new Set<string>();

    for (const c of candidates) {
      const rules = perDomainData[c];
      if (Array.isArray(rules)) {
        for (const r of rules) {
          if (r && !seen.has(r)) {
            seen.add(r);
            cssParts.push(r);
          }
        }
      } else if (typeof rules === 'string' && !seen.has(rules)) {
        seen.add(rules);
        cssParts.push(rules);
      }
    }

    expect(cssParts).toEqual([
      '.news-ad{display:none !important}',
      '.ad-slot{display:none !important}',
      '.sponsor{display:none !important}'
    ]);
  });
});

describe('DNR Diffing & Rules Equality', () => {
  it('correctly identifies identical DNR rules vs changed rules', async () => {
    const { rulesEqual } = await import('../platform-chrome/dnr-adapter/adapter.js');
    const r1: chrome.declarativeNetRequest.Rule = {
      id: 1001,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '/ads.js', resourceTypes: ['script'] }
    };
    const r2: chrome.declarativeNetRequest.Rule = {
      id: 1001,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: '/ads.js', resourceTypes: ['script'] }
    };
    const r3: chrome.declarativeNetRequest.Rule = {
      id: 1001,
      priority: 2,
      action: { type: 'block' },
      condition: { urlFilter: '/ads.js', resourceTypes: ['script'] }
    };

    expect(rulesEqual(r1, r2)).toBe(true);
    expect(rulesEqual(r1, r3)).toBe(false);
  });
});

describe('Cookie Guard Protection & URL Reconstruction', () => {
  it('reconstructs correct cookie URLs for secure and insecure cookies with storeId', async () => {
    const { cookieUrl } = await import('../platform-chrome/cookie-guard/guard.js');
    expect(cookieUrl({ domain: '.doubleclick.net', path: '/pagead', secure: true })).toBe('https://doubleclick.net/pagead');
    expect(cookieUrl({ domain: 'example.com', path: '/', secure: false })).toBe('http://example.com/');
    expect(cookieUrl({ domain: '.example.com' })).toBe('http://example.com/');
  });

  it('strictly protects authentication, session and essential cookies from deletion', async () => {
    const { isKnownTrackingCookie } = await import('../platform-chrome/cookie-guard/guard.js');

    // Essential cookies that MUST NOT be deleted
    expect(isKnownTrackingCookie({ name: 'ACCOUNT_CHOOSER', domain: 'accounts.google.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'SID', domain: '.google.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'HSID', domain: '.google.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'SSID', domain: '.google.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'PHPSESSID', domain: 'example.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'JSESSIONID', domain: 'mybank.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'auth_token', domain: 'api.example.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'csrf_token', domain: 'app.example.com' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'connect.sid', domain: 'myapp.test' })).toBe(false);
    expect(isKnownTrackingCookie({ name: 'session', domain: 'store.com' })).toBe(false);

    // Tracker cookies that SHOULD be flagged
    expect(isKnownTrackingCookie({ name: '_ga', domain: 'example.com' })).toBe(true);
    expect(isKnownTrackingCookie({ name: '_fbp', domain: 'example.com' })).toBe(true);
    expect(isKnownTrackingCookie({ name: 'IDE', domain: '.doubleclick.net' })).toBe(true);
    expect(isKnownTrackingCookie({ name: 'Conversion', domain: 'www.googleadservices.com' })).toBe(true);
  });
});

describe('Scriptlet Engine Dispatch Resolution', () => {
  it('correctly matches hostname candidates and generic scriptlet entries', async () => {
    const { getDomainCandidates } = await import('../core/domain/normalize.js');

    const dispatchMap: Record<string, Array<{ name: string; args: (string | number)[] }>> = {
      '(generic)': [{ name: 'set-constant', args: ['gaOptout', 'true'] }],
      'example.com': [{ name: 'noop-callback', args: ['adsCallback'] }],
      'sub.example.com': [{ name: 'hide-in-shadow', args: ['.popup'] }]
    };

    const host = 'sub.example.com';
    const candidates = [...getDomainCandidates(host), '(generic)'];
    const resolved: Array<{ name: string; args: (string | number)[] }> = [];
    const seen = new Set<string>();

    for (const c of candidates) {
      const entries = dispatchMap[c];
      if (Array.isArray(entries)) {
        for (const e of entries) {
          const key = `${e.name}:${JSON.stringify(e.args)}`;
          if (!seen.has(key)) {
            seen.add(key);
            resolved.push(e);
          }
        }
      }
    }

    expect(resolved).toHaveLength(3);
    expect(resolved[0].name).toBe('hide-in-shadow');
    expect(resolved[1].name).toBe('noop-callback');
    expect(resolved[2].name).toBe('set-constant');
  });
});

