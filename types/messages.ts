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
  | { type: 'CHECK_LOGIN_FORMS'; pageOrigin: string; forms: { actionOrigin: string; hasPasswordField: boolean }[] }
  | { type: 'THREAT_ACTION'; tabId: number; action: 'leave' | 'block' | 'continue' }
  | { type: 'GET_TAB_STATE'; tabId: number };

export type RpcHandler = (payload: unknown, sender: chrome.runtime.MessageSender) => Promise<unknown>;

/** Message the service worker pushes to a tab's warning banner. */
export interface BannerMessage {
  v: 1;
  type: 'AUVYQ_SHOW_THREAT';
  risk: RiskResult;
  host: string;
}

export type { Settings, Snapshot, ThreatLogEntry };
