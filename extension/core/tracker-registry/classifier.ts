/*
 * AUVYQ Tracker Registry & Request Classification Engine.
 * Classifies network requests and cookies into categorized privacy profiles:
 * advertising, analytics, social, session_replay, and telemetry.
 * Identifies first-party vs third-party relationships and CNAME cloaking.
 */
import { normalizeHostname, registrableDomain, matchSuffix } from '../domain/normalize.js';

export type TrackerCategory =
  | 'advertising'
  | 'analytics'
  | 'social'
  | 'session_replay'
  | 'telemetry'
  | 'none';

export interface TrackerClassification {
  isTracker: boolean;
  category: TrackerCategory;
  entity?: string;
  isThirdParty: boolean;
  cnameCloaked: boolean;
  evidence: string[];
}

export interface TrackerEntityRule {
  domain: string;
  category: TrackerCategory;
  entity: string;
}

/**
 * Curated registry of verified commercial tracking and analytics domains.
 */
export const TRACKER_REGISTRY: readonly TrackerEntityRule[] = [
  // Google / Alphabet Advertising
  { domain: 'doubleclick.net', category: 'advertising', entity: 'Google' },
  { domain: 'googleadservices.com', category: 'advertising', entity: 'Google' },
  { domain: 'googlesyndication.com', category: 'advertising', entity: 'Google' },
  { domain: '2mdn.net', category: 'advertising', entity: 'Google' },
  { domain: 'adservice.google.com', category: 'advertising', entity: 'Google' },
  { domain: 'pagead2.googlesyndication.com', category: 'advertising', entity: 'Google' },
  { domain: 'tpc.googlesyndication.com', category: 'advertising', entity: 'Google' },

  // Google Analytics & Tag Management
  { domain: 'google-analytics.com', category: 'analytics', entity: 'Google' },
  { domain: 'googletagmanager.com', category: 'analytics', entity: 'Google' },
  { domain: 'googletagservices.com', category: 'analytics', entity: 'Google' },

  // Meta / Facebook
  { domain: 'facebook.net', category: 'social', entity: 'Meta' },
  { domain: 'facebook.com', category: 'social', entity: 'Meta' },
  { domain: 'connect.facebook.net', category: 'social', entity: 'Meta' },

  // ByteDance / TikTok
  { domain: 'analytics.tiktok.com', category: 'social', entity: 'ByteDance' },
  { domain: 'tiktokcdn.com', category: 'social', entity: 'ByteDance' },

  // Twitter / X
  { domain: 'ads-twitter.com', category: 'social', entity: 'X / Twitter' },
  { domain: 'static.ads-twitter.com', category: 'social', entity: 'X / Twitter' },

  // LinkedIn / Microsoft
  { domain: 'snap.licdn.com', category: 'social', entity: 'Microsoft' },
  { domain: 'px.ads.linkedin.com', category: 'social', entity: 'Microsoft' },
  { domain: 'clarity.ms', category: 'session_replay', entity: 'Microsoft' },
  { domain: 'bing.com', category: 'advertising', entity: 'Microsoft' },
  { domain: 'bat.bing.com', category: 'advertising', entity: 'Microsoft' },

  // Snapchat / Pinterest
  { domain: 'tr.snapchat.com', category: 'social', entity: 'Snapchat' },
  { domain: 'sc-static.net', category: 'social', entity: 'Snapchat' },
  { domain: 'ct.pinterest.com', category: 'social', entity: 'Pinterest' },

  // Major AdTech Networks & Exchanges
  { domain: 'adnxs.com', category: 'advertising', entity: 'AppNexus / Xandr' },
  { domain: 'adnxs.net', category: 'advertising', entity: 'AppNexus / Xandr' },
  { domain: 'appnexus.com', category: 'advertising', entity: 'AppNexus / Xandr' },
  { domain: 'criteo.com', category: 'advertising', entity: 'Criteo' },
  { domain: 'criteo.net', category: 'advertising', entity: 'Criteo' },
  { domain: 'rubiconproject.com', category: 'advertising', entity: 'Magnite / Rubicon' },
  { domain: 'pubmatic.com', category: 'advertising', entity: 'PubMatic' },
  { domain: 'openx.net', category: 'advertising', entity: 'OpenX' },
  { domain: 'openx.com', category: 'advertising', entity: 'OpenX' },
  { domain: 'casalemedia.com', category: 'advertising', entity: 'Index Exchange' },
  { domain: 'indexexchange.com', category: 'advertising', entity: 'Index Exchange' },
  { domain: 'indexww.com', category: 'advertising', entity: 'Index Exchange' },
  { domain: 'taboola.com', category: 'advertising', entity: 'Taboola' },
  { domain: 'taboolasyndication.com', category: 'advertising', entity: 'Taboola' },
  { domain: 'outbrain.com', category: 'advertising', entity: 'Outbrain' },
  { domain: 'outbrainimg.com', category: 'advertising', entity: 'Outbrain' },
  { domain: 'adroll.com', category: 'advertising', entity: 'NextRoll' },
  { domain: 'amazon-adsystem.com', category: 'advertising', entity: 'Amazon' },
  { domain: 'aaxads.com', category: 'advertising', entity: 'Amazon' },
  { domain: 'media.net', category: 'advertising', entity: 'Media.net' },
  { domain: 'triplelift.com', category: 'advertising', entity: 'TripleLift' },
  { domain: '3lift.com', category: 'advertising', entity: 'TripleLift' },
  { domain: 'sharethrough.com', category: 'advertising', entity: 'Sharethrough' },
  { domain: 'sovrn.com', category: 'advertising', entity: 'Sovrn' },
  { domain: 'yieldmo.com', category: 'advertising', entity: 'Yieldmo' },
  { domain: 'bidswitch.net', category: 'advertising', entity: 'Bidswitch' },
  { domain: 'gumgum.com', category: 'advertising', entity: 'GumGum' },
  { domain: 'kargo.com', category: 'advertising', entity: 'Kargo' },
  { domain: 'moatads.com', category: 'advertising', entity: 'Oracle Moat' },
  { domain: 'iasds.com', category: 'advertising', entity: 'Integral Ad Science' },
  { domain: 'scorecardresearch.com', category: 'advertising', entity: 'Comscore' },
  { domain: 'quantserve.com', category: 'advertising', entity: 'Quantcast' },
  { domain: 'quantcount.com', category: 'advertising', entity: 'Quantcast' },

  // Session Replay & Behavior Recording
  { domain: 'hotjar.com', category: 'session_replay', entity: 'Hotjar' },
  { domain: 'hotjar.io', category: 'session_replay', entity: 'Hotjar' },
  { domain: 'fullstory.com', category: 'session_replay', entity: 'FullStory' },
  { domain: 'logrocket.io', category: 'session_replay', entity: 'LogRocket' },
  { domain: 'logrocket.com', category: 'session_replay', entity: 'LogRocket' },
  { domain: 'smartlook.com', category: 'session_replay', entity: 'Smartlook' },
  { domain: 'mouseflow.com', category: 'session_replay', entity: 'Mouseflow' },
  { domain: 'luckyorange.com', category: 'session_replay', entity: 'Lucky Orange' },
  { domain: 'crazyegg.com', category: 'session_replay', entity: 'Crazy Egg' },
  { domain: 'inspectlet.com', category: 'session_replay', entity: 'Inspectlet' },

  // Product Analytics & Event Tracking
  { domain: 'mixpanel.com', category: 'analytics', entity: 'Mixpanel' },
  { domain: 'segment.io', category: 'analytics', entity: 'Twilio Segment' },
  { domain: 'segment.com', category: 'analytics', entity: 'Twilio Segment' },
  { domain: 'amplitude.com', category: 'analytics', entity: 'Amplitude' },
  { domain: 'heap.io', category: 'analytics', entity: 'Heap' },
  { domain: 'heapanalytics.com', category: 'analytics', entity: 'Heap' },
  { domain: 'chartbeat.com', category: 'analytics', entity: 'Chartbeat' },
  { domain: 'statcounter.com', category: 'analytics', entity: 'Statcounter' },
  { domain: 'yandex.ru', category: 'analytics', entity: 'Yandex' },
  { domain: 'mc.yandex.ru', category: 'analytics', entity: 'Yandex' },

  // Mobile & Attribution Telemetry
  { domain: 'appsflyer.com', category: 'telemetry', entity: 'AppsFlyer' },
  { domain: 'branch.io', category: 'telemetry', entity: 'Branch' },
  { domain: 'adjust.com', category: 'telemetry', entity: 'Adjust' },
  { domain: 'browser-intake-datadoghq.com', category: 'telemetry', entity: 'Datadog' },
  { domain: 'nr-data.net', category: 'telemetry', entity: 'New Relic' }
];

