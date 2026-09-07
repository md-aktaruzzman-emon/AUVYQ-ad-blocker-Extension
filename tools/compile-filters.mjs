/*
 * Build-time Filter Compiler for AUVYQ.
 * Converts EasyList, EasyPrivacy, Annoyances, and uBO-compatible lists into:
 *   - Static Declarative Net Request rulesets (rules/easylist.json, rules/easyprivacy.json, rules/annoyances.json)
 *   - Build-time cosmetic assets (data/cosmetic/generic.css, data/cosmetic/specific.json)
 *   - Scriptlet dispatch configuration (data/scriptlets/dispatch.json)
 *   - License attributions in licenses/
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const ALLOWLISTED_SCRIPTLETS = new Set([
  'noop-callback', 'json-prune-lite', 'set-constant', 'prevent-addEventListener',
  'prevent-setTimeout', 'noop-fetch', 'close-window', 'no-fetch-if', 'no-xhr-if',
  'abort-on-property-read', 'hide-in-shadow', 'remove-class', 'remove-attr',
  'prevent-eval-if', 'trusted-suppress-console'
]);

const SCRIPTLET_NAME_ALIAS = {
  'set': 'set-constant',
  'set-constant.js': 'set-constant',
  'noop': 'noop-callback',
  'noop-callback.js': 'noop-callback',
  'json-prune': 'json-prune-lite',
  'json-prune.js': 'json-prune-lite',
  'nowebrtc': 'set-constant',
  'prevent-eval-if.js': 'prevent-eval-if',
  'abort-on-property-read.js': 'abort-on-property-read',
  'hide-in-shadow.js': 'hide-in-shadow'
};

const RESOURCE_MAP = {
  'image': 'image',
  'img': 'image',
  'script': 'script',
  'stylesheet': 'stylesheet',
  'css': 'stylesheet',
  'subdocument': 'sub_frame',
  'frame': 'sub_frame',
  'xmlhttprequest': 'xmlhttprequest',
  'xhr': 'xmlhttprequest',
  'ping': 'ping',
  'media': 'media',
  'font': 'font',
  'websocket': 'websocket',
  'other': 'other'
};

const CHROME_SUPPORTED_RESOURCES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'media', 'websocket', 'other'
]);

export function ensureLicenses(targetDir) {
  const licDir = path.join(targetDir, 'licenses');
  mkdirSync(licDir, { recursive: true });

  const easylistLic = `EasyList & EasyPrivacy
Dual-licensed under GNU General Public License v3 (GPLv3) and
Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0).
Source: https://easylist.to / https://github.com/easylist/easylist
Copyright (C) EasyList authors and contributors.

Compiled for AUVYQ local Declarative Net Request static rulesets.`;

  const uboLic = `uBlock Origin Assets
Licensed under GNU General Public License v3 (GPLv3).
Source: https://github.com/gorhill/uBlock
Copyright (C) Raymond Hill and contributors.`;

  writeFileSync(path.join(licDir, 'EASYLIST-LICENSE.txt'), easylistLic, 'utf8');
  writeFileSync(path.join(licDir, 'EASYPRIVACY-LICENSE.txt'), easylistLic, 'utf8');
  writeFileSync(path.join(licDir, 'UBLOCK-LICENSE.txt'), uboLic, 'utf8');
}

export function compileFilters(targetDir = rootDir) {
  ensureLicenses(targetDir);

  const vendorDir = path.join(targetDir, 'vendor', 'lists');
  mkdirSync(vendorDir, { recursive: true });
  mkdirSync(path.join(targetDir, 'rules'), { recursive: true });
  mkdirSync(path.join(targetDir, 'data', 'cosmetic'), { recursive: true });
  mkdirSync(path.join(targetDir, 'data', 'scriptlets'), { recursive: true });

  ensureVendorListFiles(vendorDir);

  const lists = [
    { file: 'easylist.txt', category: 'ads', idStart: 1000, idEnd: 9999, outFile: 'rules/easylist.json' },
    { file: 'easyprivacy.txt', category: 'trackers', idStart: 10000, idEnd: 19999, outFile: 'rules/easyprivacy.json' },
    { file: 'annoyances.txt', category: 'annoyances', idStart: 20000, idEnd: 24999, outFile: 'rules/annoyances.json' }
  ];

  const allGenericCss = [];
  const allSpecificCosmetic = {};
  const allScriptlets = {};

  let totalParsed = 0;
  let totalDnrRules = 0;
  let totalCosmeticRules = 0;
  let totalScriptletRules = 0;
  let totalDropped = 0;

  for (const listCfg of lists) {
    const filePath = path.join(vendorDir, listCfg.file);
    const content = readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);

    const dnrRules = [];
    let currentId = listCfg.idStart;

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('!') || line.startsWith('[Adblock')) continue;
      totalParsed++;

      // Scriptlet rule: ##+js(...)
      if (line.includes('##+js(')) {
        const parsed = parseScriptletLine(line);
        if (parsed) {
          totalScriptletRules++;
          for (const d of parsed.domains) {
            if (!allScriptlets[d]) allScriptlets[d] = [];
            allScriptlets[d].push({ name: parsed.name, args: parsed.args });
          }
        } else {
          totalDropped++;
        }
        continue;
      }

      // Cosmetic rule: ##... or domain##...
      if (line.includes('##') && !line.includes('##+js(')) {
        const parsed = parseCosmeticLine(line);
        if (parsed) {
          totalCosmeticRules++;
          if (parsed.isGeneric) {
            allGenericCss.push(`${parsed.selector}{display:none !important}`);
          } else {
            for (const d of parsed.domains) {
              if (!allSpecificCosmetic[d]) allSpecificCosmetic[d] = [];
              allSpecificCosmetic[d].push(`${parsed.selector}{display:none !important}`);
            }
          }
        } else {
          totalDropped++;
        }
        continue;
      }

      // Network rule
      const dnrRule = parseNetworkRule(line, currentId);
      if (dnrRule && currentId <= listCfg.idEnd) {
        dnrRules.push(dnrRule);
        currentId++;
        totalDnrRules++;
      } else {
        totalDropped++;
      }
    }

    writeFileSync(path.join(targetDir, listCfg.outFile), JSON.stringify(dnrRules, null, 2), 'utf8');
  }

  // Deduplicate and assemble generic CSS
  const uniqueGeneric = [...new Set(allGenericCss)];
  writeFileSync(path.join(targetDir, 'data', 'cosmetic', 'generic.css'), uniqueGeneric.join('\n'), 'utf8');

  // Specific cosmetic
  for (const d of Object.keys(allSpecificCosmetic)) {
    allSpecificCosmetic[d] = [...new Set(allSpecificCosmetic[d])];
  }
  writeFileSync(path.join(targetDir, 'data', 'cosmetic', 'specific.json'), JSON.stringify(allSpecificCosmetic, null, 2), 'utf8');

  // Scriptlet dispatch
  writeFileSync(path.join(targetDir, 'data', 'scriptlets', 'dispatch.json'), JSON.stringify(allScriptlets, null, 2), 'utf8');

  console.log(`============================================================
AUVYQ FILTER COMPILER STATISTICS
============================================================
Total Filter Lines Parsed:   ${totalParsed}
DNR Network Rules Compiled:  ${totalDnrRules}
Cosmetic Selectors Compiled: ${totalCosmeticRules} (Generic: ${uniqueGeneric.length}, Domains: ${Object.keys(allSpecificCosmetic).length})
Scriptlet Rules Compiled:    ${totalScriptletRules}
Unsupported/Dropped:         ${totalDropped}
Deterministic Output:        rules/, data/cosmetic/, data/scriptlets/
============================================================`);
}

function parseScriptletLine(line) {
  const parts = line.split('##+js(');
  if (parts.length !== 2) return null;
  const domainPart = parts[0].trim();
  const rest = parts[1].replace(/\)$/, '').trim();
  const rawArgs = rest.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
  if (rawArgs.length === 0) return null;

  let name = rawArgs[0];
  if (SCRIPTLET_NAME_ALIAS[name]) name = SCRIPTLET_NAME_ALIAS[name];
  if (!ALLOWLISTED_SCRIPTLETS.has(name)) return null;

  const args = rawArgs.slice(1);
  const domains = domainPart ? domainPart.split(',').map(d => d.trim().toLowerCase()).filter(Boolean) : ['(generic)'];
  return { domains, name, args };
}

function parseCosmeticLine(line) {
  const parts = line.split('##');
  if (parts.length !== 2) return null;
  const domainPart = parts[0].trim();
  const selector = parts[1].trim();
  if (!selector || selector.includes('{') || selector.includes('}')) return null;

  if (!domainPart) {
    return { isGeneric: true, selector };
  }
  const domains = domainPart.split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
  return { isGeneric: false, domains, selector };
}

function parseNetworkRule(line, ruleId) {
  let isAllow = false;
  if (line.startsWith('@@')) {
    isAllow = true;
    line = line.slice(2);
  }

  const parts = line.split('$');
  const pattern = parts[0].trim();
  const options = parts[1] ? parts[1].split(',') : [];

  const condition = {};
  let action = { type: isAllow ? 'allow' : 'block' };

  // Parse pattern
  if (pattern.startsWith('||')) {
    const rawDomain = pattern.slice(2).replace(/[\^/].*$/, '');
    if (rawDomain && !rawDomain.includes('*')) {
      condition.requestDomains = [rawDomain.toLowerCase()];
    } else {
      condition.urlFilter = pattern;
    }
  } else if (pattern.startsWith('|') && pattern.endsWith('|')) {
    condition.urlFilter = pattern.slice(1, -1);
  } else if (pattern.startsWith('/') && pattern.endsWith('/')) {
    const regex = pattern.slice(1, -1);
    try {
      new RegExp(regex);
      condition.regexFilter = regex;
    } catch {
      return null;
    }
  } else if (pattern) {
    condition.urlFilter = pattern;
  }

  // Parse options
  const resourceTypes = [];
  for (const opt of options) {
    const trimmed = opt.trim();
    if (trimmed === 'third-party') {
      condition.domainType = 'thirdParty';
    } else if (trimmed === '~third-party' || trimmed === 'first-party') {
      condition.domainType = 'firstParty';
    } else if (trimmed.startsWith('domain=')) {
      const domains = trimmed.slice(7).split('|');
      const reqDomains = [];
      const excDomains = [];
      for (const d of domains) {
        if (d.startsWith('~')) excDomains.push(d.slice(1).toLowerCase());
        else reqDomains.push(d.toLowerCase());
      }
      if (reqDomains.length > 0) condition.requestDomains = reqDomains;
      if (excDomains.length > 0) condition.excludedRequestDomains = excDomains;
    } else if (trimmed.startsWith('removeparam=')) {
      const param = trimmed.slice(12);
      if (param) {
        action = {
          type: 'redirect',
          redirect: {
            transform: {
              queryTransform: {
                removeParams: [param]
              }
            }
          }
        };
      }
    } else if (trimmed.startsWith('redirect=')) {
      const target = trimmed.slice(9);
      if (target === '1x1.gif' || target === 'noop.js') {
        action = {
          type: 'redirect',
          redirect: {
            extensionPath: `/resources/${target}`
          }
        };
      }
    } else if (RESOURCE_MAP[trimmed]) {
      const mapped = RESOURCE_MAP[trimmed];
      if (CHROME_SUPPORTED_RESOURCES.has(mapped)) {
        resourceTypes.push(mapped);
      }
    }
  }

  if (resourceTypes.length > 0) {
    condition.resourceTypes = [...new Set(resourceTypes)];
  }

  if (Object.keys(condition).length === 0) return null;

  return {
    id: ruleId,
    priority: isAllow ? 2 : 1,
    action,
    condition
  };
}

function ensureVendorListFiles(vendorDir) {
  const easylistPath = path.join(vendorDir, 'easylist.txt');
  const easyprivacyPath = path.join(vendorDir, 'easyprivacy.txt');
  const annoyancesPath = path.join(vendorDir, 'annoyances.txt');

  if (!existsSync(easylistPath)) {
    writeFileSync(easylistPath, getEmbeddedEasyList(), 'utf8');
  }
  if (!existsSync(easyprivacyPath)) {
    writeFileSync(easyprivacyPath, getEmbeddedEasyPrivacy(), 'utf8');
  }
  if (!existsSync(annoyancesPath)) {
    writeFileSync(annoyancesPath, getEmbeddedAnnoyances(), 'utf8');
  }
}

function getEmbeddedEasyList() {
  return `! Title: EasyList Core Pinned Snapshot
! Description: Network and cosmetic rules for ad blocking
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||2mdn.net^
||adnxs.com^
||adnxs.net^
||criteo.com^
||criteo.net^
||rubiconproject.com^
||pubmatic.com^
||smartadserver.com^
||openx.net^
||casalemedia.com^
||media.net^
||outbrain.com^
||taboola.com^
||revcontent.com^
||mgid.com^
||zergnet.com^
||ezoic.net^
||adblade.com^
||bidvertiser.com^
||adcolony.com^
||infolinks.com^
||buysellads.com^
||yieldmo.com^
||sovrn.com^
||triplelift.com^
||sharethrough.com^
||carbonads.net^
||carbonads.com^
||nativo.com^
||nativo.net^
||spotxchange.com^
||springserve.com^
||teads.tv^
||tradedoubler.com^
||serving-sys.com^
||flashtalking.com^
||fwmrm.net^
||advertising.com^
||ads.yahoo.com^
||adswizz.com^
||popads.net^
||popcash.net^
||propellerads.com^
||exoclick.com^
||exosrv.com^
||adcash.com^
||adsterra.com^
||hilltopads.net^
||juicyads.com^
||clickadu.com^
||clicksor.com^
||trafficjunky.com^
||trafficfactory.biz^
||ero-advertising.com^
||adxcore.com^
/ads.js$script
/adserver/$script,image,subdocument,xmlhttprequest
/adframe/$script,image,subdocument
/banner-ad/$image,subdocument,script
/adbanner/$image,script
/prebid$script
/popunder$script
/advert/$image,script,subdocument
/ad-slot/$script,subdocument
/sponsored_$image,subdocument,script
/adchoices$image,script
||connect.facebook.net^*/fbevents$script
||facebook.com^*/tr?$image,script,xmlhttprequest
||facebook.com^$removeparam=fbclid
||instagram.com^$removeparam=fbclid
||google.com^$removeparam=gclid
||linkedin.com^$removeparam=trk
||tiktok.com^$removeparam=ttclid
||twitter.com^$removeparam=twclid
||bing.com^$removeparam=msclkid
##.ad-banner
##.ad-banner-container
##.ad-box
##.ad-container
##.ad-label
##.ad-leaderboard
##.ad-placeholder
##.ad-sidebar
##.ad-slot
##.ad-slot-container
##.ad-space
##.ad-unit
##.ad-wrap
##.ad-wrapper
##.ad-zone
##.ads-container
##.adsbox
##.advertisement
##.advert
##.adverts
##.adslot
##.dfp-ad
##.dfp-slot
##.sponsored-ad
##.ezoic-ad
##.OUTBRAIN
##.ad-widget
##.adContainer
##.ad_container
##.advertisement-banner
##.ad-flex
##.ad-leaderboard-wrapper
##.ad-halfpage
##.ad-billboard
##.ad-mrec
##.ad-skyscraper
##.adtech
##.ad-tag
##.ad-block
##.ad-region
##.ad-section
##.adunit
##.ad-holder
##.ad-frame
##.ad-cell
##.ad-area
##[data-ad]
##[data-ad-unit]
##[data-ad-slot]
##[data-google-query-id]
##[data-dfp-ad]
##[data-prebid]
##[data-ez-name]
##[data-ezoic-id]
##[data-sponsored]
##[data-native-ad]
##[aria-label="Advertisement"]
##[aria-label="Sponsored"]
##.promoted-content
##.native-ad
##.sponsored-content
##.sponsored-post
##.sponsored-block
##.sponsor-block
##.ad-native
##.native-ad-container
##.in-feed-ad
##.in-article-ad
##[id^="taboola-"]
##.taboola-article-page-thumbnails
##[id^="outbrain-widget"]
##.mgid-widget
###adBanner
###adBox
###adContainer
###adSlot
###adUnit
##[id*="right-rail-ad"]
##[id*="sticky-ad"]
##.ad-overlay
##.ads-overlay
###ad-overlay
##.ad-popup
###ad-popup
##.ad-modal
###ad-modal
##.ad-interstitial
##.interstitial-ad
##.ad-fullscreen
##.ad-takeover
##.dfp-ad-interstitial
example.com##.sponsor-card
cnn.com##.ad-feedback
nytimes.com##.ad-sponsor-container
forbes.com##.top-ad-container
##+js(set-constant, gaOptout, true)
##+js(noop-callback, adsCallback)
`;
}

function getEmbeddedEasyPrivacy() {
  return `! Title: EasyPrivacy Core Pinned Snapshot
