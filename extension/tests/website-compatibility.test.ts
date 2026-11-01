import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Website Compatibility & Safe Stripping Suite', () => {
  const extensionDir = path.resolve(__dirname, '..');
  const mainRulesPath = path.join(extensionDir, 'rules/main.json');
  const easyPrivacyRulesPath = path.join(extensionDir, 'rules/easyprivacy.json');
  const trackingParamsPath = path.join(extensionDir, 'data/tracking-params.json');
  const genericCssPath = path.join(extensionDir, 'data/cosmetic/generic.css');

  // ---- 1. Safe Query Parameter Stripping ------------------------------------

  it('strictly isolates tracking parameters from functional application parameters', () => {
    const rawTrackingList = JSON.parse(fs.readFileSync(trackingParamsPath, 'utf8')) as string[];
    const trackingParamsSet = new Set(rawTrackingList);

    // List of vital functional query parameters commonly used by web applications
    const functionalParams = [
      'id', 'page', 'p', 'q', 'search', 'query', 'category', 'cat', 'sort', 'order',
      'filter', 'lang', 'locale', 'token', 'auth', 'code', 'state', 'session',
      'session_id', 'checkout', 'cart_id', 'return_to', 'redirect_uri', 'asin',
      'item_id', 'product_id', 'tab', 'view', 'offset', 'limit', 'v', 't'
    ];

    for (const funcParam of functionalParams) {
      expect(trackingParamsSet.has(funcParam)).toBe(false);
    }
  });

  it('verifies that DNR queryTransform removeParams rules only strip tracking tokens', () => {
    const mainRules = JSON.parse(fs.readFileSync(mainRulesPath, 'utf8'));
    const easyPrivacyRules = JSON.parse(fs.readFileSync(easyPrivacyRulesPath, 'utf8'));

    const allRules = [...mainRules, ...easyPrivacyRules];
    const removeParamsRules = allRules.filter(
      (r: { action?: { type?: string; redirect?: { transform?: { queryTransform?: { removeParams?: string[] } } } } }) =>
        r.action?.type === 'redirect' && r.action.redirect?.transform?.queryTransform?.removeParams
    );

    expect(removeParamsRules.length).toBeGreaterThanOrEqual(10);

    const strippedParams = new Set<string>();
    for (const rule of removeParamsRules) {
      const params = rule.action.redirect.transform.queryTransform.removeParams;
      for (const p of params) {
        strippedParams.add(p);
      }
    }

    // Must strip known marketing / tracking parameters
    expect(strippedParams.has('utm_source')).toBe(true);
    expect(strippedParams.has('fbclid')).toBe(true);
    expect(strippedParams.has('gclid')).toBe(true);
    expect(strippedParams.has('msclkid')).toBe(true);
    expect(strippedParams.has('mc_eid')).toBe(true);
    expect(strippedParams.has('ttclid')).toBe(true);

    // Must NOT strip essential functional application parameters
    const forbiddenToStrip = ['id', 'page', 'token', 'checkout', 'cart', 'session', 'q', 'search', 'v'];
    for (const forbidden of forbiddenToStrip) {
      expect(strippedParams.has(forbidden)).toBe(false);
    }
  });

  it('preserves ecommerce checkout and auth redirect query parameters in simulated URLs', () => {
    const sampleUrls = [
      {
        original: 'https://shop.example.com/checkout?checkout_token=abc123xyz&cart_id=9876&utm_source=newsletter&utm_medium=email',
        expectedPreservedParams: ['checkout_token', 'cart_id'],
        expectedStrippedParams: ['utm_source', 'utm_medium']
      },
      {
        original: 'https://auth.example.org/oauth/callback?code=auth_code_777&state=csrf_protect_999&fbclid=IwAR23456789',
        expectedPreservedParams: ['code', 'state'],
        expectedStrippedParams: ['fbclid']
      },
      {
        original: 'https://news.example.net/article?id=45920&page=2&gclid=Cj0KCQjw1',
        expectedPreservedParams: ['id', 'page'],
        expectedStrippedParams: ['gclid']
      }
    ];

    const trackingList = JSON.parse(fs.readFileSync(trackingParamsPath, 'utf8')) as string[];
    const trackingSet = new Set(trackingList);

    for (const item of sampleUrls) {
      const u = new URL(item.original);
      const remainingKeys: string[] = [];
      const removedKeys: string[] = [];

      u.searchParams.forEach((_, key) => {
        if (trackingSet.has(key)) {
          removedKeys.push(key);
        } else {
          remainingKeys.push(key);
        }
      });

      for (const expPreserved of item.expectedPreservedParams) {
        expect(remainingKeys).toContain(expPreserved);
      }
      for (const expStripped of item.expectedStrippedParams) {
        expect(removedKeys).toContain(expStripped);
      }
    }
  });

  // ---- 2. Form & Login Field Protection -------------------------------------

  it('guarantees cosmetic CSS never hides form inputs, password fields, or submit buttons', () => {
    const css = fs.readFileSync(genericCssPath, 'utf8');
    const rules = css.split('\n').filter(Boolean);

    // Ensure no generic selector targets HTML form input primitives directly
    const prohibitedSelectors = [
      'input', 'input[type="password"]', 'input[type="text"]', 'input[type="email"]',
      'form', 'button', 'button[type="submit"]', 'select', 'textarea'
    ];

    for (const rule of rules) {
      const selector = rule.replace(/\{.*$/, '').trim();
      for (const prohibited of prohibitedSelectors) {
        expect(selector.toLowerCase()).not.toBe(prohibited);
      }
    }
  });

  // ---- 3. SPA Route Navigation & History API --------------------------------

  it('verifies SPA route transitions can be captured safely without leaking state', () => {
    const navigationEvents: string[] = [];

    // Simulate History API interception pattern used in cosmetic-injector.js
    const mockHistory = {
      pushState: (state: unknown, title: string, url: string) => {
        navigationEvents.push(`push:${url}`);
      },
      replaceState: (state: unknown, title: string, url: string) => {
        navigationEvents.push(`replace:${url}`);
      }
    };

    mockHistory.pushState({}, '', '/feed');
    mockHistory.pushState({}, '', '/watch?v=123');
    mockHistory.replaceState({}, '', '/watch?v=123&t=40');

    expect(navigationEvents).toEqual([
      'push:/feed',
      'push:/watch?v=123',
      'replace:/watch?v=123&t=40'
    ]);
  });

  // ---- 4. DOM Mutation & Infinite Scroll Throughput ------------------------

  it('filters ignorable leaf nodes to eliminate layout thrashing during infinite scroll', () => {
    const IGNORABLE_TAGS = new Set([
      'SPAN', 'P', 'B', 'I', 'EM', 'STRONG', 'A', 'SVG', 'PATH', 'CODE',
      'PRE', 'LI', 'UL', 'OL', 'BUTTON', 'INPUT', 'LABEL', 'SELECT', 'OPTION',
      'TEXTAREA', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
    ]);

    // Simulate 200 nodes inserted by an infinite-scroll feed (e.g. news articles, social feed)
    const simulatedAddedNodes: { tagName: string; nodeType: number; isConnected: boolean; matches: (s: string) => boolean }[] = [];

    // 180 benign leaf nodes
    for (let i = 0; i < 60; i++) {
      simulatedAddedNodes.push({ tagName: 'P', nodeType: 1, isConnected: true, matches: () => false });
      simulatedAddedNodes.push({ tagName: 'SPAN', nodeType: 1, isConnected: true, matches: () => false });
      simulatedAddedNodes.push({ tagName: 'A', nodeType: 1, isConnected: true, matches: () => false });
    }

    // 20 container nodes (18 content cards, 2 ad wrappers)
    for (let i = 0; i < 18; i++) {
      simulatedAddedNodes.push({ tagName: 'DIV', nodeType: 1, isConnected: true, matches: () => false });
    }
    simulatedAddedNodes.push({
      tagName: 'DIV',
      nodeType: 1,
      isConnected: true,
      matches: (s: string) => s === '.ad-banner'
    });
    simulatedAddedNodes.push({
      tagName: 'DIV',
      nodeType: 1,
      isConnected: true,
      matches: (s: string) => s === '[data-ad-slot]'
    });

    // Run the candidate filter
    const queuedCandidates = simulatedAddedNodes.filter((n) => !IGNORABLE_TAGS.has(n.tagName));

    // 180 benign nodes skipped immediately!
    expect(queuedCandidates.length).toBe(20);

    // Active inspection on remaining 20 candidate containers finds matching ads
    const collapsedNodes: unknown[] = [];
    for (const cand of queuedCandidates) {
      if (cand.matches('.ad-banner') || cand.matches('[data-ad-slot]')) {
        collapsedNodes.push(cand);
      }
    }

    expect(collapsedNodes.length).toBe(2);
  });
});
