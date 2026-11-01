/*
 * AUVYQ offscreen document gateway: manages the offscreen document lifecycle,
 * timeouts, and cryptographic message routing (PBKDF2/AES-GCM in offscreen.ts).
 */

let offscreenEnsure: Promise<void> | null = null;
let offscreenLastUse = 0;
const offscreenInFlight = new Map<string, Promise<unknown>>();
export const OFFSCREEN_IDLE_MS = 60000;

export async function ensureOffscreen(): Promise<void> {
  if (offscreenEnsure === null) {
    offscreenEnsure = (async () => {
      const has = await chrome.offscreen?.hasDocument?.().catch(() => false);
      if (!has && chrome.offscreen?.createDocument) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['BLOBS', 'DOM_PARSER'],
          justification: 'AUVYQ key derivation (PBKDF2) and defensive DOM parsing for encrypted backups.'
        });
      }
      offscreenLastUse = Date.now();
    })().catch((error) => {
      offscreenEnsure = null;
      throw error;
    });
  }
  await offscreenEnsure;
}

export async function callOffscreen<T>(op: string, payload: unknown, timeoutMs = 30000): Promise<T> {
  const opKey = `${op}:${JSON.stringify(payload).slice(0, 64)}`;
  const existing = offscreenInFlight.get(opKey);
  if (existing !== undefined) return existing as Promise<T>;

  const run = (async () => {
    await ensureOffscreen();
    offscreenLastUse = Date.now();
    const requestId = `off-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const response = await Promise.race([
      chrome.runtime.sendMessage({ target: 'offscreen', requestId, op, payload }) as Promise<{ requestId: string; success: boolean; data?: unknown; error?: string }>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('offscreen timeout')), timeoutMs))
    ]);
    if (response.success !== true) throw new Error(response.error ?? 'offscreen op failed');
    return response.data as T;
  })();

  offscreenInFlight.set(opKey, run);
  try {
    return await run;
  } finally {
    offscreenInFlight.delete(opKey);
  }
}

export async function teardownOffscreenIfIdle(): Promise<void> {
  if (offscreenInFlight.size > 0) return;
  if (Date.now() - offscreenLastUse < OFFSCREEN_IDLE_MS) return;
  const has = await chrome.offscreen?.hasDocument?.().catch(() => false);
  if (has && chrome.offscreen?.closeDocument) {
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
  offscreenEnsure = null;
}
