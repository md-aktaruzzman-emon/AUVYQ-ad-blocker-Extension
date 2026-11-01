import { describe, it, expect } from 'vitest';
import {
  DEV_VERIFY_KEY_JWK,
  PROD_VERIFY_KEY_JWK,
  importVerifyKey,
  derToRawSignature,
  verifySignature,
  signatureMessage,
  runUpdateCheck,
  defaultUpdateState
} from '../core/update-channel/channel.js';
import { sha256Hex } from '../core/crypto/vault.js';

describe('Update Channel Security & Verification', () => {
  it('strictly ensures public JWK contains no private signing key material', () => {
    // Critical: The extension package must NEVER ship private key material (the 'd' parameter)
    expect(DEV_VERIFY_KEY_JWK).toHaveProperty('kty', 'EC');
    expect(DEV_VERIFY_KEY_JWK).toHaveProperty('crv', 'P-256');
    expect(DEV_VERIFY_KEY_JWK).toHaveProperty('x');
    expect(DEV_VERIFY_KEY_JWK).toHaveProperty('y');
    expect((DEV_VERIFY_KEY_JWK as Record<string, unknown>)['d']).toBeUndefined();
    expect(DEV_VERIFY_KEY_JWK.key_ops).toEqual(['verify']);

    // Production key alias verification
    expect(PROD_VERIFY_KEY_JWK).toBe(DEV_VERIFY_KEY_JWK);
  });

  it('formats deterministic signature verification messages', () => {
    const msg = signatureMessage('easylist-lite', '2.0.0', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(msg).toBe('auvyq-update:easylist-lite:2.0.0:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('converts ASN.1 DER signatures to raw 64-byte IEEE P1363 signatures', () => {
    // 64-byte raw buffer passes through unchanged
    const raw64 = new Uint8Array(64).fill(0xaa);
    expect(derToRawSignature(raw64)).toEqual(raw64);

    // Simulated DER signature (0x30 ... 0x02 rLen r 0x02 sLen s)
    const r = new Uint8Array(32).fill(1);
    const s = new Uint8Array(32).fill(2);
    const der = new Uint8Array(2 + 2 + 32 + 2 + 32);
    der[0] = 0x30;
    der[1] = 68;
    der[2] = 0x02;
    der[3] = 32;
    der.set(r, 4);
    der[36] = 0x02;
    der[37] = 32;
    der.set(s, 38);

    const converted = derToRawSignature(der);
    expect(converted.length).toBe(64);
    expect(converted.subarray(0, 32)).toEqual(r);
    expect(converted.subarray(32, 64)).toEqual(s);
  });

  it('verifies valid ECDSA P-256 signatures and rejects tampered messages', async () => {
    // Generate an ephemeral test ECDSA key pair
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );

    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const message = 'auvyq-update:test-pack:1.0.1:abcd1234abcd';
    const messageBytes = new TextEncoder().encode(message);

    // Sign with private key (returns IEEE P1363 64-byte signature in Web Crypto)
    const rawSig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      messageBytes
    );
    const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(rawSig)));

    // 1. Valid signature passes verification
    const isValid = await verifySignature(message, sigBase64, publicJwk);
    expect(isValid).toBe(true);

    // 2. Tampered message fails verification
    const tamperedMessage = 'auvyq-update:test-pack:1.0.2:abcd1234abcd';
    const tamperedValid = await verifySignature(tamperedMessage, sigBase64, publicJwk);
    expect(tamperedValid).toBe(false);

    // 3. Corrupted signature fails verification
    const corruptedSigBytes = new Uint8Array(rawSig);
    corruptedSigBytes[0] ^= 0xff;
    const corruptedSigBase64 = btoa(String.fromCharCode(...corruptedSigBytes));
    const corruptedValid = await verifySignature(message, corruptedSigBase64, publicJwk);
    expect(corruptedValid).toBe(false);

    // 4. Malformed base64 fails safely without uncaught exceptions
    const malformedValid = await verifySignature(message, 'not-valid-base64!', publicJwk);
    expect(malformedValid).toBe(false);
  });

  it('runs complete update check with end-to-end cryptographic and hash verification', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    const listText = '||ads.example.com^\n||tracker.test^$third-party\n';
    const listHash = await sha256Hex(new TextEncoder().encode(listText));
    const version = '2.1.0';
    const pkgId = 'easylist-lite';

    const msg = signatureMessage(pkgId, version, listHash);
    const rawSig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      new TextEncoder().encode(msg)
    );
    const sigBase64 = btoa(String.fromCharCode(...new Uint8Array(rawSig)));

    const metadata = {
      version,
      createdAt: '2026-11-01T00:00:00Z',
      packages: [
        {
          id: pkgId,
          url: 'https://updates.auvyq.org/rules/easylist-lite.txt',
          sha256: listHash,
          signature: sigBase64
        }
      ]
    };

    const mockFetch = async (url: string) => {
      if (url === 'https://updates.auvyq.org/manifest.json') {
        return new Response(JSON.stringify(metadata), { status: 200 });
      }
      if (url === 'https://updates.auvyq.org/rules/easylist-lite.txt') {
        return new Response(listText, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    let activatedPkg = '';
    const mockStage = {
      compileAndActivate: async (packText: string, id: string) => {
        activatedPkg = id;
        expect(packText).toBe(listText);
        return { activated: true };
      }
    };

    // 1. Successful update check
    const outcome = await runUpdateCheck({
      endpoint: 'https://updates.auvyq.org/manifest.json',
      currentVersion: '2.0.0',
      fetchImpl: mockFetch as unknown as typeof fetch,
      stage: mockStage,
      verifyKeyJwk: publicJwk
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.stage).toBe('activate');
    expect(activatedPkg).toBe(pkgId);

    // 2. Already up to date (version monotonicity)
    const upToDateOutcome = await runUpdateCheck({
      endpoint: 'https://updates.auvyq.org/manifest.json',
      currentVersion: '2.1.0',
      fetchImpl: mockFetch as unknown as typeof fetch,
      stage: mockStage,
      verifyKeyJwk: publicJwk
    });

    expect(upToDateOutcome.ok).toBe(true);
    expect(upToDateOutcome.stage).toBe('version');

    // 3. Signature verification failure rejection
    const badSigMetadata = {
      ...metadata,
      packages: [
        {
          ...metadata.packages[0],
          signature: btoa('invalid-signature-bytes-padding-to-length-ok-----------------------------')
        }
      ]
    };

    const badSigFetch = async (url: string) => {
      if (url === 'https://updates.auvyq.org/manifest.json') {
        return new Response(JSON.stringify(badSigMetadata), { status: 200 });
      }
      return new Response(listText, { status: 200 });
    };

    const badSigOutcome = await runUpdateCheck({
      endpoint: 'https://updates.auvyq.org/manifest.json',
      currentVersion: '2.0.0',
      fetchImpl: badSigFetch as unknown as typeof fetch,
      stage: mockStage,
      verifyKeyJwk: publicJwk
    });

    expect(badSigOutcome.ok).toBe(false);
    expect(badSigOutcome.stage).toBe('signature');
    expect(badSigOutcome.error).toContain('signature rejected');

    // 4. SHA-256 hash mismatch rejection
    const tamperedPayloadFetch = async (url: string) => {
      if (url === 'https://updates.auvyq.org/manifest.json') {
        return new Response(JSON.stringify(metadata), { status: 200 });
      }
      if (url === 'https://updates.auvyq.org/rules/easylist-lite.txt') {
        return new Response('||tampered-content.com^\n', { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const hashMismatchOutcome = await runUpdateCheck({
      endpoint: 'https://updates.auvyq.org/manifest.json',
      currentVersion: '2.0.0',
      fetchImpl: tamperedPayloadFetch as unknown as typeof fetch,
      stage: mockStage,
      verifyKeyJwk: publicJwk
    });

    expect(hashMismatchOutcome.ok).toBe(false);
    expect(hashMismatchOutcome.stage).toBe('hash');
    expect(hashMismatchOutcome.error).toContain('hash mismatch');
  });

  it('initializes default update state with configured endpoint', () => {
    const state = defaultUpdateState('https://updates.auvyq.org/v1/update.json');
    expect(state.endpoint).toBe('https://updates.auvyq.org/v1/update.json');
    expect(state.status).toBe('up-to-date');
    expect(state.lastAppliedVersion).toBe('0.0.0');
    expect(state.lastCheck).toBe(0);
  });
});
