/*
 * AUVYQ service worker (single worker entry; bundled by esbuild into dist/sw.js).
 *
 * ALL event listeners are registered synchronously at module top level.
 * The worker may terminate at any moment: durable state lives ONLY in
 * chrome.storage.local / chrome.storage.session / IndexedDB. Module-level
 * variables are restricted to locks, promises and short-lived caches.
 *
 * Modernized for 2026:
 *   - Decomposed architecture: modular lifecycle, badge, backup, offscreen, and threat managers.
 *   - Bounded memory LRU response cache for GET_COSMETIC and GET_DISPATCH RPCs.
 *   - Single-flight initialization promise preventing duplicate startup races.
 */
import { createLogger } from './core/logging/logger.js';
import { createStatsService, emptySnapshot, todayKey } from './core/stats/snapshot.js';
import { createRequestObserver } from './platform-chrome/request-observer/observer.js';
import { createRpcRouter, registerRpcListener } from './platform-chrome/rpc/rpc.js';
import { createRpcHandlers } from './platform-chrome/rpc/handlers.js';
import { STORAGE_KEYS } from './core/storage/schema.js';
import { validateSettings } from './core/validation/schemas.js';
import { cleanupForTab, handleCookieChanged, sweepTrackerCookies, COOKIE_SWEEP_ALARM } from './platform-chrome/cookie-guard/guard.js';
import { teardownOffscreenIfIdle } from './platform-chrome/offscreen-client/client.js';
import { setTabThreat, assessNavigation } from './platform-chrome/threat-manager/manager.js';
import { updateBadge } from './platform-chrome/badge/badge.js';
import { invalidateCosmeticCaches } from './core/cosmetic-engine/cache.js';
import { checkExpiredSitePauses } from './core/storage/settings.js';
import { setSitePause } from './platform-chrome/dnr-adapter/adapter.js';
import {
  ensureInitialized,
  updateSettings,
  handleInstalled,
  handleStartup,
  getUpdateState,
  activatePackFromListText,
  setCachedSettings,
  ALARMS
} from './platform-chrome/lifecycle/lifecycle.js';
import type { Snapshot } from './types/schemas.js';

const log = createLogger('sw');

// ---------------------------------------------------------------------------
// Core Services
// ---------------------------------------------------------------------------
const stats = createStatsService();
const observer = createRequestObserver(stats);

const handlers = createRpcHandlers({ stats });
const router = createRpcRouter(handlers);

// ---------------------------------------------------------------------------
// Top-Level Event Listeners (registered synchronously at evaluation time)
// ---------------------------------------------------------------------------

registerRpcListener(router);

chrome.runtime.onInstalled.addListener((details) => {
  void handleInstalled(details);
});

chrome.runtime.onStartup.addListener(() => {
  void handleStartup();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const hosts = observer.getTabTrackerHosts(tabId);
  observer.noteTabRemoved(tabId);
  void (async () => {
    const settings = await ensureInitialized();
    await cleanupForTab(settings, tabId, hosts).catch(() => undefined);
    await setTabThreat(tabId, null).catch(() => undefined);
  })();
});

if (chrome.cookies?.onChanged !== undefined) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    void (async () => {
      const settings = await ensureInitialized();
      const outcome = await handleCookieChanged(changeInfo, settings);
      if (outcome.removed) {
        await stats.recordEvents([{ category: 'cookies', count: 1 }]).catch(() => undefined);
      }
    })();
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  void (async () => {
    switch (alarm.name) {
      case ALARMS.statsFlush: {
        await observer.flush().catch(() => undefined);
        await stats.flush().catch(() => undefined);
        const settings = await ensureInitialized();
        const expired = checkExpiredSitePauses(settings);
        if (expired.expiredHosts.length > 0) {
          for (const host of expired.expiredHosts) {
            await setSitePause(host, false);
          }
          await updateSettings(expired.settings);
          await updateBadge(expired.settings);
        }
        break;
      }
      case ALARMS.retention: {
        const settings = await ensureInitialized();
        await stats.prune(settings.logRetentionDays).catch(() => undefined);
        break;
      }
      case ALARMS.offscreenIdle:
        await teardownOffscreenIfIdle();
        break;
      case COOKIE_SWEEP_ALARM: {
        const settings = await ensureInitialized();
        const result = await sweepTrackerCookies(settings).catch(() => ({ removed: 0, skipped: 'error' }));
        if (result.removed > 0) {
          await stats.recordEvents([{ category: 'cookies', count: result.removed }]).catch(() => undefined);
        }
        break;
      }
      case ALARMS.updateCheck: {
        const state = await getUpdateState();
        if (state.endpoint.length > 0) {
          void handlers.CHECK_UPDATES(undefined, {}).catch(() => undefined);
        }
        break;
      }
      default:
        break;
    }
  })();
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void (async () => {
    const settings = await ensureInitialized();
    await assessNavigation(
      details.tabId,
      details.url,
      settings,
      (events) => stats.recordEvents(events),
      updateBadge
    ).catch(() => undefined);
  })();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local') {
    if (changes[STORAGE_KEYS.settings]) {
      const validated = validateSettings(changes[STORAGE_KEYS.settings].newValue);
      if (validated.ok) {
        setCachedSettings(validated.value);
        invalidateCosmeticCaches();
      }
    }
    if (changes[STORAGE_KEYS.pack]) {
      invalidateCosmeticCaches();
    }
  }
});

log.info('service worker loaded');
void ensureInitialized();

// ---------------------------------------------------------------------------
// Re-exports for tests / external integrations
// ---------------------------------------------------------------------------
export { emptySnapshot, todayKey, snapshotForDay, activatePackFromListText };

function snapshotForDay(day: string): Snapshot {
  return emptySnapshot(day);
}