const TRACKER_PATH_REGEX = /(\/collect(\?|\/|$)|(\/|_)pixel(\.|\/|\?|$)|(\/|_)track(\.|\/|\?|$)|(\/|_)analytics(\.|\/|\?|$)|(\/|_)telemetry(\.|\/|\?|$)|(\/|_)beacon(\.|\/|\?|$)|(\/|_)event(s)?(\.|\/|\?|$))/i;

const CLOAKED_PREFIX_REGEX = /^(metrics|analytics|telemetry|track|tracker|data-track|stats|collect|log|beacon)\./i;

/**
 * Checks whether request host is third-party relative to initiator host.
 */
export function isThirdPartyHost(requestHost: string, initiatorHost: string): boolean {
  if (requestHost.length === 0 || initiatorHost.length === 0) return true;
  const reqReg = registrableDomain(requestHost);
  const initReg = registrableDomain(initiatorHost);
  return reqReg !== initReg;
}

/**
 * Analyzes and classifies a network request.
 */
export function classifyTrackerRequest(
  requestUrl: string,
  initiatorUrl = '',
  resourceType = 'other'
): TrackerClassification {
  let reqHost = '';
  let initHost = '';
  let pathname = '';
  const evidence: string[] = [];

  try {
    const parsedReq = new URL(requestUrl);
    reqHost = normalizeHostname(parsedReq.hostname);
    pathname = parsedReq.pathname;
  } catch {
    return {
      isTracker: false,
      category: 'none',
      isThirdParty: false,
      cnameCloaked: false,
      evidence: ['Invalid URL']
    };
  }

  if (initiatorUrl.length > 0) {
    try {
      initHost = normalizeHostname(new URL(initiatorUrl).hostname);
    } catch {
      initHost = '';
    }
  }

  const isThirdParty = isThirdPartyHost(reqHost, initHost);

  // 1. Direct match in Tracker Registry
  for (const rule of TRACKER_REGISTRY) {
    if (matchSuffix(reqHost, rule.domain)) {
      evidence.push(`Matched known tracking domain ${rule.domain} (${rule.entity})`);
      return {
        isTracker: true,
        category: rule.category,
        entity: rule.entity,
        isThirdParty,
        cnameCloaked: false,
        evidence
      };
    }
  }

  // 2. Check for CNAME Cloaking (first-party tracking proxy)
  if (!isThirdParty && reqHost !== initHost && CLOAKED_PREFIX_REGEX.test(reqHost)) {
    if (TRACKER_PATH_REGEX.test(pathname) || resourceType === 'xmlhttprequest' || resourceType === 'ping') {
      evidence.push(`Suspected first-party CNAME cloaking on ${reqHost}`);
      return {
        isTracker: true,
        category: 'analytics',
        entity: 'First-party proxy / CNAME cloaked tracker',
        isThirdParty: false,
        cnameCloaked: true,
        evidence
      };
    }
  }

  // 3. Path-based tracking heuristics on third-party requests
  if (isThirdParty && TRACKER_PATH_REGEX.test(pathname)) {
    evidence.push(`Third-party request to generic tracking path: ${pathname}`);
    return {
      isTracker: true,
      category: 'analytics',
      isThirdParty: true,
      cnameCloaked: false,
      evidence
    };
  }

  return {
    isTracker: false,
    category: 'none',
    isThirdParty,
    cnameCloaked: false,
    evidence
  };
}
