import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compileUserRule, conditionFingerprint } from '../core/rule-manager/rule-manager.js';

interface DnrRule {
  id: number;
  priority: number;
  action: { type: string };
  condition: {
    urlFilter?: string;
    regexFilter?: string;
    requestDomains?: string[];
    resourceTypes?: string[];
    domainType?: string;
  };
}

/**
 * Lightweight test matcher that simulates Chrome Declarative Net Request matching
 * against a request URL, domain, and resource type.
 */
function testMatchesRule(rule: DnrRule, url: string, domain: string, resourceType: string, isThirdParty = true): boolean {
  const c = rule.condition;

  // 1. Check domainType (thirdParty / firstParty)
  if (c.domainType === 'thirdParty' && !isThirdParty) return false;
  if (c.domainType === 'firstParty' && isThirdParty) return false;

  // 2. Check resourceTypes
  if (c.resourceTypes && c.resourceTypes.length > 0) {
    if (!c.resourceTypes.includes(resourceType)) return false;
  }

  // 3. Check requestDomains
  if (c.requestDomains && c.requestDomains.length > 0) {
    const domainMatches = c.requestDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
    if (domainMatches) return true;
  }

  // 4. Check urlFilter
  if (c.urlFilter) {
    let pattern = c.urlFilter;
    if (pattern.startsWith('||')) {
      const rest = pattern.slice(2).replace(/\^.*$/, '');
      if (domain === rest || domain.endsWith(`.${rest}`)) return true;
      if (url.includes(pattern.slice(2).replace(/\^/, ''))) return true;
    } else if (url.includes(pattern)) {
      return true;
    }
  }

  // 5. Check regexFilter
  if (c.regexFilter) {
    try {
      const re = new RegExp(c.regexFilter);
      if (re.test(url)) return true;
    } catch {
      return false;
    }
  }

  return false;
}

