import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  BoundedLruCache,
  cosmeticCache,
  dispatchCache,
  createCosmeticKey,
  createDispatchKey,
  invalidateCosmeticCaches,
  type CosmeticCachedResponse,
  type DispatchCachedResponse
} from '../core/cosmetic-engine/cache.js';
import { updateSettings } from '../platform-chrome/lifecycle/lifecycle.js';
import { defaultSettings } from '../core/storage/schema.js';

describe('RPC & Cosmetic Caching Optimization Suite', () => {
  beforeEach(() => {
    cosmeticCache.clear();
    dispatchCache.clear();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined)
        }
      }
    };
  });

  describe('BoundedLruCache Primitives & Eviction', () => {
    it('stores and retrieves cached items accurately', () => {
      const cache = new BoundedLruCache<number>(16);
      cache.set('key1', 100);
      cache.set('key2', 200);

      expect(cache.get('key1')).toBe(100);
      expect(cache.get('key2')).toBe(200);
      expect(cache.get('key3')).toBeUndefined();
    });

    it('tracks hits and misses faithfully in getStats()', () => {
      const cache = new BoundedLruCache<string>(16);
      cache.set('alpha', 'value_a');

      expect(cache.get('alpha')).toBe('value_a'); // 1 hit
      expect(cache.get('alpha')).toBe('value_a'); // 2 hits
      expect(cache.get('beta')).toBeUndefined();  // 1 miss
      expect(cache.get('gamma')).toBeUndefined(); // 2 misses

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(2);
      expect(stats.size).toBe(1);
      expect(stats.capacity).toBe(16);
    });

    it('strictly respects capacity limit and evicts the least recently used item', () => {
      // Small capacity (min is 16 for safety, so test capacity 16)
      const capacity = 16;
      const cache = new BoundedLruCache<string>(capacity);

      // Fill to capacity
      for (let i = 1; i <= capacity; i++) {
        cache.set(`item-${i}`, `val-${i}`);
      }
      expect(cache.size).toBe(capacity);
      expect(cache.has('item-1')).toBe(true);

      // Access item-1 so it is marked recently used!
      expect(cache.get('item-1')).toBe('val-1');

      // Now add item-17. The oldest unaccessed item is item-2, NOT item-1!
      cache.set('item-17', 'val-17');

      expect(cache.size).toBe(capacity);
      expect(cache.has('item-2')).toBe(false); // item-2 evicted
      expect(cache.has('item-1')).toBe(true);  // item-1 preserved because it was accessed!
      expect(cache.has('item-17')).toBe(true);
    });

    it('updates existing keys without altering capacity size', () => {
      const cache = new BoundedLruCache<string>(16);
      cache.set('test', 'first');
      expect(cache.size).toBe(1);

      cache.set('test', 'second');
      expect(cache.size).toBe(1);
      expect(cache.get('test')).toBe('second');
    });

    it('clears all items completely', () => {
      const cache = new BoundedLruCache<string>(16);
      cache.set('k1', 'v1');
      cache.set('k2', 'v2');
      expect(cache.size).toBe(2);

      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('k1')).toBeUndefined();
    });
  });

  describe('Deterministic Composite Keys', () => {
    it('creates stable cosmetic cache keys based on host and flag values', () => {
      const key1 = createCosmeticKey('example.com', true, true, false);
      const key2 = createCosmeticKey('example.com', true, false, false);
      const key3 = createCosmeticKey('example.com', true, true, true);
      const key4 = createCosmeticKey('different.com', true, true, false);

      expect(key1).toBe('example.com|a:1|an:1|p:0');
      expect(key2).toBe('example.com|a:1|an:0|p:0');
      expect(key3).toBe('example.com|a:1|an:1|p:1');
      expect(key4).toBe('different.com|a:1|an:1|p:0');

      expect(key1).not.toBe(key2);
      expect(key1).not.toBe(key3);
      expect(key1).not.toBe(key4);
    });

    it('creates stable dispatch cache keys based on host and flag values', () => {
      const key1 = createDispatchKey('youtube.com', true, false);
      const key2 = createDispatchKey('youtube.com', false, false);
      const key3 = createDispatchKey('youtube.com', true, true);

      expect(key1).toBe('youtube.com|a:1|p:0');
      expect(key2).toBe('youtube.com|a:0|p:0');
      expect(key3).toBe('youtube.com|a:1|p:1');
    });
  });

  describe('Cache Invalidation on Settings Mutation', () => {
    it('invalidates cosmetic and dispatch caches when settings are updated', async () => {
      const cosmeticData: CosmeticCachedResponse = {
        css: '##.ad-banner { display: none !important; }',
        selectors: ['.ad-banner'],
        enabled: true
      };
      const dispatchData: DispatchCachedResponse = {
        entries: [{ name: 'defuse-yt', args: [] }]
      };

      const cKey = createCosmeticKey('site.com', true, false, false);
      const dKey = createDispatchKey('site.com', true, false);

      cosmeticCache.set(cKey, cosmeticData);
      dispatchCache.set(dKey, dispatchData);

      expect(cosmeticCache.size).toBe(1);
      expect(dispatchCache.size).toBe(1);

      // Trigger updateSettings
      const nextSettings = defaultSettings();
      nextSettings.masterEnabled = false;
      await updateSettings(nextSettings);

      // Caches must be cleared
      expect(cosmeticCache.size).toBe(0);
      expect(dispatchCache.size).toBe(0);
      expect(cosmeticCache.get(cKey)).toBeUndefined();
      expect(dispatchCache.get(dKey)).toBeUndefined();
    });

    it('manually invalidates caches on invalidateCosmeticCaches() call', () => {
      cosmeticCache.set('cKey', { css: '', selectors: [], enabled: true });
      dispatchCache.set('dKey', { entries: [] });
      expect(cosmeticCache.size).toBe(1);
      expect(dispatchCache.size).toBe(1);

      invalidateCosmeticCaches();

      expect(cosmeticCache.size).toBe(0);
      expect(dispatchCache.size).toBe(0);
    });
  });

  describe('Performance & Latency Benchmark', () => {
    it('delivers sub-0.05ms average retrieval time for cached items across 1,000 iterations', () => {
      const cache = new BoundedLruCache<{ css: string }>(128);
      const sample = { css: '##.ad-banner, .sponsor, #promo { display: none !important; }' };

      // Pre-seed 50 items
      for (let i = 0; i < 50; i++) {
        cache.set(`domain-${i}.com`, sample);
      }

      const iterations = 1000;
      let lastItem: unknown;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        const key = `domain-${i % 50}.com`;
        lastItem = cache.get(key);
      }
      const totalElapsedMs = performance.now() - start;
      const avgMsPerLookup = totalElapsedMs / iterations;

      expect(lastItem).toBeDefined();
      // Sub-millisecond requirement: avg lookup is well under 0.05ms
      expect(avgMsPerLookup).toBeLessThan(0.05);
    });
  });
});
