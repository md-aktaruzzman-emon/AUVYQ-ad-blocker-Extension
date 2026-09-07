/*
 * RPC layer. Malformed messages are rejected safely with a structured error.
 * Every response carries the original requestId.
 */
import { validateRpcEnvelope, LIMITS } from '../../core/validation/schemas.js';
import type { RpcHandler } from '../../types/messages.js';
import { createLogger } from '../../core/logging/logger.js';

const log = createLogger('rpc');
const HANDLER_TIMEOUT_MS = 10000;

export interface RpcRouter {
  handle(raw: unknown, sender: chrome.runtime.MessageSender): Promise<{ requestId: string; success: boolean; data?: unknown; error?: string }>;
}

export function createRpcRouter(handlers: Record<string, RpcHandler>): RpcRouter {
  async function handle(raw: unknown, sender: chrome.runtime.MessageSender) {
    const envelope = validateRpcEnvelope(raw);
    if (!envelope.ok) {
      return { requestId: '', success: false, error: envelope.error };
    }
    const { requestId, type } = envelope.value;
    const handler = handlers[type];
    if (handler === undefined) {
      return { requestId, success: false, error: `unknown message type: ${type}` };
    }
    // Payload size guard (defense against resource exhaustion from compromised contexts).
    if (envelope.value.payload !== undefined) {
      try {
        const size = JSON.stringify(envelope.value.payload).length;
        if (size > LIMITS.rpcPayloadChars) {
          return { requestId, success: false, error: 'payload too large' };
        }
      } catch {
        return { requestId, success: false, error: 'payload not serializable' };
      }
    }

    try {
      const result = await Promise.race([
        Promise.resolve(handler(envelope.value.payload, sender)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('handler timeout')), HANDLER_TIMEOUT_MS))
      ]);
      return { requestId, success: true, data: result };
    } catch (error) {
      log.warn(`handler ${type} failed`, error instanceof Error ? error.message : String(error));
      return { requestId, success: false, error: error instanceof Error ? error.message : 'handler error' };
    }
  }

  return { handle };
}

/** Bridges the router onto chrome.runtime.onMessage (async sendResponse pattern). */
export function registerRpcListener(router: RpcRouter): void {
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    void router.handle(raw, sender).then((response) => {
      try {
        sendResponse(response);
      } catch {
        // Channel closed (popup closed, tab navigated) — nothing to do.
      }
    });
    return true; // keep the message channel open for the async response
  });
}

export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Client helper for UI/content contexts. */
export async function sendRpc(type: string, payload?: unknown): Promise<unknown> {
  const message = {
    v: 1,
    type,
    requestId: (globalThis.crypto?.randomUUID?.() ?? `req-${Date.now()}-${Math.random()}`).slice(0, 64),
    payload
  };
  const response = await chrome.runtime.sendMessage(message) as { success?: boolean; data?: unknown; error?: string } | undefined;
  if (response === undefined) throw new RpcError('no response from background');
  if (response.success !== true) throw new RpcError(response.error ?? 'rpc failed');
  return response.data;
}
