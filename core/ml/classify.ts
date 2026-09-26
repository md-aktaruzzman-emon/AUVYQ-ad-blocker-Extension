/*
 * ML seam. Tier 1 is deterministic heuristics. A future model plugs in via RiskModel
 * without changing any caller. AUVYQ makes NO claim that heuristics are machine learning.
 */
import type { DomFeatures, RiskResult } from '../../types/schemas.js';
import { assessThreat } from '../heuristic/tier1.js';

export interface RiskModel {
  classify(url: string, features: DomFeatures): Promise<RiskResult>;
}

/**
 * Reserved extension seam. When a real, validated model is added it is assigned here
 * and classify() prefers it. Deliberately null: no fake intelligence.
 */
export let activeRiskModel: RiskModel | null = null;

export function setActiveRiskModel(model: RiskModel | null): void {
  activeRiskModel = model;
}

export function classify(url: string, domFeatures: DomFeatures): RiskResult {
  // Deterministic tier-1 path (sync, no network, no model).
  return assessThreat({ ...domFeatures, url });
}

export async function classifyWithModel(url: string, domFeatures: DomFeatures): Promise<RiskResult> {
  if (activeRiskModel !== null) {
    try {
      return await activeRiskModel.classify(url, domFeatures);
    } catch {
      // Model failure must never break protection: fall through to tier 1.
    }
  }
  return classify(url, domFeatures);
}
