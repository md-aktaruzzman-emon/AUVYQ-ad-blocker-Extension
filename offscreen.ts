/*
 * AUVYQ offscreen document — exactly one may exist at a time.
 * Responsibilities: KDF/crypto operations (BLOBS) and defensive DOM parsing (DOM_PARSER).
 * Requests are validated, idempotent (requestId), and time-boxed by the service worker.
 * This document is torn down by the service worker after ~60s idle.
 */
import { encryptBackup, decryptBackup, sha256Hex, VaultError, MAX_BACKUP_BYTES } from './core/crypto/vault.js';
import { isRecord } from './core/validation/schemas.js';
import { createLogger } from './core/logging/logger.js';

const log = createLogger('offscreen');

type OpResult = { ok: true; data: unknown } | { ok: false; error: string };

interface OffscreenRequest {
  requestId: string;
  op: string;
  payload?: unknown;
}

function validateRequest(raw: unknown): OffscreenRequest | string {
  if (!isRecord(raw)) return 'not an object';
  if (typeof raw['requestId'] !== 'string' || raw['requestId'].length === 0 || raw['requestId'].length > 64) {
    return 'bad requestId';
  }
  if (typeof raw['op'] !== 'string' || raw['op'].length === 0 || raw['op'].length > 32) return 'bad op';
  return { requestId: raw['requestId'], op: raw['op'], payload: raw['payload'] };
}

/** Defensive parse: rejects payloads that smuggle markup/script-looking content. */
function parseCleanJson(text: string): unknown {
  if (/<\s*script|<\s*img|javascript:/i.test(text.slice(0, 4096))) {
    throw new VaultError('format', 'payload contains markup-like content');
  }
  // DOM_PARSER reason: the offscreen document owns all DOM-based defensive parsing.
  const parsed = new DOMParser().parseFromString(text.slice(0, 64), 'text/html');
  if (parsed.body !== null && parsed.body.textContent !== null && parsed.body.textContent.trim().length > 0) {
    // Leading markup was detected in what must be pure JSON.
    if (!/^[[{\s]/.test(text)) throw new VaultError('format', 'payload is not JSON');
  }
  return JSON.parse(text);
}

async function handleOp(op: string, payload: unknown): Promise<OpResult> {
  switch (op) {
    case 'encrypt-backup': {
      if (!isRecord(payload)) return { ok: false, error: 'payload not object' };
      const plaintextJson = payload['plaintextJson'];
      const password = payload['password'];
      if (typeof plaintextJson !== 'string' || typeof password !== 'string') {
        return { ok: false, error: 'bad encrypt inputs' };
      }
      parseCleanJson(plaintextJson);
      const meta = {
        app: 'AUVYQ' as const,
        kind: 'settings-backup' as const,
        createdAt: Date.now(),
        itemCount: isRecord(JSON.parse(plaintextJson)) ? Object.keys(JSON.parse(plaintextJson)).length : 0
      };
      const bytes = await encryptBackup(plaintextJson, password, meta);
      return { ok: true, data: { bytes: Array.from(bytes) } };
    }
    case 'decrypt-backup': {
      if (!isRecord(payload)) return { ok: false, error: 'payload not object' };
      const rawBytes = payload['bytes'];
      const password = payload['password'];
      if (!Array.isArray(rawBytes) || typeof password !== 'string') {
        return { ok: false, error: 'bad decrypt inputs' };
      }
      if (rawBytes.length > MAX_BACKUP_BYTES) return { ok: false, error: 'backup too large' };
      if (!rawBytes.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255)) {
        return { ok: false, error: 'bad byte array' };
      }
      const blob = new Uint8Array(rawBytes);
      const decrypted = await decryptBackup(blob, password);
      const value = parseCleanJson(decrypted.plaintextJson);
      return { ok: true, data: { value, meta: decrypted.meta } };
    }
    case 'sha256': {
      if (!isRecord(payload)) return { ok: false, error: 'payload not object' };
      const rawBytes = payload['bytes'];
      if (!Array.isArray(rawBytes) || rawBytes.length > 32 * 1024 * 1024) {
        return { ok: false, error: 'bad bytes' };
      }
      const digest = await sha256Hex(new Uint8Array(rawBytes as number[]));
      return { ok: true, data: { hex: digest } };
    }
    default:
      return { ok: false, error: 'unknown op' };
  }
}

chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
  const request = validateRequest(raw);
  if (typeof request === 'string') {
    sendResponse({ requestId: '', success: false, error: request });
    return false;
  }
  void handleOp(request.op, request.payload)
    .then((result) => {
      sendResponse({
        requestId: request.requestId,
        success: result.ok,
        ...(result.ok ? { data: result.data } : { error: result.error })
      });
    })
    .catch((error) => {
      const message = error instanceof VaultError
        ? `vault:${error.kind}: ${error.message}`
        : error instanceof Error ? error.message : 'offscreen op failed';
      log.warn('op failed', message);
      sendResponse({ requestId: request.requestId, success: false, error: message });
    });
  return true;
});

log.info('offscreen ready');