! Description: Network tracker and telemetry blocking
||scorecardresearch.com^
||quantserve.com^
||quantcount.com^
||moatads.com^
||doubleverify.com^
||adsafeprotected.com^
||bluekai.com^
||crwdcntrl.net^
||demdex.net^
||everesttech.net^
||exelator.com^
||id5-sync.com^
||krxd.net^
||liadm.com^
||omtrdc.net^
||rlcdn.com^
||tapad.com^
||w55c.net^
||adform.net^
||bidswitch.net^
||zemanta.com^
||mxptint.net^
||mathtag.com^
||agkn.com^
||bounceexchange.com^
||hotjar.com^$script
||mouseflow.com^$script
||crazyegg.com^$script
||fullstory.com^$script
||clarity.ms^$script
||inspectlet.com^$script
||luckyorange.com^$script
||clicktale.net^$script
||optimizely.com^$script
||segment.io^$script,xmlhttprequest
||segment.com^$script,xmlhttprequest
||mixpanel.com^$script,xmlhttprequest
||amplitude.com^$script,xmlhttprequest
||heapanalytics.com^$script,xmlhttprequest
||kissmetrics.com^$script
||statcounter.com^$script
||yandex.ru/metrika^$script
||mc.yandex.ru^$script,xmlhttprequest
||smartlook.com^$script
||chartbeat.com^$script
||chartbeat.net^$script
||parsely.com^$script
||googletagmanager.com/gtag/js$script
||googletagmanager.com/gtm.js$script
||google-analytics.com/analytics.js$script
||google-analytics.com/gtag/js$script
||google-analytics.com/ga.js$script
||google-analytics.com/collect$ping,xmlhttprequest
||google-analytics.com/g/collect$ping,xmlhttprequest
/collect?$third-party,xmlhttprequest,ping
/beacon?$third-party,xmlhttprequest,ping
/analytics.js$third-party,script
/tracking.js$third-party,script
/pixel.gif$third-party,image
/fingerprint$third-party,script,xmlhttprequest
/clicktrack$third-party,script,image,xmlhttprequest,ping
/impression?$third-party,image,xmlhttprequest,ping
/track?$third-party,image,xmlhttprequest,ping
/event/track$third-party,xmlhttprequest,ping
/log/event$third-party,xmlhttprequest,ping
/piwik.js$third-party,script
/matomo.js$third-party,script
@@||accounts.google.com^$image,script,subdocument
@@||login.live.com^$image,script,subdocument
`;
}

function getEmbeddedAnnoyances() {
  return `! Title: Annoyances Core Pinned Snapshot
! Description: Cookie popups, intrusive banners and floating widgets
##.cookie-banner
##.cookie-notice
##.cookie-consent
##.cookie-popup
##.cookie-modal
##.cookie-law-info-bar
##.cookie-bar
###cookie-banner
###cookie-notice
###cookie-consent
###cookie-popup
###cookie-modal
###cookie-law-info-bar
###cookie-bar
##[id*="cookie-consent"]
##[id*="cookie-banner"]
##[class*="cookie-consent"]
##[class*="cookie-banner"]
##.newsletter-popup
##.newsletter-modal
##.newsletter-overlay
###newsletter-popup
###newsletter-modal
###newsletter-overlay
##.subscribe-popup
##.subscribe-modal
##.push-notification-banner
##.web-push-prompt
##.one-signal-prompt
###onesignal-slidedown-dialog
##.app-download-banner
##.smart-banner
##.floating-social-share
##.social-share-floating
##.sticky-social-bar
`;
}

if (process.argv[1] && process.argv[1].endsWith('compile-filters.mjs')) {
  compileFilters();
}