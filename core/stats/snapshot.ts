/*
 * Daily statistics snapshots with batched writes (max 1 write / 5 seconds) and
 * 7- or 30-day retention. Popup/dashboard read snapshots only.
 *
 * Documented privacy-score formula (a rough indicator, NOT a measurement):
 *   score = round(min(99, 55 + 10 * log2(1 + totalBlockedToday)))
 * More protection activity raises the score toward a capped 99; it is never "precision".
 */
import type { Snapshot } from '../../types/schemas.js';
import { STORAGE_KEYS } from '../storage/schema.js';
import { validateSnapshot, isRecord } from '../validation/schemas.js';
import { normalizeHostname } from '../domain/normalize.js';

export type StatCategory = 'ads' | 'trackers' | 'params' | 'cosmetic' | 'threats' | 'cookies';

export interface StatEvent {
  category: StatCategory;
  count: number;
}

export const MIN_WRITE_INTERVAL_MS = 5000;

export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function emptySnapshot(day: string): Snapshot {
  return {
    day,
    adsBlocked: 0,
    trackersBlocked: 0,
    paramsStripped: 0,
    cosmeticHidden: 0,
    threats: 0,
    cookiesCleaned: 0,
    updatedAt: Date.now()
  };
}

/** Pure: merges events into a snapshot without mutating the input. */
export function mergeEvents(snapshot: Snapshot, events: StatEvent[]): Snapshot {
  const next: Snapshot = { ...snapshot, updatedAt: Date.now() };
  for (const event of events) {
    const count = Number.isSafeInteger(event.count) && event.count > 0 ? event.count : 1;
    switch (event.category) {
      case 'ads': next.adsBlocked += count; break;
      case 'trackers': next.trackersBlocked += count; break;
      case 'params': next.paramsStripped += count; break;
      case 'cosmetic': next.cosmeticHidden += count; break;
      case 'threats': next.threats += count; break;
      case 'cookies': next.cookiesCleaned += count; break;
    }
  }
  return next;
}

export function computePrivacyScore(snapshot: Snapshot): number {
  const total = snapshot.adsBlocked + snapshot.trackersBlocked + snapshot.paramsStripped +
    snapshot.cosmeticHidden + snapshot.threats + snapshot.cookiesCleaned;
  if (total === 0) return 55;
  return Math.round(Math.min(99, 55 + 10 * Math.log2(1 + total)));
}

/** Pure: keeps only the newest `retentionDays` entries (by day key order). */
export function pruneHistory(history: Record<string, Snapshot>, retentionDays: 7 | 30, today = todayKey()): Record<string, Snapshot> {
  const days = Object.keys(history).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const cutoffCount = Math.max(1, retentionDays);
  const keep = new Set(days.slice(-cutoffCount));
  keep.add(today);
  const out: Record<string, Snapshot> = {};
  for (const day of Object.keys(history)) {
    if (keep.has(day) && day <= today) out[day] = history[day];
  }
  return out;
}

