/*
 * Quota management. Safe dynamic network-rule capacity is bounded; overflow rules are
 * deterministically demoted to cosmetic filtering ONLY when semantically safe
 * (single-domain image/media blocks become CSS hiding), otherwise dropped.
 */
import type { PackCategory, CompiledRule } from '../rule-compiler/compiler.js';

/** Chrome caps dynamic DNR rules; AUVYQ keeps a safety margin under the hard limit. */
export const SAFE_DYNAMIC_CAPACITY = 4500;

/** score = frequency x confidence, clamped to a stable range. */
export function scoreRule(frequency: number, confidence: number): number {
  const f = Number.isFinite(frequency) ? Math.min(Math.max(frequency, 0), 1) : 0;
  const c = Number.isFinite(confidence) ? Math.min(Math.max(confidence, 0), 1) : 0;
  return Math.round(f * c * 1e6) / 1e6;
}

export interface QuotaCandidate {
  key: string;
  score: number;
  category: PackCategory;
  rule: CompiledRule['rule'];
  cosmeticFallback: string | null;
}

export interface QuotaResult {
  kept: QuotaCandidate[];
  demotedCss: string[];
  dropped: number;
  stats: {
    kept: number;
    demotedToCosmetic: number;
    dropped: number;
  };
}

/**
 * Deterministic: sort by score desc, then key asc; keep the top `capacity`;
 * demote demotable overflow, drop the rest. Same input always yields the same output.
 */
export function applyQuota(candidates: QuotaCandidate[], capacity: number): QuotaResult {
  const cap = Math.max(0, Math.floor(capacity));
  const sorted = candidates.slice().sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.key.localeCompare(b.key);
  });

  const kept: QuotaCandidate[] = [];
  const demotedCss: string[] = [];
  let dropped = 0;
  const demotedKeys = new Set<string>();

  for (let i = 0; i < sorted.length; i++) {
    const candidate = sorted[i];
    if (kept.length < cap) {
      kept.push(candidate);
      continue;
    }
    if (candidate.cosmeticFallback !== null && !demotedKeys.has(candidate.cosmeticFallback)) {
      demotedKeys.add(candidate.cosmeticFallback);
      demotedCss.push(candidate.cosmeticFallback);
    } else {
      dropped += 1;
    }
  }

  return {
    kept,
    demotedCss,
    dropped,
    stats: {
      kept: kept.length,
      demotedToCosmetic: demotedCss.length,
      dropped
    }
  };
}
