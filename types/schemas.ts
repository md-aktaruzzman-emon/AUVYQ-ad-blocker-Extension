/** AUVYQ core data contracts. Runtime-validated at every trust boundary (see core/validation/schemas.ts). */

export type FilterKind = 'network' | 'cosmetic' | 'scriptlet' | 'redirect' | 'removeparam';

export interface FilterIR {
  kind: FilterKind;
  source: {
    listId: string;
    line: number;
  };
  network?: {
    match: {
      domains?: string[];
      notDomains?: string[];
      resourceTypes: string[];
      thirdParty?: boolean;
    };
    pattern: {
      urlFilter?: string;
      regex?: string;
      isRegexValidRE2: boolean;
    };
    action: 'block' | 'allow' | 'redirect' | 'modifyQuery';
    redirectTarget?: string;
    removeParams?: string[];
  };
  cosmetic?: {
    selector: string;
    domains: string[];
    isGeneric: boolean;
  };
  scriptlet?: {
    name: string;
    args: (string | number)[];
    domains?: string[];
  };
}

export interface CompiledPack {
  version: number;
  dnrRules: {
    hotfix: unknown[];
    trackers: unknown[];
    ads: unknown[];
  };
  cosmetic: {
    genericCss: string;
    perDomain: Record<string, string[]>;
  };
  scriptletDispatch: Record<string, { name: string; args: (string | number)[] }[]>;
  stats: {
    rulesCompiled: number;
    dropped: number;
    downgradedToCosmetic: number;
  };
}

export interface Snapshot {
  day: string;
  adsBlocked: number;
  trackersBlocked: number;
  paramsStripped: number;
  cosmeticHidden: number;
  threats: number;
  cookiesCleaned: number;
  updatedAt: number;
}

export type PresetName = 'basic' | 'balanced' | 'strong' | 'maximum' | 'expert';

export interface Settings {
  schemaVersion: number;
  preset: PresetName;
  masterEnabled: boolean;
  modules: {
    ads: boolean;
    trackers: boolean;
    cookies: boolean;
    heuristics: boolean;
    fingerprintShields: boolean;
    annoyances: boolean;
  };
  perSite: Record<string, { paused: boolean; allowlist: string[] }>;
  telemetryOptIn: boolean;
  fpShields: Record<string, boolean>;
  logRetentionDays: 7 | 30;
  developerMode: boolean;
  theme: 'system' | 'dark' | 'light';
}

export type RiskSeverity = 'none' | 'low' | 'medium' | 'high' | 'malicious';

export interface RiskResult {
  score: number;
  severity: RiskSeverity;
  reasons: string[];
  confidence: number;
}

export interface DomFeatures {
  hostname: string;
  url: string;
  redirectChain?: { url: string; timeStamp: number }[];
  loginForms?: { actionOrigin: string; hasPasswordField: boolean }[];
  pageOrigin?: string;
}

export interface ThreatLogEntry {
  time: number;
  severity: RiskSeverity;
  host: string;
  reason: string;
  action: 'warned' | 'left' | 'blocked' | 'continued';
}

export interface UpdatePackage {
  id: string;
  url: string;
  sha256: string;
  signature: string;
}

export interface UpdateMetadata {
  version: string;
  createdAt: string;
  packages: UpdatePackage[];
}

export interface UpdateState {
  lastCheck: number;
  lastAppliedVersion: string;
  status: 'up-to-date' | 'update-available' | 'checking' | 'failed';
  lastError?: string;
  endpoint: string;
}

export type CookieCategory = 'tracker' | 'analytics' | 'session' | 'essential';

export interface CookieRule {
  domain: string;
  category: CookieCategory;
}

export type BannerStage = 'none' | 'warned' | 'confirmed' | 'acknowledged';

export interface TabThreatState {
  host: string;
  risk: RiskResult;
  stage: BannerStage;
}
