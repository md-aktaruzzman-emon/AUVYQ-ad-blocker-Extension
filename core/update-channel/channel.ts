/*
 * Signed update channel.
 * fetch metadata -> validate schema -> verify ECDSA P-256 signature -> verify SHA-256 hashes
 *   -> check version monotonicity -> stage -> compile/validate -> activate atomically.
 * On ANY failure the previous valid pack is kept and the update is rejected.
 * Remote artifacts are DATA ONLY: list text is parsed/compiled, never executed.
 */
import type { UpdateMetadata, UpdateState } from '../../types/schemas.js';
import { validateUpdateMetadata } from '../validation/schemas.js';
import { sha256Hex } from '../crypto/vault.js';
import { parseFilterListWithStats } from '../rule-parser/parser.js';
import { compileRulesDetailed } from '../rule-compiler/compiler.js';

// !! SECURITY: development verification key. REPLACE BEFORE PRODUCTION !!
// Generate the production keypair offline; publish only the public key in this constant.
// Any update whose signature does not verify against this key is rejected.
export const DEV_VERIFY_KEY_JWK = {
  crv: 'P-256',
  ext: true,
  key_ops: ['verify'],
  kty: 'EC',
  x: 'K2hKGuIXDdm-9JMKrvGHXIa9yc4Py8PFGhMScfBWmbk',
  y: 'cCzTHgf3BxaSkGZ9myF6ZBIOSKkYy2pXT2N3HxQGm88'
} as const;

export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<Response>;
}

export interface UpdateStage {
  compileAndActivate(packText: string, listId: string): Promise<{ activated: boolean; error?: string }>;
}

export interface UpdateOutcome {
  ok: boolean;
  stage: 'metadata' | 'signature' | 'download' | 'hash' | 'version' | 'compile' | 'activate' | 'network';
  error?: string;
}

function versionCompare(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10));
  const pb = b.split('.').map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

async function importVerifyKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('jwk', DEV_VERIFY_KEY_JWK as unknown as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function verifySignature(messageUtf8: string, signatureBase64: string): Promise<boolean> {
  try {
    const key = await importVerifyKey();
    const signature = Uint8Array.from(atob(signatureBase64), (c) => c.charCodeAt(0));
    return crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      signature as unknown as BufferSource,
      new TextEncoder().encode(messageUtf8) as unknown as BufferSource
    );
  } catch {
    return false;
  }
}

export function signatureMessage(pkgId: string, version: string, sha256: string): string {
  return `auvyq-update:${pkgId}:${version}:${sha256}`;
}

const FETCH_TIMEOUT_MS = 20000;

async function fetchWithTimeout(fetchImpl: FetchLike, url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface UpdateDeps {
  fetchImpl?: FetchLike;
  currentVersion: string;
  endpoint: string;
  stage: UpdateStage;
}

/** Runs the full pipeline. Never throws; every failure is a structured UpdateOutcome. */
export async function runUpdateCheck(deps: UpdateDeps): Promise<UpdateOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  if (deps.endpoint.length === 0) {
    return { ok: false, stage: 'network', error: 'no update endpoint configured' };
  }
  let metadataText: string;
  try {
    const response = await fetchWithTimeout(fetchImpl, deps.endpoint);
    if (!response.ok) return { ok: false, stage: 'network', error: `metadata http ${String(response.status)}` };
    metadataText = await response.text();
  } catch (error) {
    return { ok: false, stage: 'network', error: error instanceof Error ? error.message : 'metadata fetch failed' };
  }
  if (metadataText.length > 256 * 1024) {
    return { ok: false, stage: 'metadata', error: 'metadata too large' };
  }

  let metadataJson: unknown;
  try {
    metadataJson = JSON.parse(metadataText);
  } catch {
    return { ok: false, stage: 'metadata', error: 'metadata is not valid JSON' };
  }
  const validated = validateUpdateMetadata(metadataJson);
  if (!validated.ok) return { ok: false, stage: 'metadata', error: validated.error };
  const metadata: UpdateMetadata = validated.value;

  if (versionCompare(metadata.version, deps.currentVersion) <= 0) {
    return { ok: true, stage: 'version' }; // already up to date
  }

  for (const pkg of metadata.packages) {
    const message = signatureMessage(pkg.id, metadata.version, pkg.sha256);
    const signatureOk = await verifySignature(message, pkg.signature);
    if (!signatureOk) return { ok: false, stage: 'signature', error: `signature rejected for ${pkg.id}` };

    let payloadText: string;
    try {
      const response = await fetchWithTimeout(fetchImpl, pkg.url);
      if (!response.ok) return { ok: false, stage: 'download', error: `payload http ${String(response.status)}` };
      payloadText = await response.text();
    } catch (error) {
      return { ok: false, stage: 'download', error: error instanceof Error ? error.message : 'payload fetch failed' };
    }
    if (payloadText.length > 8 * 1024 * 1024) {
      return { ok: false, stage: 'download', error: 'payload too large' };
    }
    const hash = await sha256Hex(new TextEncoder().encode(payloadText));
    if (hash !== pkg.sha256) return { ok: false, stage: 'hash', error: `hash mismatch for ${pkg.id}` };

    // Stage compile: failure here rejects the update before activation.
    const parsed = parseFilterListWithStats(payloadText, pkg.id);
    const compiled = compileRulesDetailed(parsed.rules);
    if (compiled.pack.stats.rulesCompiled === 0 && parsed.stats.dropped > 0) {
      return { ok: false, stage: 'compile', error: 'compiled pack is empty' };
    }
    const activation = await deps.stage.compileAndActivate(payloadText, pkg.id);
    if (!activation.activated) {
      return { ok: false, stage: 'activate', error: activation.error ?? 'activation failed' };
    }
  }
  return { ok: true, stage: 'activate' };
}

export function defaultUpdateState(endpoint: string): UpdateState {
  return {
    lastCheck: 0,
    lastAppliedVersion: '0.0.0',
    status: 'up-to-date',
    endpoint
  };
}
