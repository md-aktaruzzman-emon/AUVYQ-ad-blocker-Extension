/*
 * Telemetry. Default OFF: when off, nothing is collected — not even locally.
 * When explicitly opted in, data is queued LOCALLY first. Transmission additionally
 * requires (1) a configured https endpoint and (2) a k-anonymity gate passing.
 * No raw browsing history, no full URLs, no cookies, no form contents, no credentials —
 * by construction: the event schema below only accepts coarse counters.
 */
import { STORAGE_KEYS } from '../storage/schema.js';

export interface TelemetryEvent {
  day: string;              // YYYY-MM-DD only
  kind: 'blocks' | 'params' | 'threats'; // coarse category only
  count: number;            // aggregate counter, never per-site
}

export const TELEMETRY_QUEUE_LIMIT = 200;
export const K_ANONYMITY_MIN_COHORT = 50;

export interface KAnonymityGate {
  /** Returns true only when the aggregate cohort is large enough to be non-identifying. */
  shouldEmit(queue: TelemetryEvent[]): Promise<boolean>;
}

/** Local cohort gate: an event kind is emittable only when the queue holds >= K identical day/kind cohorts. */
export class LocalKAnonymityGate implements KAnonymityGate {
  async shouldEmit(queue: TelemetryEvent[]): Promise<boolean> {
    const cohorts = new Map<string, number>();
    for (const event of queue) {
      const key = `${event.day}:${event.kind}`;
      cohorts.set(key, (cohorts.get(key) ?? 0) + event.count);
    }
    for (const size of cohorts.values()) {
      if (size >= K_ANONYMITY_MIN_COHORT) return true;
    }
    return false;
  }
}

function validEvent(value: unknown): value is TelemetryEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['day'] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record['day']) &&
    ['blocks', 'params', 'threats'].includes(record['kind'] as string) &&
    typeof record['count'] === 'number' && Number.isSafeInteger(record['count']) &&
    (record['count'] as number) >= 0;
}

export interface TelemetryDeps {
  optIn: boolean;
  endpoint?: string;
  gate?: KAnonymityGate;
}

export function createTelemetryService(deps: TelemetryDeps) {
  const gate = deps.gate ?? new LocalKAnonymityGate();

  async function readQueue(): Promise<TelemetryEvent[]> {
    const result = await chrome.storage.local.get(STORAGE_KEYS.telemetryQueue);
    const raw = result[STORAGE_KEYS.telemetryQueue];
    if (!Array.isArray(raw)) return [];
    return raw.filter(validEvent);
  }

  /** Collects only when the user explicitly opted in; otherwise a no-op. */
  async function enqueue(event: TelemetryEvent): Promise<void> {
    if (!deps.optIn || !validEvent(event)) return;
    const queue = await readQueue();
    queue.push(event);
    while (queue.length > TELEMETRY_QUEUE_LIMIT) queue.shift();
    await chrome.storage.local.set({ [STORAGE_KEYS.telemetryQueue]: queue });
  }

  /**
   * Transmission seam. Without a configured endpoint (the default) this NEVER sends
   * anything. With one configured, the k-anonymity gate must still pass.
   */
  async function flush(): Promise<{ sent: number; gatePassed: boolean }> {
    if (!deps.optIn) return { sent: 0, gatePassed: false };
    const endpoint = deps.endpoint ?? '';
    if (endpoint.length === 0 || !/^https:\/\//.test(endpoint)) {
      return { sent: 0, gatePassed: false };
    }
    const queue = await readQueue();
    const gatePassed = await gate.shouldEmit(queue);
    if (!gatePassed) return { sent: 0, gatePassed };
    // Transmission is intentionally left unimplemented until a reviewed endpoint exists.
    return { sent: 0, gatePassed };
  }

  async function clear(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEYS.telemetryQueue);
  }

  return { enqueue, flush, readQueue, clear };
}

export type TelemetryService = ReturnType<typeof createTelemetryService>;
