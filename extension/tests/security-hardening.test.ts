import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isPrivilegedSender } from '../platform-chrome/rpc/rpc.js';
import { encryptBackup, decryptBackup } from '../core/crypto/vault.js';

describe('Part 2 Security Hardening Verification', () => {
  const extensionDir = path.resolve(__dirname, '..');

  describe('Content Script Anti-Fingerprinting & Isolation', () => {
    const contentDir = path.join(extensionDir, 'content');
    const contentFiles = fs.readdirSync(contentDir).filter((f) => f.endsWith('.js'));

    it('ensures no content script leaks window.__auvyq properties', () => {
      for (const file of contentFiles) {
        const fullPath = path.join(contentDir, file);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Verify window.__auvyq* is never set or exposed
        expect(content).not.toMatch(/window\.__auvyq/);
        expect(content).not.toMatch(/__auvyqFpActive/);
        expect(content).not.toMatch(/__auvyqDispatchActive/);
        expect(content).not.toMatch(/__auvyqCosmeticActive/);
        expect(content).not.toMatch(/__auvyqBannerActive/);
        expect(content).not.toMatch(/__auvyqNoop/);
        expect(content).not.toMatch(/__auvyqBlocked/);
      }
    });

    it('ensures no content script injects data-auvyq DOM attributes', () => {
      for (const file of contentFiles) {
        const fullPath = path.join(contentDir, file);
        const content = fs.readFileSync(fullPath, 'utf8');

        // Verify DOM elements cannot be fingerprinted via data-auvyq
        expect(content).not.toContain('data-auvyq');
        expect(content).not.toMatch(/setAttribute\(['"]data-auvyq/);
      }
    });

    it('ensures defensive guards use non-enumerable properties or private closures', () => {
      const fpShields = fs.readFileSync(path.join(contentDir, 'fp-shields.js'), 'utf8');
      expect(fpShields).toContain('Object.defineProperty');
      expect(fpShields).toContain('enumerable: false');
      expect(fpShields).toContain('writable: false');

      const scriptletDispatch = fs.readFileSync(path.join(contentDir, 'scriptlet-dispatch.js'), 'utf8');
      expect(scriptletDispatch).toContain('new WeakSet()');
    });
  });

  describe('Manifest Least-Privilege Permissions', () => {
    it('verifies declarativeNetRequestFeedback is removed from production manifest', () => {
      const manifestPath = path.join(extensionDir, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      expect(manifest.permissions).not.toContain('declarativeNetRequestFeedback');
      if (manifest.optional_permissions) {
        expect(manifest.optional_permissions).not.toContain('declarativeNetRequestFeedback');
      }

      // Verify all required core permissions remain intact
      const requiredPermissions = [
        'declarativeNetRequest',
        'storage',
        'unlimitedStorage',
        'scripting',
        'alarms',
        'offscreen',
        'webNavigation',
        'cookies',
        'tabs'
      ];
      for (const perm of requiredPermissions) {
        expect(manifest.permissions).toContain(perm);
      }
    });
  });

  describe('RPC Privilege Escalation Defenses', () => {
    const fakeExtId = 'auvyq-sec-test-id';

    beforeEach(() => {
      (globalThis as unknown as { chrome: unknown }).chrome = {
        runtime: {
          id: fakeExtId,
          getURL: (p: string) => `chrome-extension://${fakeExtId}/${p}`
        }
      };
    });

    it('rejects tab sender when tab URL is not from extension origin', () => {
      const spoofedSender: chrome.runtime.MessageSender = {
        id: fakeExtId,
        url: `chrome-extension://${fakeExtId}/ui/popup/popup.html`,
        tab: {
          id: 42,
          url: 'https://evil-hacker.example/phish'
        } as chrome.tabs.Tab
      };

      // Even if sender.url claims to be extension, tab context indicates it is from a web tab!
      expect(isPrivilegedSender(spoofedSender)).toBe(false);
    });

    it('rejects tab sender when tab URL is missing or non-string', () => {
      const malformedTabSender: chrome.runtime.MessageSender = {
        id: fakeExtId,
        tab: { id: 42 } as chrome.tabs.Tab
      };
      expect(isPrivilegedSender(malformedTabSender)).toBe(false);
    });

    it('allows tab sender when tab URL and sender URL strictly belong to extension origin', () => {
      const optionsTabSender: chrome.runtime.MessageSender = {
        id: fakeExtId,
        url: `chrome-extension://${fakeExtId}/ui/options/options.html`,
        tab: {
          id: 42,
          url: `chrome-extension://${fakeExtId}/ui/options/options.html`
        } as chrome.tabs.Tab
      };
      expect(isPrivilegedSender(optionsTabSender)).toBe(true);
    });

    it('allows popup sender without tab when url is within extension origin', () => {
      const popupSender: chrome.runtime.MessageSender = {
        id: fakeExtId,
        url: `chrome-extension://${fakeExtId}/ui/popup/popup.html`
      };
      expect(isPrivilegedSender(popupSender)).toBe(true);
    });

    it('rejects foreign extension senders even with valid-looking URL structure', () => {
      const foreignSender: chrome.runtime.MessageSender = {
        id: 'foreign-extension-id',
        url: `chrome-extension://${fakeExtId}/ui/popup/popup.html`
      };
      expect(isPrivilegedSender(foreignSender)).toBe(false);
    });
  });

  describe('Cryptographic Vault DoS and Tamper Resistance', () => {
    it('enforces maximum password length limit of 1024 characters on encrypt and decrypt', async () => {
      const excessivePassword = 'A'.repeat(1025);
      const samplePayload = JSON.stringify({
        v: 1,
        exportedAt: '2026-11-01T00:00:00Z',
        appVersion: '2.0.0',
        settings: {},
        customFilters: '',
        pausedSites: []
      });
      const meta = {
        app: 'AUVYQ' as const,
        kind: 'settings-backup' as const,
        createdAt: Date.now(),
        itemCount: 1
      };

      await expect(encryptBackup(samplePayload, excessivePassword, meta)).rejects.toThrow(
        'password must not exceed 1024 characters'
      );

      const fakeBuffer = new Uint8Array(64);
      await expect(decryptBackup(fakeBuffer, excessivePassword)).rejects.toThrow(
        'password must not exceed 1024 characters'
      );
    });
  });
});
