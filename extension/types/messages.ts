/** Strongly typed RPC protocol between UI/content contexts and the service worker. */

import type { Settings, Snapshot, RiskResult, ThreatLogEntry } from './schemas.js';

export interface RpcEnvelope {
  v: 1;
  type: string;
  requestId: string;
  payload?: unknown;
}

export interface RpcResponse {
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface SiteReportData {
  host: string;
  paused: boolean;
  adsBlocked: number;
  trackersBlocked: number;
  paramsStripped: number;
  cosmeticHidden: number;
  threats: number;
  risk: RiskResult;
}

export type RpcRequest =
  | { type: 'GET_SNAPSHOT' }
  | { type: 'GET_STATS_HISTORY' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; patch: Partial<Settings> }
  | { type: 'GET_SITE_REPORT'; host?: string }
  | { type: 'GET_PRIVACY_REPORT'; host?: string }
  | { type: 'SWEEP_COOKIES' }
  | { type: 'SET_SITE_PAUSED'; host: string; paused: boolean }
  | { type: 'GET_DISPATCH'; host: string }
  | { type: 'GET_COSMETIC'; host: string }
  | { type: 'GET_FP_SHIELDS'; host: string }
  | { type: 'EXPORT_BACKUP'; password: string }
  | { type: 'IMPORT_BACKUP'; data: number[]; password: string }
  | { type: 'CHECK_UPDATES' }
  | { type: 'GET_UPDATE_STATE' }
  | { type: 'GET_THREAT_LOG'; page: number }
  | { type: 'GET_COOKIE_REPORT' }
  | { type: 'REMOVE_COOKIES'; entries: { domain: string; name: string }[] }
  | { type: 'CLEAR_AUVYQ_DATA' }
  | { type: 'GET_DIAGNOSTICS' }
  | { type: 'SET_ONBOARDING_DONE'; done?: boolean }
  | { type: 'CHECK_LOGIN_FORMS'; pageOrigin: string; forms: { actionOrigin: string; hasPasswordField: boolean }[] }
  | { type: 'THREAT_ACTION'; tabId?: number; action: 'leave' | 'block' | 'continue' | 'allowlist' | 'report_false_positive' }
  | { type: 'REPORT_FALSE_POSITIVE'; tabId?: number }
  | { type: 'GET_TAB_STATE'; tabId: number }
  | { type: 'GET_CUSTOM_RULES' }
  | { type: 'ADD_CUSTOM_RULE'; ruleType?: 'cosmetic' | 'network'; rawText: string; domain?: string }
  | { type: 'UPDATE_CUSTOM_RULE'; id: string; enabled?: boolean; rawText?: string }
  | { type: 'DELETE_CUSTOM_RULE'; id: string }
  | { type: 'IMPORT_CUSTOM_RULES'; payload: string }
  | { type: 'EXPORT_CUSTOM_RULES'; format?: 'text' | 'json' }
  | { type: 'START_ELEMENT_PICKER'; tabId?: number }
  | { type: 'GET_AI_STATUS' }
  | { type: 'ANALYZE_URL_INTELLIGENCE'; url: string }
  | { type: 'GET_AI_EXPLANATION'; host: string; risk?: RiskResult }
  | { type: 'GET_AI_PRIVACY_ADVICE'; host: string };

export type RpcHandler = (payload: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>;

/** Message the service worker pushes to a tab's warning banner. */
export interface BannerMessage {
  v: 1;
  type: 'AUVYQ_SHOW_THREAT';
  risk: RiskResult;
  host: string;
}
