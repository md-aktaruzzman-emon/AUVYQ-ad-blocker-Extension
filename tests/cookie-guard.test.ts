import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyCookieDomain,
  isTrackerDomain,
  isKnownTrackingCookie,
  cookieUrl,
  sweepTrackerCookies,
  COOKIE_SWEEP_PERIOD_MINUTES,
  COOKIE_SWEEP_ALARM
} from '../platform-chrome/cookie-guard/guard.js';
import { defaultSettings } from '../core/storage/schema.js';

describe('Cookie Guard Engine & Classification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('configures safe periodic sweep alarm period', () => {
    expect(COOKIE_SWEEP_PERIOD_MINUTES).toBe(15);
    expect(COOKIE_SWEEP_ALARM).toBe('auvyq-cookie-sweep');
  });

  it('classifies tracker domains accurately from database', () => {
    expect(classifyCookieDomain('adservice.google.com')).toBe('tracker');
    expect(classifyCookieDomain('doubleclick.net')).toBe('tracker');
    expect(classifyCookieDomain('adnxs.com')).toBe('tracker');
    expect(classifyCookieDomain('facebook.com')).toBe('tracker');
    expect(isTrackerDomain('pagead2.googlesyndication.com')).toBe(true);
    expect(isTrackerDomain('myblog.example.com')).toBe(false);
  });

  it('correctly constructs cookie URLs for removal', () => {
    expect(cookieUrl({ domain: 'doubleclick.net', path: '/pagead', secure: true })).toBe('https://doubleclick.net/pagead');
    expect(cookieUrl({ domain: '.example.com', path: '/app', secure: false })).toBe('http://example.com/app');
    expect(cookieUrl({ domain: 'example.org' })).toBe('http://example.org/');
  });

  it('strictly preserves authentication, tokens, and identity cookies', () => {
    const authCookies = [
      { name: 'ACCOUNT_CHOOSER', domain: 'accounts.google.com' },
      { name: 'SID', domain: '.google.com' },
      { name: 'HSID', domain: '.google.com' },
      { name: 'SSID', domain: '.google.com' },
      { name: 'APISID', domain: '.google.com' },
      { name: 'SAPISID', domain: '.google.com' },
      { name: '__Secure-3PAPISID', domain: '.google.com' },
      { name: '__cf_bm', domain: '.example.com' },
      { name: '__cfuvid', domain: '.cloudflare.com' },
      { name: 'cf_clearance', domain: '.example.com' },
      { name: '__Secure-1PSID', domain: '.google.com' },
      { name: '__Host-session', domain: 'mybank.com' },
      { name: 'jwt_token', domain: 'api.service.io' },
      { name: 'csrf_token', domain: 'portal.example' },
      { name: 'PHPSESSID', domain: 'store.test' },
      { name: 'JSESSIONID', domain: 'enterprise.local' },
      { name: 'auth_token', domain: 'auth.company.org' },
      { name: 'remember_web_5943', domain: 'app.xyz' },
      { name: 'wordpress_logged_in_abc', domain: 'blog.com' }
    ];

    for (const cookie of authCookies) {
      expect(isKnownTrackingCookie(cookie), `Expected ${cookie.name} on ${cookie.domain} to be protected`).toBe(false);
    }
  });

  it('identifies recognized advertising and profiling tracking cookies', () => {
    const trackerCookies = [
      { name: 'Conversion', domain: 'googleadservices.com' },
      { name: 'IDE', domain: '.doubleclick.net' },
      { name: '_fbp', domain: '.example.com' },
      { name: '_fbc', domain: '.example.com' },
      { name: 'fr', domain: '.facebook.com' },
      { name: '1P_JAR', domain: '.google.com' },
      { name: 'NID', domain: '.google.com' },
      { name: 'ANID', domain: '.google.com' },
      { name: '_uetsid', domain: '.bing.com' },
      { name: 'uuid2', domain: '.adnxs.com' },
      { name: '_ga', domain: '.example.com' },
      { name: '_gid', domain: '.example.com' }
    ];

    for (const cookie of trackerCookies) {
      expect(isKnownTrackingCookie(cookie), `Expected ${cookie.name} on ${cookie.domain} to be flagged`).toBe(true);
    }
  });

  it('sweeps only tracker cookies and leaves session cookies unharmed in mock Chrome environment', async () => {
    const removedNames: string[] = [];
    const mockChrome = {
      cookies: {
        getAll: vi.fn().mockResolvedValue([
          // Essential cookies — must NEVER be removed
          { name: 'SID', domain: '.google.com', path: '/', secure: true, storeId: '0' },
          { name: 'PHPSESSID', domain: 'example.com', path: '/', secure: false, storeId: '0' },
          // Tracker cookies on a verified tracker domain — MUST be removed
          { name: 'IDE', domain: '.doubleclick.net', path: '/', secure: true, storeId: '0' },
          { name: 'DSID', domain: '.doubleclick.net', path: '/', secure: true, storeId: '0' }
        ]),
        remove: vi.fn().mockImplementation((details: { url: string; name: string }) => {
          removedNames.push(details.name);
          return Promise.resolve({ name: details.name, url: details.url });
        })
      }
    };
    // Set on both globalThis and global for test environment compatibility
    (globalThis as unknown as Record<string, unknown>).chrome = mockChrome;
    (global as unknown as Record<string, unknown>).chrome = mockChrome;

    const settings = defaultSettings();
    const result = await sweepTrackerCookies(settings);

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(removedNames.includes('IDE')).toBe(true);
    // Crucial: SID and PHPSESSID must NEVER be removed
    expect(removedNames.includes('SID')).toBe(false);
    expect(removedNames.includes('PHPSESSID')).toBe(false);
  });
});
