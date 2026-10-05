import { describe, it, expect, vi } from 'vitest';
import { PRESETS, matchPreset, defaultSettings } from '../core/storage/schema.js';
import { applyPreset } from '../core/storage/settings.js';
import { validateSettings } from '../core/validation/schemas.js';
import trackingParams from '../data/tracking-params.json';
import mainRules from '../rules/main.json';
import annoyancesRules from '../rules/annoyances.json';
import { createRpcRouter, CONTENT_SCRIPT_ALLOWED_TYPES, PRIVILEGED_MESSAGE_TYPES } from '../platform-chrome/rpc/rpc.js';

describe('Phase 1 Feature Enhancements & Preset Differentiation', () => {
  it('differentiates Strong from Balanced with explicit Annoyance blocking', () => {
    const balanced = applyPreset(defaultSettings(), 'balanced');
    const strong = applyPreset(defaultSettings(), 'strong');

    // Modules must differ in effective behavior
    expect(balanced.modules.annoyances).toBe(false);
    expect(strong.modules.annoyances).toBe(true);
    expect(balanced.modules).not.toEqual(strong.modules);

    // matchPreset resolves each correctly without tie-break workarounds
    expect(matchPreset(balanced)).toBe('balanced');
    expect(matchPreset(strong)).toBe('strong');
  });

  it('guarantees each preset has a distinct, valid module profile', () => {
    const profiles = ['basic', 'balanced', 'strong', 'maximum'] as const;
    const moduleConfigs = profiles.map((p) => PRESETS[p].modules);

    // Ensure no duplicate profiles across the standard presets
    for (let i = 0; i < moduleConfigs.length; i++) {
      for (let j = i + 1; j < moduleConfigs.length; j++) {
        expect(moduleConfigs[i]).not.toEqual(moduleConfigs[j]);
      }
    }

    // All presets pass validation
    for (const p of profiles) {
      const s = applyPreset(defaultSettings(), p);
      expect(validateSettings(s).ok).toBe(true);
    }
  });

  it('compiles static annoyances rules with sequential IDs and third-party scoping', () => {
    expect(annoyancesRules.length).toBeGreaterThan(0);
    for (let i = 0; i < annoyancesRules.length; i++) {
      const rule = annoyancesRules[i] as { id: number; condition: { domainType?: string } };
      expect(rule.id).toBe(i + 1);
      expect(rule.condition.domainType).toBe('thirdParty');
    }
  });

  it('includes complete modern tracking parameters in data/tracking-params.json and rules/main.json', () => {
    const requiredParams = ['ttclid', 'li_fat_id', 'epik', '_openstat', 'srsltid', 'gbraid', 'wbraid'];
    for (const param of requiredParams) {
      expect(trackingParams).toContain(param);
    }

    const mainRuleTransforms = mainRules
      .filter((r) => r.action.type === 'redirect' && r.action.redirect?.transform?.queryTransform?.removeParams)
      .flatMap((r) => r.action.redirect?.transform?.queryTransform?.removeParams ?? []);

    for (const param of requiredParams) {
      expect(mainRuleTransforms).toContain(param);
    }
  });

  it('enforces deny-by-default RPC security: content scripts cannot read sensitive data', async () => {
    const fakeExtId = 'auvyq-extension-id-phase1';
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: fakeExtId,
        getURL: (path: string) => `chrome-extension://${fakeExtId}/${path}`
      }
    };

    const handlers = {
      GET_COOKIE_REPORT: vi.fn().mockResolvedValue([{ name: 'session', domain: 'internal.corp' }]),
      GET_THREAT_LOG: vi.fn().mockResolvedValue({ total: 1, entries: [] }),
      GET_SETTINGS: vi.fn().mockResolvedValue({ preset: 'maximum' }),
      GET_COSMETIC: vi.fn().mockResolvedValue({ css: '.ad { display: none; }' }),
      REPORT_COSMETIC: vi.fn().mockResolvedValue({ ack: true }),
      GET_TAB_STATE: vi.fn().mockResolvedValue({ state: null })
    };

    const router = createRpcRouter(handlers);
    const untrustedContentSender: chrome.runtime.MessageSender = {
      id: fakeExtId,
      url: 'https://foreign-website.example/page'
    };

    // Sensitive reads are blocked by default
    const sensitiveTypes = ['GET_COOKIE_REPORT', 'GET_THREAT_LOG', 'GET_SETTINGS'];
    for (const type of sensitiveTypes) {
      const res = await router.handle({ v: 1, type, requestId: `req-${type}` }, untrustedContentSender);
      expect(res.success).toBe(false);
      expect(res.error).toContain('unauthorized');
    }

    // Allowed content script types pass through
    expect(CONTENT_SCRIPT_ALLOWED_TYPES.has('GET_COSMETIC')).toBe(true);
    const allowedRes = await router.handle({ v: 1, type: 'GET_COSMETIC', requestId: 'req-ok', payload: { host: 'example.com' } }, untrustedContentSender);
    expect(allowedRes.success).toBe(true);
    expect(handlers.GET_COSMETIC).toHaveBeenCalled();
  });
});
