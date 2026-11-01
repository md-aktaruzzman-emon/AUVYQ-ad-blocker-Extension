/*
 * AUVYQ cosmetic & scriptlet dispatch response cache.
 * Provides sub-millisecond, bounded-memory response caching for repeated
 * GET_COSMETIC and GET_DISPATCH calls (e.g. multi-frame pages and SPAs).
 */

export interface CosmeticCachedResponse {
  css: string;
  selectors: string[];
  enabled: boolean;
}

export interface DispatchCachedResponse {
  entries: { name: string; args: (string | number)[] }[];
}

export class BoundedLruCache<T> {
  private cache = new Map<string, T>();
  private readonly maxCapacity: number;
  private hits = 0;
  private misses = 0;

  constructor(maxCapacity = 128) {
    this.maxCapacity = Math.max(16, maxCapacity);
  }

  get(key: string): T | undefined {
    const val = this.cache.get(key);
    if (val !== undefined) {
      this.hits += 1;
      // Re-insert to refresh LRU order
      this.cache.delete(key);
      this.cache.set(key, val);
      return val;
    }
    this.misses += 1;
    return undefined;
  }

  set(key: string, value: T): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCapacity) {
      // Evict oldest item (first entry in Map iterator)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  getStats(): { hits: number; misses: number; size: number; capacity: number } {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      capacity: this.maxCapacity
    };
  }
}

/** Global singleton caches for the service worker instance. */
export const cosmeticCache = new BoundedLruCache<CosmeticCachedResponse>(128);
export const dispatchCache = new BoundedLruCache<DispatchCachedResponse>(128);

export function createCosmeticKey(host: string, ads: boolean, annoyances: boolean, paused: boolean): string {
  return `${host}|a:${ads ? 1 : 0}|an:${annoyances ? 1 : 0}|p:${paused ? 1 : 0}`;
}

export function createDispatchKey(host: string, ads: boolean, paused: boolean): string {
  return `${host}|a:${ads ? 1 : 0}|p:${paused ? 1 : 0}`;
}

/** Invalidates all cached cosmetic and dispatch calculations (called on settings/pack changes). */
export function invalidateCosmeticCaches(): void {
  cosmeticCache.clear();
  dispatchCache.clear();
}
