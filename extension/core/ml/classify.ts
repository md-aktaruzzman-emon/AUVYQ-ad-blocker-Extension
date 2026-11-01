/*
 * AUVYQ ML Seam & Risk Classification Orchestrator.
 * 
 * Provides:
 * - Deterministic Tier 1 baseline heuristics (sync, zero-latency).
 * - Pluggable RiskModel interface for on-device machine learning classifiers.
 * - Active default: LocalUrlRiskClassifier (< 0.1ms, statistical logistic regression, zero-data leak).
 * - Automatic, unbreakable fallback to Tier 1 heuristics on model error or absence.
 */
import type { DomFeatures, RiskResult } from '../../types/schemas.js';
import { assessThreat } from '../heuristic/tier1.js';
import { LocalUrlRiskClassifier } from './url-classifier.js';

export interface RiskModel {
  readonly version?: string;
  classify(url: string, features: DomFeatures): Promise<RiskResult>;
}

/**
 * Validated local machine learning model instance.
 * Defaults to LocalUrlRiskClassifier (100% on-device, statistical logistic regression).
 */
export let activeRiskModel: RiskModel | null = new LocalUrlRiskClassifier();

export function setActiveRiskModel(model: RiskModel | null): void {
  activeRiskModel = model;
}

export function getActiveRiskModel(): RiskModel | null {
  return activeRiskModel;
}

/**
 * Synchronous deterministic Tier-1 path (zero network, pure functions).
 */
export function classify(url: string, domFeatures: DomFeatures): RiskResult {
  return assessThreat({ ...domFeatures, url });
}

/**
 * Asynchronous ML-assisted classification.
 * Executes active on-device RiskModel, with automatic fallback to deterministic Tier 1.
 */
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
