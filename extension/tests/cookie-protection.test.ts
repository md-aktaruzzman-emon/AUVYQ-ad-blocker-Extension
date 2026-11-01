import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isKnownTrackingCookie,
  classifyCookieDomain,
  truncateTrackerCookieLifetime,
  handleCookieChanged,
  sweepTrackerCookies,
  cookieUrl,
  MAX_TRACKER_LIFETIME_SECONDS
} from '../platform-chrome/cookie-guard/guard.js';
import { defaultSettings } from '../core/storage/schema.js';
import type { Settings } from '../types/schemas.js';

describe('Advanced Cookie Protection & Anti-Profiling Engine', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Tracking Cookie Recognition & Whitelist', () => {
    it('accurately identifies cross-site tracking and analytics cookies', () => {
      const trackingCookies = [
        { name: '_ga', domain: 'example.com' },
        { name: '_gid', domain: 'example.com' },
        { name: '_fbp', domain: 'shop.example' },
        { name: 'IDE', domain: '.doubleclick.net' },
        { name: '_ttp', domain: 'merchant.com' },
        { name: 'tt_webid', domain: 'merchant.com' },
        { name: '_pin_unauth', domain: 'store.org' },
        { name: 'sc_at', domain: 'app.xyz' },
        { name: 'bcookie', domain: '.linkedin.com' },
        { name: '_hjSessionUser_123', domain: 'saas.io' },
        { name: 'ajs_user_id', domain: 'platform.test' },
        { name: 'amplitude_id_abc', domain: 'mobile.com' },
        { name: 'cto_bundle', domain: 'criteo.com' },
        { name: 'irclickid', domain: 'affiliate.com' }
      ];

      for (const cookie of trackingCookies) {
        expect(isKnownTrackingCookie(cookie), `Cookie ${cookie.name} on ${cookie.domain} must be flagged as tracking`).toBe(true);
      }
    });

    it('strictly preserves authentication, shopping carts, session, and bot management cookies', () => {
      const protectedCookies = [
        // Google / SSO
        { name: 'ACCOUNT_CHOOSER', domain: 'accounts.google.com' },
        { name: 'SID', domain: '.google.com' },
        { name: 'HSID', domain: '.google.com' },
        { name: 'SSID', domain: '.google.com' },
        { name: 'APISID', domain: '.google.com' },
        { name: 'SAPISID', domain: '.google.com' },
        { name: '__Secure-3PAPISID', domain: '.google.com' },
        { name: '__Secure-1PSID', domain: '.google.com' },
        // Cloudflare / Bot Management
        { name: '__cf_bm', domain: '.example.com' },
        { name: '__cfuvid', domain: '.cloudflare.com' },
        { name: 'cf_clearance', domain: '.example.com' },
        // E-Commerce & Shopping Carts
        { name: 'cart', domain: 'store.myshopify.com' },
        { name: 'cart_id', domain: 'shop.com' },
        { name: 'checkout_token', domain: 'checkout.example' },
        { name: 'wp_woocommerce_session_123', domain: 'wordpress-shop.org' },
        { name: 'basket', domain: 'grocery.co.uk' },
        // App Sessions & Identity
        { name: 'PHPSESSID', domain: 'portal.test' },
        { name: 'JSESSIONID', domain: 'bank.com' },
        { name: 'connect.sid', domain: 'nodeapp.io' },
        { name: 'AWSALB', domain: 'lb.aws.com' },
        { name: 'auth_token', domain: 'api.service.io' },
        { name: 'csrf_token', domain: 'secure.local' }
      ];

      for (const cookie of protectedCookies) {
        expect(isKnownTrackingCookie(cookie), `Cookie ${cookie.name} MUST be protected from deletion`).toBe(false);
      }
    });
  });

  describe('Anti-Persistent Profiling: Cookie Lifetime Truncation', () => {
    it('truncates 2-year tracking cookies to a maximum of 24 hours', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const twoYearsInSec = 2 * 365 * 24 * 3600;

      const longLivedCookie: chrome.cookies.Cookie = {
        name: '_ga',
        value: 'GA1.2.123456789.1700000000',
        domain: '.example.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
        hostOnly: false,
        session: false,
        storeId: '0',
        expirationDate: nowSec + twoYearsInSec
      };

      let updatedCookie: chrome.cookies.SetDetails | null = null;
      (globalThis as unknown as { chrome: unknown }).chrome = {
        cookies: {
          set: vi.fn(async (details: chrome.cookies.SetDetails) => {
            updatedCookie = details;
            return details as unknown as chrome.cookies.Cookie;
          })
        }
      };

      const result = await truncateTrackerCookieLifetime(longLivedCookie);
      expect(result).toBe(true);
      expect(updatedCookie).not.toBeNull();
      // Expiration is truncated to nowSec + MAX_TRACKER_LIFETIME_SECONDS (within 5 seconds tolerance)
      expect(updatedCookie!.expirationDate).toBeCloseTo(nowSec + MAX_TRACKER_LIFETIME_SECONDS, -1);
      expect(updatedCookie!.name).toBe('_ga');
      expect(updatedCookie!.value).toBe(longLivedCookie.value);
    });

    it('leaves short-lived tracking cookies (<24 hours) unchanged', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const shortLivedCookie: chrome.cookies.Cookie = {
        name: '_gid',
        value: 'GA1.2.987654321',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
        hostOnly: false,
        session: false,
        storeId: '0',
        expirationDate: nowSec + 3600 // 1 hour remaining
      };

      const setSpy = vi.fn(async () => ({} as chrome.cookies.Cookie));
      (globalThis as unknown as { chrome: unknown }).chrome = { cookies: { set: setSpy } };

      const result = await truncateTrackerCookieLifetime(shortLivedCookie);
      expect(result).toBe(false);
      expect(setSpy).not.toHaveBeenCalled();
    });

    it('leaves session cookies (no expirationDate) untouched', async () => {
      const sessionCookie: chrome.cookies.Cookie = {
        name: 'session_tracker',
        value: 'abc',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'lax',
        hostOnly: false,
        session: true,
        storeId: '0'
      };

      const result = await truncateTrackerCookieLifetime(sessionCookie);
      expect(result).toBe(false);
    });
  });

  describe('Adaptive Preset Handling in handleCookieChanged', () => {
    it('immediately removes tracking cookies in Strong and Maximum presets', async () => {
      const removeSpy = vi.fn(async () => ({}));
      (globalThis as unknown as { chrome: unknown }).chrome = {
        cookies: { remove: removeSpy }
      };

      const settings: Settings = {
        ...defaultSettings(),
        preset: 'strong',
        modules: { ...defaultSettings().modules, cookies: true }
      };

      const changeInfo = {
        removed: false,
        cause: 'explicit' as const,
        cookie: {
          name: '_fbp',
          value: 'fb.1.1700000000',
          domain: 'tracker.example',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax' as const,
          hostOnly: false,
          session: false,
          storeId: '0',
          expirationDate: 1900000000
        }
      };

      const res = await handleCookieChanged(changeInfo, settings);
      expect(res.removed).toBe(true);
      expect(removeSpy).toHaveBeenCalledWith(expect.objectContaining({ name: '_fbp' }));
    });

    it('truncates lifetime instead of deleting in Balanced preset for compatibility', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      const setSpy = vi.fn(async () => ({} as chrome.cookies.Cookie));
      const removeSpy = vi.fn(async () => ({}));
      (globalThis as unknown as { chrome: unknown }).chrome = {
        cookies: { set: setSpy, remove: removeSpy }
      };

      const settings: Settings = {
        ...defaultSettings(),
        preset: 'balanced',
        modules: { ...defaultSettings().modules, cookies: true }
      };

      const changeInfo = {
        removed: false,
        cause: 'explicit' as const,
        cookie: {
          name: '_ga',
          value: 'val',
          domain: 'example.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax' as const,
          hostOnly: false,
          session: false,
          storeId: '0',
          expirationDate: nowSec + 1000000 // Multi-month cookie
        }
      };

      const res = await handleCookieChanged(changeInfo, settings);
      expect(res.removed).toBe(false);
      expect(res.truncated).toBe(true);
      expect(setSpy).toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    });

    it('takes zero action when cookies module is disabled or site is paused', async () => {
      const setSpy = vi.fn();
      const removeSpy = vi.fn();
      (globalThis as unknown as { chrome: unknown }).chrome = {
        cookies: { set: setSpy, remove: removeSpy }
      };

      const settings: Settings = {
        ...defaultSettings(),
        modules: { ...defaultSettings().modules, cookies: false }
      };

      const changeInfo = {
        removed: false,
        cause: 'explicit' as const,
        cookie: {
          name: '_ga',
          value: 'val',
          domain: 'example.com',
          path: '/',
          secure: true,
          httpOnly: false,
          sameSite: 'lax' as const,
          hostOnly: false,
          session: false,
          storeId: '0'
        }
      };

      const res = await handleCookieChanged(changeInfo, settings);
      expect(res.removed).toBe(false);
      expect(setSpy).not.toHaveBeenCalled();
      expect(removeSpy).not.toHaveBeenCalled();
    });
  });
});