describe('Filtering Effectiveness & False-Positive Prevention', () => {
  const rulesDir = path.resolve(__dirname, '..', 'rules');

  const easylist: DnrRule[] = JSON.parse(fs.readFileSync(path.join(rulesDir, 'easylist.json'), 'utf8'));
  const easyprivacy: DnrRule[] = JSON.parse(fs.readFileSync(path.join(rulesDir, 'easyprivacy.json'), 'utf8'));
  const annoyances: DnrRule[] = JSON.parse(fs.readFileSync(path.join(rulesDir, 'annoyances.json'), 'utf8'));
  const mainRules: DnrRule[] = JSON.parse(fs.readFileSync(path.join(rulesDir, 'main.json'), 'utf8'));
  const adsTrackers: DnrRule[] = JSON.parse(fs.readFileSync(path.join(rulesDir, 'ads-trackers.json'), 'utf8'));

  const allRules: DnrRule[] = [...easylist, ...easyprivacy, ...annoyances, ...mainRules, ...adsTrackers];

  describe('Advertising Request Coverage', () => {
    const testAdRequests = [
      { url: 'https://ad.doubleclick.net/ddm/adj/N1234.site', domain: 'ad.doubleclick.net', type: 'script' },
      { url: 'https://www.googleadservices.com/pagead/conversion/12345/', domain: 'www.googleadservices.com', type: 'script' },
      { url: 'https://static.criteo.net/js/ld/ld.js', domain: 'static.criteo.net', type: 'script' },
      { url: 'https://cdn.taboola.com/libtrc/unip/123456/tfa.js', domain: 'cdn.taboola.com', type: 'script' },
      { url: 'https://widgets.outbrain.com/outbrain.js', domain: 'widgets.outbrain.com', type: 'script' },
      { url: 'https://serve.popads.net/c?id=999', domain: 'serve.popads.net', type: 'script' },
      { url: 'https://contextual.media.net/nmedianet.js?cid=8CU', domain: 'contextual.media.net', type: 'script' },
      { url: 'https://ap.lijit.com/rtb/bid?id=123', domain: 'ap.lijit.com', type: 'xmlhttprequest' },
      { url: 'https://ads.yahoo.com/adserver/display', domain: 'ads.yahoo.com', type: 'sub_frame' },
      { url: 'https://c.amazon-adsystem.com/aax2/apstag.js', domain: 'c.amazon-adsystem.com', type: 'script' },
      { url: 'https://secure.adnxs.com/seg?add=1', domain: 'secure.adnxs.com', type: 'image' },
      { url: 'https://ib.adnxs.com/ttj?id=1234', domain: 'ib.adnxs.com', type: 'script' }
    ];

    it('successfully matches real-world advertisement network requests', () => {
      for (const req of testAdRequests) {
        const matched = allRules.some((rule) =>
          rule.action.type === 'block' && testMatchesRule(rule, req.url, req.domain, req.type, true)
        );
        expect(matched, `Expected ad request to be blocked: ${req.url}`).toBe(true);
      }
    });
  });

  describe('Tracker & Analytics Coverage', () => {
    const testTrackerRequests = [
      { url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-XYZ', domain: 'www.google-analytics.com', type: 'xmlhttprequest' },
      { url: 'https://www.facebook.com/tr/?id=123456789&ev=PageView', domain: 'www.facebook.com', type: 'image' },
      { url: 'https://analytics.tiktok.com/api/v2/pixel', domain: 'analytics.tiktok.com', type: 'xmlhttprequest' },
      { url: 'https://www.clarity.ms/tag/abc123', domain: 'www.clarity.ms', type: 'script' },
      { url: 'https://static.hotjar.com/c/hotjar-12345.js', domain: 'static.hotjar.com', type: 'script' },
      { url: 'https://api.mixpanel.com/track', domain: 'api.mixpanel.com', type: 'xmlhttprequest' },
      { url: 'https://sb.scorecardresearch.com/beacon.js', domain: 'sb.scorecardresearch.com', type: 'script' },
      { url: 'https://cdn.segment.com/analytics.js/v1/key/analytics.min.js', domain: 'cdn.segment.com', type: 'script' }
    ];

    it('successfully matches real-world tracking and analytics requests', () => {
      for (const req of testTrackerRequests) {
        const matched = allRules.some((rule) =>
          rule.action.type === 'block' && testMatchesRule(rule, req.url, req.domain, req.type, true)
        );
        expect(matched, `Expected tracker request to be blocked: ${req.url}`).toBe(true);
      }
    });
  });

  describe('Cookie Consent Platform Coverage', () => {
    const testConsentRequests = [
      { url: 'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js', domain: 'cdn.cookielaw.org', type: 'script' },
      { url: 'https://consent.cookiebot.com/uc.js', domain: 'consent.cookiebot.com', type: 'script' },
      { url: 'https://sdk.privacy-center.org/loader.js', domain: 'sdk.privacy-center.org', type: 'script' },
      { url: 'https://quantcast.mgr.consensu.org/choice/123/choice.js', domain: 'quantcast.mgr.consensu.org', type: 'script' },
      { url: 'https://app.usercentrics.eu/browser-sdk/3.0.0/loader.js', domain: 'app.usercentrics.eu', type: 'script' }
    ];

    it('successfully matches known cookie consent CMP scripts in third-party contexts', () => {
      for (const req of testConsentRequests) {
        const matched = allRules.some((rule) =>
          rule.action.type === 'block' && testMatchesRule(rule, req.url, req.domain, req.type, true)
        );
        expect(matched, `Expected cookie CMP request to be blocked: ${req.url}`).toBe(true);
      }
    });
  });

  describe('Zero False Positives on Critical Services', () => {
    const criticalLegitimateRequests = [
      { url: 'https://accounts.google.com/o/oauth2/auth', domain: 'accounts.google.com', type: 'main_frame' },
      { url: 'https://accounts.google.com/signin/v2/identifier', domain: 'accounts.google.com', type: 'xmlhttprequest' },
      { url: 'https://login.microsoftonline.com/common/oauth2/v2.0/token', domain: 'login.microsoftonline.com', type: 'xmlhttprequest' },
      { url: 'https://github.com/login/oauth/authorize', domain: 'github.com', type: 'main_frame' },
      { url: 'https://api.stripe.com/v1/tokens', domain: 'api.stripe.com', type: 'xmlhttprequest' },
      { url: 'https://checkout.stripe.com/c/pay', domain: 'checkout.stripe.com', type: 'main_frame' },
      { url: 'https://www.paypal.com/signin', domain: 'www.paypal.com', type: 'main_frame' },
      { url: 'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js', domain: 'cdnjs.cloudflare.com', type: 'script' },
      { url: 'https://cdn.jsdelivr.net/npm/vue@3.3.4/dist/vue.global.prod.js', domain: 'cdn.jsdelivr.net', type: 'script' },
      { url: 'https://s3.amazonaws.com/my-bucket/documents/report.pdf', domain: 's3.amazonaws.com', type: 'main_frame' }
    ];

    it('guarantees zero blocking of essential authentication, payment, and CDN services', () => {
      for (const req of criticalLegitimateRequests) {
        const incorrectlyBlocked = allRules.some((rule) =>
          rule.action.type === 'block' && testMatchesRule(rule, req.url, req.domain, req.type, false)
        );
        expect(incorrectlyBlocked, `False positive detected! Legitimate request blocked: ${req.url}`).toBe(false);
      }
    });
  });

  describe('Rule Prioritization & User Custom Overrides', () => {
    it('ensures user custom allow rules strictly outrank static and dynamic block rules', () => {
      const userAllowRule = compileUserRule('@@||ad.doubleclick.net^', 10001);
      expect(userAllowRule).not.toBeNull();
      if (!userAllowRule) return;

      expect(userAllowRule.priority).toBe(9500);
      expect(userAllowRule.action.type).toBe('allow');

      // Verify that user allow priority (9500) exceeds all static rule priorities (1-4)
      for (const rule of allRules) {
        expect(userAllowRule.priority).toBeGreaterThan(rule.priority);
      }
    });

    it('ensures user custom block rules have elevated priority over standard list rules', () => {
      const userBlockRule = compileUserRule('||custom-annoying-domain.com^', 10002);
      expect(userBlockRule).not.toBeNull();
      if (!userBlockRule) return;

      expect(userBlockRule.priority).toBe(9000);
      expect(userBlockRule.action.type).toBe('block');
      expect(userBlockRule.condition.urlFilter).toBe('||custom-annoying-domain.com^');

      for (const rule of allRules) {
        expect(userBlockRule.priority).toBeGreaterThan(rule.priority);
      }
    });

    it('generates consistent condition fingerprints to prevent duplicate user rules', () => {
      const cond1: chrome.declarativeNetRequest.RuleCondition = {
        urlFilter: '||tracker.com^',
        resourceTypes: ['script', 'image'] as chrome.declarativeNetRequest.ResourceType[]
      };
      const cond2: chrome.declarativeNetRequest.RuleCondition = {
        urlFilter: '||tracker.com^',
        resourceTypes: ['image', 'script'] as chrome.declarativeNetRequest.ResourceType[]
      };
      expect(conditionFingerprint(cond1)).toBe(conditionFingerprint(cond2));
    });
  });
});
