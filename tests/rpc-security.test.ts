import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRpcRouter, PRIVILEGED_MESSAGE_TYPES, isPrivilegedSender } from '../platform-chrome/rpc/rpc.js';

describe('RPC Security & Sender Privilege Routing', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('correctly identifies privileged extension senders vs web page senders', () => {
    // Mock chrome extension environment
    const fakeExtId = 'auvyq-extension-id-12345';
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: fakeExtId,
        getURL: (path: string) => `chrome-extension://${fakeExtId}/${path}`
      }
    };

    const extSender: chrome.runtime.MessageSender = {
      id: fakeExtId,
      url: `chrome-extension://${fakeExtId}/ui/popup/popup.html`
    };

    const dashboardSender: chrome.runtime.MessageSender = {
      id: fakeExtId,
      url: `chrome-extension://${fakeExtId}/ui/dashboard/dashboard.html`
    };

    const dashboardTabSender: chrome.runtime.MessageSender = {
      id: fakeExtId,
      tab: { id: 101, url: `chrome-extension://${fakeExtId}/ui/dashboard/dashboard.html` } as chrome.tabs.Tab
    };

    const contentScriptSender: chrome.runtime.MessageSender = {
      id: fakeExtId,
      url: 'https://malicious-webpage.example/phishing'
    };

    const externalSender: chrome.runtime.MessageSender = {
      id: 'other-extension-id',
      url: 'chrome-extension://other-extension-id/popup.html'
    };

    expect(isPrivilegedSender(extSender)).toBe(true);
    expect(isPrivilegedSender(dashboardSender)).toBe(true);
    expect(isPrivilegedSender(dashboardTabSender)).toBe(true);
    expect(isPrivilegedSender(contentScriptSender)).toBe(false);
    expect(isPrivilegedSender(externalSender)).toBe(false);
  });

  it('rejects privileged RPC requests when initiated by untrusted senders', async () => {
    const fakeExtId = 'auvyq-extension-id-12345';
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: fakeExtId,
        getURL: (path: string) => `chrome-extension://${fakeExtId}/${path}`
      }
    };

    const handlers = {
      SET_SETTINGS: vi.fn().mockResolvedValue({ success: true }),
      CLEAR_AUVYQ_DATA: vi.fn().mockResolvedValue({ cleared: true }),
      GET_COSMETIC: vi.fn().mockResolvedValue({ css: '.ad{display:none}' })
    };

    const router = createRpcRouter(handlers);

    const maliciousContentSender: chrome.runtime.MessageSender = {
      id: fakeExtId,
      url: 'https://evil-site.example/'
    };

    // Attempt privileged settings change from web content script
    const res1 = await router.handle(
      { v: 1, type: 'SET_SETTINGS', requestId: 'req-1', payload: { masterEnabled: false } },
      maliciousContentSender
    );

    expect(res1.success).toBe(false);
    expect(res1.error).toContain('unauthorized');
    expect(handlers.SET_SETTINGS).not.toHaveBeenCalled();

    // Attempt data wipe from web content script
    const res2 = await router.handle(
      { v: 1, type: 'CLEAR_AUVYQ_DATA', requestId: 'req-2' },
      maliciousContentSender
    );

    expect(res2.success).toBe(false);
    expect(res2.error).toContain('unauthorized');
    expect(handlers.CLEAR_AUVYQ_DATA).not.toHaveBeenCalled();

    // Allow unprivileged read from content script
    const res3 = await router.handle(
      { v: 1, type: 'GET_COSMETIC', requestId: 'req-3', payload: { host: 'evil-site.example' } },
      maliciousContentSender
    );

    expect(res3.success).toBe(true);
    expect(handlers.GET_COSMETIC).toHaveBeenCalled();
  });

  it('allows privileged RPC requests from legitimate internal extension pages', async () => {
    const fakeExtId = 'auvyq-extension-id-12345';
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        id: fakeExtId,
        getURL: (path: string) => `chrome-extension://${fakeExtId}/${path}`
      }
    };

    const handlers = {
      SET_SETTINGS: vi.fn().mockResolvedValue({ success: true, updated: true })
    };

    const router = createRpcRouter(handlers);

    const popupSender: chrome.runtime.MessageSender = {
      id: fakeExtId,
      url: `chrome-extension://${fakeExtId}/ui/popup/popup.html`
    };

    const res = await router.handle(
      { v: 1, type: 'SET_SETTINGS', requestId: 'req-popup-1', payload: { preset: 'balanced' } },
      popupSender
    );

    expect(res.success).toBe(true);
    expect(res.requestId).toBe('req-popup-1');
    expect(handlers.SET_SETTINGS).toHaveBeenCalled();
  });

  it('verifies all expected administrative message types are in PRIVILEGED_MESSAGE_TYPES', () => {
    expect(PRIVILEGED_MESSAGE_TYPES.has('SET_SETTINGS')).toBe(true);
    expect(PRIVILEGED_MESSAGE_TYPES.has('SET_SITE_PAUSED')).toBe(true);
    expect(PRIVILEGED_MESSAGE_TYPES.has('CLEAR_AUVYQ_DATA')).toBe(true);
    expect(PRIVILEGED_MESSAGE_TYPES.has('EXPORT_BACKUP')).toBe(true);
    expect(PRIVILEGED_MESSAGE_TYPES.has('IMPORT_BACKUP')).toBe(true);
    expect(PRIVILEGED_MESSAGE_TYPES.has('CHECK_UPDATES')).toBe(true);
    expect(PRIVILEGED_MESSAGE_TYPES.has('REMOVE_COOKIES')).toBe(true);
    expect(PRIVILEGED_MESSAGE_TYPES.has('SET_ONBOARDING_DONE')).toBe(true);
  });
});
