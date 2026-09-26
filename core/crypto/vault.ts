/*
 * Crypto vault: PBKDF2-SHA256 (600,000 iterations) -> AES-GCM-256.
 * KDF operations run inside the offscreen document (see offscreen.ts).
 * Binary backup layout (all integers little-endian):
 *   magic(6) | version(1) | saltLen(2) salt | ivLen(2) iv | metaLen(4) metaJson | ctLen(8) ciphertext
 * The plaintext password is never stored anywhere.
 */

export const KDF_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const BACKUP_VERSION = 1;
export const MAGIC = new Uint8Array([0x41, 0x55, 0x56, 0x59, 0x51, 0x42]); // "AUVYQB"

export const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

export class VaultError extends Error {
  readonly kind: 'format' | 'auth' | 'size' | 'version';
  constructor(kind: VaultError['kind'], message: string) {
    super(message);
    this.name = 'VaultError';
    this.kind = kind;
  }
}

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export interface BackupMeta {
  app: 'AUVYQ';
  kind: 'settings-backup';
  createdAt: number;
  itemCount: number;
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function writeUint64(bytes: Uint8Array, offset: number, value: number): void {
  const big = BigInt(Math.floor(value));
  for (let i = 0; i < 8; i++) {
    bytes[offset + i] = Number((big >> BigInt(i * 8)) & 0xffn);
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16) + (bytes[offset + 3] << 24);
}

function readUint64(bytes: Uint8Array, offset: number): number {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value |= BigInt(bytes[offset + i]) << BigInt(i * 8);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new VaultError('size', 'backup too large');
  return Number(value);
}

export async function encryptBackup(plaintextJson: string, password: string, meta: BackupMeta): Promise<Uint8Array> {
  if (password.length < 8) throw new VaultError('format', 'password must be at least 8 characters');
  if (plaintextJson.length > MAX_BACKUP_BYTES) throw new VaultError('size', 'backup payload too large');

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const encoder = new TextEncoder();

  const metaJson = JSON.stringify(meta);
  const metaBytes = encoder.encode(metaJson);
  const plaintext = encoder.encode(plaintextJson);

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, plaintext as unknown as BufferSource)
  );

  const total =
    MAGIC.length + 1 + 2 + SALT_BYTES + 2 + IV_BYTES + 4 + metaBytes.length + 8 + ciphertext.length;
  if (total > MAX_BACKUP_BYTES) throw new VaultError('size', 'backup too large');

  const out = new Uint8Array(total);
  let offset = 0;
  out.set(MAGIC, offset);
  offset += MAGIC.length;
  out[offset] = BACKUP_VERSION;
  offset += 1;
  writeUint16(out, offset, SALT_BYTES);
  offset += 2;
  out.set(salt, offset);
  offset += SALT_BYTES;
  writeUint16(out, offset, IV_BYTES);
  offset += 2;
  out.set(iv, offset);
  offset += IV_BYTES;
  writeUint32(out, offset, metaBytes.length);
  offset += 4;
  out.set(metaBytes, offset);
  offset += metaBytes.length;
  writeUint64(out, offset, ciphertext.length);
  offset += 8;
  out.set(ciphertext, offset);
  return out;
}

export interface DecryptedBackup {
  plaintextJson: string;
  meta: BackupMeta;
}

export async function decryptBackup(blob: Uint8Array, password: string): Promise<DecryptedBackup> {
  if (blob.byteLength > MAX_BACKUP_BYTES) throw new VaultError('size', 'backup too large');
  if (blob.byteLength < MAGIC.length + 1 + 2 + SALT_BYTES + 2 + IV_BYTES + 4 + 8) {
    throw new VaultError('format', 'backup truncated');
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) throw new VaultError('format', 'not an AUVYQ backup');
  }
  const version = blob[MAGIC.length];
  if (version !== BACKUP_VERSION) throw new VaultError('version', `unsupported backup version ${String(version)}`);

  let offset = MAGIC.length + 1;
  const saltLen = readUint16(blob, offset);
  offset += 2;
  if (saltLen !== SALT_BYTES) throw new VaultError('format', 'bad salt length');
  const salt = blob.slice(offset, offset + saltLen);
  offset += saltLen;
  const ivLen = readUint16(blob, offset);
  offset += 2;
  if (ivLen !== IV_BYTES) throw new VaultError('format', 'bad iv length');
  const iv = blob.slice(offset, offset + ivLen);
  offset += ivLen;
  const metaLen = readUint32(blob, offset);
  offset += 4;
  if (metaLen > 4096) throw new VaultError('format', 'metadata too large');
  if (offset + metaLen + 8 > blob.byteLength) throw new VaultError('format', 'backup truncated');
  const metaBytes = blob.slice(offset, offset + metaLen);
  offset += metaLen;
  const ctLen = readUint64(blob, offset);
  offset += 8;
  if (ctLen > blob.byteLength - offset) throw new VaultError('format', 'ciphertext length exceeds file');
  const ciphertext = blob.slice(offset, offset + ctLen);

  let meta: unknown;
  try {
    meta = JSON.parse(new TextDecoder().decode(metaBytes));
  } catch {
    throw new VaultError('format', 'metadata corrupt');
  }
  const metaRecord = meta as Partial<BackupMeta> | null;
  if (metaRecord === null || typeof metaRecord !== 'object' || metaRecord.app !== 'AUVYQ' || metaRecord.kind !== 'settings-backup') {
    throw new VaultError('format', 'unexpected metadata');
  }

  const key = await deriveKey(password, salt);
  let plaintextBuffer: ArrayBuffer;
  try {
    plaintextBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
  } catch {
    throw new VaultError('auth', 'wrong password or tampered backup');
  }
  return {
    plaintextJson: new TextDecoder().decode(plaintextBuffer),
    meta: meta as BackupMeta
  };
}

/** SHA-256 hex digest, used by the update channel. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
