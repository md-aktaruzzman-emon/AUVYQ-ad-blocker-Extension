/*
 * DNR adapter: diff-based dynamic rule application with rollback.
 * Priority ranges (exact):
 *   user session rules  10000-10999
 *   user custom rules    9000-9999
 *   channel hotfix       8000-8999
 *   list dynamic         1000-7999
 *   bundled static          1-999
 */
import type { CompiledRule } from '../../core/rule-compiler/compiler.js';

type DnrRule = chrome.declarativeNetRequest.Rule;

export const PRIORITY_RANGES = {
  userSession: { min: 10000, max: 10999 },
  userCustom: { min: 9000, max: 9999 },
  hotfix: { min: 8000, max: 8999 },
  listDynamic: { min: 1000, max: 7999 },
  bundledStatic: { min: 1, max: 999 }
} as const;

/** Dynamic range managed by this adapter for list/hotfix packs. */
const PACK_ID_MIN = 1000;
const PACK_ID_MAX = 8999;

const CHUNK_SIZE = 1000;

export interface ApplyReport {
  added: number;
  removed: number;
  rolledBack: boolean;
  error?: string;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic id assignment within the pack range with collision probing. */
export function assignPackIds(rules: { key: string; rule: DnrRule }[]): DnrRule[] {
  const used = new Set<number>();
  const out: DnrRule[] = [];
  for (const entry of rules) {
    let id = PACK_ID_MIN + (fnv1a(entry.key) % (PACK_ID_MAX - PACK_ID_MIN + 1));
    while (used.has(id)) {
      id += 1;
      if (id > PACK_ID_MAX) id = PACK_ID_MIN;
    }
    used.add(id);
    out.push({ ...entry.rule, id });
  }
  return out;
}

class AsyncMutex {
  private queue = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const res = this.queue.then(fn, fn);
    this.queue = res.then(() => {}, () => {});
    return res;
  }
}

export const dnrMutex = new AsyncMutex();

export function rulesEqual(a: DnrRule, b: DnrRule): boolean {
  if (a.id !== b.id || a.priority !== b.priority) return false;
  if (a.action.type !== b.action.type) return false;
  if (JSON.stringify(a.action) !== JSON.stringify(b.action)) return false;
  if (JSON.stringify(a.condition) !== JSON.stringify(b.condition)) return false;
  return true;
}

async function applyChunked(addRules: DnrRule[], removeRuleIds: number[]): Promise<void> {
  // Obsolete and changed rules are removed first to prevent duplicate rule ID errors
  for (let i = 0; i < removeRuleIds.length; i += CHUNK_SIZE) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeRuleIds.slice(i, i + CHUNK_SIZE)
    });
  }
  // Then new or updated rules are added in chunks
  for (let i = 0; i < addRules.length; i += CHUNK_SIZE) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: addRules.slice(i, i + CHUNK_SIZE)
    });
  }
}

/**
 * Applies a full diff of the pack serialized under dnrMutex. On API failure
 * the previously active rules are restored so AUVYQ is never left unprotected.
 */
export async function applyPackDiff(
  nextRules: { key: string; rule: DnrRule }[]
): Promise<ApplyReport> {
  return dnrMutex.run(async () => {
    let existing: DnrRule[] = [];
    try {
      existing = await chrome.declarativeNetRequest.getDynamicRules();
    } catch (error) {
      return { added: 0, removed: 0, rolledBack: true, error: `read failed: ${String(error)}` };
    }

    const existingPackRules = existing.filter((r) => r.id >= PACK_ID_MIN && r.id <= PACK_ID_MAX);
    const existingMap = new Map(existingPackRules.map((r) => [r.id, r]));
    const withIds = assignPackIds(nextRules);
    const nextMap = new Map(withIds.map((r) => [r.id, r]));

    const removeRuleIds: number[] = [];
    const rulesToAdd: DnrRule[] = [];

    // Identify rules that exist in the old pack but not the new pack
    for (const [id] of existingMap) {
      if (!nextMap.has(id)) {
        removeRuleIds.push(id);
      }
    }

    // Identify new and changed rules
    for (const nextRule of withIds) {
      const prev = existingMap.get(nextRule.id);
      if (prev !== undefined) {
        if (rulesEqual(prev, nextRule)) {
          // Rule unchanged: keep it in place
          continue;
        }
        // Rule changed: remove old and add new
        removeRuleIds.push(nextRule.id);
        rulesToAdd.push(nextRule);
      } else {
        // New rule ID
        rulesToAdd.push(nextRule);
      }
    }

    try {
      await applyChunked(rulesToAdd, removeRuleIds);
      return { added: rulesToAdd.length, removed: removeRuleIds.length, rolledBack: false };
    } catch (error) {
      // Rollback: restore the exact previous set.
      try {
        const addedIds: number[] = [];
        try {
          const nowExisting = await chrome.declarativeNetRequest.getDynamicRules();
          for (const rule of nowExisting) {
            if (rule.id >= PACK_ID_MIN && rule.id <= PACK_ID_MAX && !existingMap.has(rule.id)) {
              addedIds.push(rule.id);
            }
          }
        } catch {
          addedIds.push(...nextMap.keys());
        }
        await chrome.declarativeNetRequest.updateDynamicRules({
          removeRuleIds: addedIds,
          addRules: existingPackRules
        });
        return { added: 0, removed: 0, rolledBack: true, error: String(error) };
      } catch (rollbackError) {
        return { added: 0, removed: 0, rolledBack: true, error: `rollback failed: ${String(rollbackError)}` };
      }
    }
  });
}

/** Per-site pause uses a high-priority session allow rule. */
export function sitePauseRuleId(host: string): number {
  const offset = (fnv1a(`pause:${host}`) * 2) % (PRIORITY_RANGES.userSession.max - PRIORITY_RANGES.userSession.min - 4);
  return PRIORITY_RANGES.userSession.min + Math.abs(offset);
}

export async function setSitePause(host: string, paused: boolean): Promise<boolean> {
  return dnrMutex.run(async () => {
    const id = sitePauseRuleId(host);
    const id2 = id + 1;
    try {
      if (!paused) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id, id2] });
        return true;
      }
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [id, id2],
        addRules: [
          {
            id,
            priority: PRIORITY_RANGES.userSession.min + 50,
            action: { type: 'allow' },
            condition: { initiatorDomains: [host] }
          },
          {
            id: id2,
            priority: PRIORITY_RANGES.userSession.min + 50,
            action: { type: 'allow' },
            condition: { requestDomains: [host], initiatorDomains: [host] }
          }
        ]
      });
      return true;
    } catch {
      return false;
    }
  });
}

/** Converts compiled rules into quota candidates for activation. */
export function toPackEntries(rules: CompiledRule[]): { key: string; rule: DnrRule }[] {
  return rules.map((compiled) => ({ key: compiled.key, rule: compiled.rule }));
}

