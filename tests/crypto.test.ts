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

  it('fails decryption with wrong password', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    await expect(decryptBackup(encrypted, 'WrongPassword123!')).rejects.toThrow(VaultError);
  });

  it('fails decryption if ciphertext is tampered', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const tampered = new Uint8Array(encrypted);
    // Flip a byte in ciphertext region (end of array)
    tampered[tampered.length - 1] ^= 0xff;

    await expect(decryptBackup(tampered, password)).rejects.toThrow(VaultError);
  });

  it('fails decryption if backup is truncated', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const truncated = encrypted.slice(0, encrypted.length - 16);
    await expect(decryptBackup(truncated, password)).rejects.toThrow(VaultError);
  });

  it('fails decryption if magic bytes are invalid', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const badMagic = new Uint8Array(encrypted);
    badMagic[0] = 0x00;
    await expect(decryptBackup(badMagic, password)).rejects.toThrow(VaultError);
  });

  it('fails decryption if version is unsupported', async () => {
    const encrypted = await encryptBackup(payload, password, meta);
    const badVersion = new Uint8Array(encrypted);
    badVersion[MAGIC.length] = 99; // Version 99
    await expect(decryptBackup(badVersion, password)).rejects.toThrow(VaultError);
  });

  it('computes SHA-256 hex digest correctly', async () => {
    const data = new TextEncoder().encode('AUVYQ-TEST');
    const hash = await sha256Hex(data);
    expect(hash).toHaveLength(64);
    expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
  });
});
