import { describe, it, expect } from 'vitest';
import {
  encryptBackup,
  decryptBackup,
  sha256Hex,
  MAGIC,
  VaultError,
  type BackupMeta
} from '../core/crypto/vault.js';

describe('Crypto Vault', () => {
  const meta: BackupMeta = {
    app: 'AUVYQ',
    kind: 'settings-backup',
    createdAt: Date.now(),
    itemCount: 1
  };
  const password = 'CorrectHorseBatteryStaple99!';
  const payload = JSON.stringify({ preset: 'balanced', masterEnabled: true });

  it('encrypts and decrypts payload successfully (round trip)', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    expect(encrypted.byteLength).toBeGreaterThan(64);

    const decrypted = await decryptBackup(encrypted, password);
    expect(decrypted.plaintextJson).toBe(payload);
    expect(decrypted.meta.app).toBe('AUVYQ');
  });

  it('fails encryption if password is shorter than 8 characters', async () => {
    try {
      await encryptBackup(payload, 'short', meta);
      expect.unreachable('should have thrown VaultError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).kind).toBe('format');
    }
  });

  it('fails decryption with wrong password with auth kind', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    try {
      await decryptBackup(encrypted, 'WrongPassword123!');
      expect.unreachable('should have thrown VaultError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).kind).toBe('auth');
    }
  });

  it('fails decryption if ciphertext is tampered', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const tampered = new Uint8Array(encrypted);
    // Flip a byte in ciphertext region (end of array)
    tampered[tampered.length - 1] ^= 0xff;

    try {
      await decryptBackup(tampered, password);
      expect.unreachable('should have thrown VaultError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).kind).toBe('auth');
    }
  });

  it('fails decryption if backup is truncated', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const truncated = encrypted.slice(0, encrypted.length - 16);
    try {
      await decryptBackup(truncated, password);
      expect.unreachable('should have thrown VaultError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).kind).toBe('format');
    }
  });

  it('fails decryption if magic bytes are invalid', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const badMagic = new Uint8Array(encrypted);
    badMagic[0] = 0x00;
    try {
      await decryptBackup(badMagic, password);
      expect.unreachable('should have thrown VaultError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).kind).toBe('format');
    }
  });

  it('fails decryption if version is unsupported', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const badVersion = new Uint8Array(encrypted);
    badVersion[MAGIC.length] = 99; // Version 99
    try {
      await decryptBackup(badVersion, password);
      expect.unreachable('should have thrown VaultError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).kind).toBe('version');
    }
  });

  it('fails decryption if extra trailing data is appended to the backup', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const withExtra = new Uint8Array(encrypted.length + 8);
    withExtra.set(encrypted, 0);
    withExtra.set([1, 2, 3, 4, 5, 6, 7, 8], encrypted.length);
    try {
      await decryptBackup(withExtra, password);
      expect.unreachable('should have thrown VaultError');
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).kind).toBe('format');
    }
  });

  it('computes SHA-256 hex digest correctly and deterministically', async () => {
    const data = new TextEncoder().encode('AUVYQ-TEST');
    const hash = await sha256Hex(data);
    expect(hash).toHaveLength(64);
    expect(hash).toBe('d93a835669192030a80c11e7d72ef8e159f286e368c8429ea18b3c433b1d919e');
  });
});