export interface StatsStore {
  readHistory(): Promise<Record<string, Snapshot>>;
  writeHistory(history: Record<string, Snapshot>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Per-site statistics (bounded, host-only; powers the site report page)
// ---------------------------------------------------------------------------

export interface SiteCounters {
  ads: number;
  trackers: number;
  params: number;
  cosmetic: number;
  threats: number;
}

export type SiteHistory = Record<string, Record<string, SiteCounters>>;

export interface SiteEvent {
  host: string;
  category: StatCategory;
  count: number;
}

export const MAX_HOSTS_PER_DAY = 200;

function emptyCounters(): SiteCounters {
  return { ads: 0, trackers: 0, params: 0, cosmetic: 0, threats: 0 };
}

/** Pure: merges per-host events into the site history (bounded hosts per day). */
export function mergeSiteEvents(history: SiteHistory, day: string, events: SiteEvent[]): SiteHistory {
  const dayMap = { ...(history[day] ?? {}) };
  for (const event of events) {
    const host = normalizeHostname(event.host);
    if (host.length === 0) continue;
    const current = dayMap[host] ?? emptyCounters();
    if (Object.keys(dayMap).length >= MAX_HOSTS_PER_DAY && dayMap[host] === undefined) continue;
    const next = { ...current };
    switch (event.category) {
      case 'ads': next.ads += event.count; break;
      case 'trackers': next.trackers += event.count; break;
      case 'params': next.params += event.count; break;
      case 'cosmetic': next.cosmetic += event.count; break;
      case 'threats': next.threats += event.count; break;
      default: break;
    }
    dayMap[host] = next;
  }
  return { ...history, [day]: dayMap };
}

/** Pure: prunes site history to the retention window. */
export function pruneSiteHistory(history: SiteHistory, retentionDays: 7 | 30, today = todayKey()): SiteHistory {
  const out: SiteHistory = {};
  for (const [day, dayMap] of Object.entries(history)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today && day >= minDay(today, retentionDays)) {
      out[day] = dayMap;
    }
  }
  return out;
}

function minDay(today: string, retentionDays: number): string {
  const date = new Date(`${today}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - (retentionDays - 1));
  return date.toISOString().slice(0, 10);
}

function chromeLocalStore(): StatsStore {
  return {
    readHistory: async () => {
      const result = await chrome.storage.local.get(STORAGE_KEYS.snapshots);
      const raw = result[STORAGE_KEYS.snapshots];
      if (typeof raw !== 'object' || raw === null) return {};
      const out: Record<string, Snapshot> = {};
      for (const [day, value] of Object.entries(raw as Record<string, unknown>)) {
        const validated = validateSnapshot(value);
        if (validated.ok) out[day] = validated.value;
      }
      return out;
    },
    writeHistory: async (history) => {
      await chrome.storage.local.set({ [STORAGE_KEYS.snapshots]: history });
    }
  };
}

export function createStatsService(store: StatsStore = chromeLocalStore()) {
  let pendingEvents: StatEvent[] = [];
  let lastWriteAt = 0;
  let writeScheduled = false;

  async function flushNow(): Promise<void> {
    const events = pendingEvents;
    pendingEvents = [];
    if (events.length === 0) return;
    const history = await store.readHistory();
    const day = todayKey();
    const current = history[day] ?? emptySnapshot(day);
    history[day] = mergeEvents(current, events);
    await store.writeHistory(history);
    lastWriteAt = Date.now();
  }

  async function recordEvents(events: StatEvent[]): Promise<void> {
    if (events.length === 0) return;
    pendingEvents = pendingEvents.concat(events);
    const sinceWrite = Date.now() - lastWriteAt;
    if (sinceWrite >= MIN_WRITE_INTERVAL_MS && !writeScheduled) {
      writeScheduled = true;
      try {
        await flushNow();
      } finally {
        writeScheduled = false;
      }
      return;
    }
    // Throttled: the periodic alarm (auvyq-stats-flush) will flush the buffer.
  }

  async function flush(): Promise<void> {
    if (writeScheduled) return;
    writeScheduled = true;
    try {
      await flushNow();
    } finally {
      writeScheduled = false;
    }
  }

  async function getToday(): Promise<Snapshot> {
    const history = await store.readHistory();
    return history[todayKey()] ?? emptySnapshot(todayKey());
  }

  async function getHistory(retentionDays: 7 | 30): Promise<Record<string, Snapshot>> {
    const history = await store.readHistory();
    return pruneHistory(history, retentionDays);
  }

  async function prune(retentionDays: 7 | 30): Promise<void> {
    const history = await store.readHistory();
    await store.writeHistory(pruneHistory(history, retentionDays));
    const siteRaw = await chrome.storage.local.get(STORAGE_KEYS.siteStats);
    const site = siteRaw[STORAGE_KEYS.siteStats];
    if (isRecord(site)) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.siteStats]: pruneSiteHistory(site as unknown as SiteHistory, retentionDays)
      });
    }
  }

  async function recordSiteEvents(events: SiteEvent[]): Promise<void> {
    if (events.length === 0) return;
    const result = await chrome.storage.local.get(STORAGE_KEYS.siteStats);
    const current = isRecord(result[STORAGE_KEYS.siteStats])
      ? result[STORAGE_KEYS.siteStats] as unknown as SiteHistory
      : {};
    const next = mergeSiteEvents(current, todayKey(), events);
    await chrome.storage.local.set({ [STORAGE_KEYS.siteStats]: next });
  }

  async function getSiteCounters(host: string, retentionDays: 7 | 30): Promise<SiteCounters> {
    const normalized = normalizeHostname(host);
    const result = await chrome.storage.local.get(STORAGE_KEYS.siteStats);
    const site = result[STORAGE_KEYS.siteStats];
    if (!isRecord(site) || normalized.length === 0) return emptyCounters();
    const history = pruneSiteHistory(site as unknown as SiteHistory, retentionDays);
    const totals = emptyCounters();
    for (const dayMap of Object.values(history)) {
      const counters = dayMap[normalized];
      if (counters === undefined) continue;
      totals.ads += counters.ads;
      totals.trackers += counters.trackers;
      totals.params += counters.params;
      totals.cosmetic += counters.cosmetic;
      totals.threats += counters.threats;
    }
    return totals;
  }

  return { recordEvents, flush, getToday, getHistory, prune, recordSiteEvents, getSiteCounters };
}

export type StatsService = ReturnType<typeof createStatsService>;
