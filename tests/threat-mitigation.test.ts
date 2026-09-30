import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setSiteBlock, siteBlockRuleId, PRIORITY_RANGES } from '../platform-chrome/dnr-adapter/adapter.js';
import { derToRawSignature } from '../core/update-channel/channel.js';

interface SessionRuleUpdate {
  removeRuleIds?: number[];
  addRules?: Array<{ id: number; action: { type: string }; priority: number; condition?: unknown }>;
}

describe('Threat Mitigation & DNR Dynamic Block Rules', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('computes deterministic, bounded session rule IDs for threat block rules', () => {
    const id1 = siteBlockRuleId('phishing-site.example');
    const id2 = siteBlockRuleId('phishing-site.example');
    const id3 = siteBlockRuleId('malware-site.test');

    expect(id1).toBe(id2);
    expect(id1).toBeGreaterThanOrEqual(PRIORITY_RANGES.userSession.min);
    expect(id1).toBeLessThanOrEqual(PRIORITY_RANGES.userSession.max);
    expect(id3).toBeGreaterThanOrEqual(PRIORITY_RANGES.userSession.min);
  });

  it('installs DNR session block rules when setSiteBlock is called with true', async () => {
    let lastUpdate: SessionRuleUpdate | null = null;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      declarativeNetRequest: {
        updateSessionRules: vi.fn().mockImplementation((rules: SessionRuleUpdate) => {
          lastUpdate = rules;
          return Promise.resolve();
        })
      }
    };

    const host = 'malicious-domain.test';
    const success = await setSiteBlock(host, true);

    expect(success).toBe(true);
    expect(lastUpdate).not.toBeNull();

    const update = lastUpdate as unknown as SessionRuleUpdate;
    expect(update.addRules).toHaveLength(2);
    expect(update.addRules?.[0]?.action.type).toBe('block');
    expect(update.addRules?.[0]?.priority).toBe(PRIORITY_RANGES.userSession.max - 10);
  });

  it('removes DNR session block rules when setSiteBlock is called with false', async () => {
    let lastUpdate: SessionRuleUpdate | null = null;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      declarativeNetRequest: {
        updateSessionRules: vi.fn().mockImplementation((rules: SessionRuleUpdate) => {
          lastUpdate = rules;
          return Promise.resolve();
        })
      }
    };

    const host = 'malicious-domain.test';
    const success = await setSiteBlock(host, false);

    expect(success).toBe(true);
    expect(lastUpdate).not.toBeNull();

    const update = lastUpdate as unknown as SessionRuleUpdate;
    expect(update.removeRuleIds).toBeDefined();
    expect(update.removeRuleIds?.length).toBe(2);
  });

  it('converts ASN.1 DER ECDSA signatures to 64-byte raw IEEE P1363 signatures', () => {
    // 64-byte raw signature should pass through unchanged
    const raw64 = new Uint8Array(64).fill(0x42);
    expect(derToRawSignature(raw64)).toBe(raw64);

    // Mock ASN.1 DER sequence of two 32-byte integers (0x30, len, 0x02, len, r..., 0x02, len, s...)
    const derSig = new Uint8Array([
      0x30, 0x44,
      0x02, 0x20, ...new Array(32).fill(0x01),
      0x02, 0x20, ...new Array(32).fill(0x02)
    ]);
    const converted = derToRawSignature(derSig);
    expect(converted.length).toBe(64);
    expect(converted[0]).toBe(0x01);
    expect(converted[32]).toBe(0x02);
  });
});
