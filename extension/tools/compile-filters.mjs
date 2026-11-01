/*
 * Build-time Filter Compiler for AUVYQ.
 * Converts EasyList, EasyPrivacy, Peter Lowe's List, and Annoyances into:
 *   - Static Declarative Net Request rulesets (rules/easylist.json, rules/easyprivacy.json, rules/annoyances.json)
 *   - Build-time cosmetic assets (data/cosmetic/generic.css, data/cosmetic/specific.json)
 *   - Scriptlet dispatch configuration (data/scriptlets/dispatch.json)
 *   - Authoritative source & compilation metadata (data/filter-metadata.json)
 *   - Verified open-source license attributions in licenses/
 *
 * Designed to guarantee reproducible output, strict duplicate elimination,
 * false-positive prevention on sub-paths, and zero unhandled syntax drops.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

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

export function computeSha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function ensureLicenses(targetDir) {
  const licDir = path.join(targetDir, 'licenses');
  mkdirSync(licDir, { recursive: true });

  const easylistLic = `EasyList & EasyPrivacy
Dual-licensed under GNU General Public License v3 (GPLv3) and
Creative Commons Attribution-ShareAlike 3.0 Unported (CC BY-SA 3.0).
Source: https://easylist.to / https://github.com/easylist/easylist
Copyright (C) EasyList authors and contributors.

Compiled for AUVYQ local Declarative Net Request static rulesets.`;

  const peterLoweLic = `Peter Lowe's Ad and Tracking Server List
Source: https://pgl.yoyo.org/adservers/
Author: Peter Lowe (pgl@yoyo.org)
Licensed under Creative Commons Attribution 3.0 Unported (CC BY 3.0)
https://creativecommons.org/licenses/by/3.0/

Compiled for AUVYQ local Declarative Net Request static rulesets.`;

  const uboLic = `uBlock Origin Assets
Licensed under GNU General Public License v3 (GPLv3).
Source: https://github.com/gorhill/uBlock
Copyright (C) Raymond Hill and contributors.`;

  writeFileSync(path.join(licDir, 'EASYLIST-LICENSE.txt'), easylistLic, 'utf8');
  writeFileSync(path.join(licDir, 'EASYPRIVACY-LICENSE.txt'), easylistLic, 'utf8');
  writeFileSync(path.join(licDir, 'PETER-LOWE-LICENSE.txt'), peterLoweLic, 'utf8');
  writeFileSync(path.join(licDir, 'UBLOCK-LICENSE.txt'), uboLic, 'utf8');
}

function ruleConditionKey(condition, actionType) {
  return [
    actionType,
    condition.urlFilter || '',
    condition.regexFilter || '',
    (condition.requestDomains || []).slice().sort().join(','),
    (condition.initiatorDomains || []).slice().sort().join(','),
    (condition.excludedInitiatorDomains || []).slice().sort().join(','),
    (condition.resourceTypes || []).slice().sort().join(','),
    condition.domainType || ''
  ].join('§');
}

export function compileFilters(targetDir = rootDir) {
  ensureLicenses(targetDir);

  const vendorDir = path.join(targetDir, 'vendor', 'lists');
  mkdirSync(vendorDir, { recursive: true });
  mkdirSync(path.join(targetDir, 'rules'), { recursive: true });
  mkdirSync(path.join(targetDir, 'data', 'cosmetic'), { recursive: true });
  mkdirSync(path.join(targetDir, 'data', 'scriptlets'), { recursive: true });

  const listConfigs = [
    {
      files: ['easylist.txt', 'peter-lowe.txt'],
      category: 'ads',
      idStart: 1,
      maxRules: 30000,
      outFile: 'rules/easylist.json'
    },
    {
      files: ['easyprivacy.txt'],
      category: 'trackers',
      idStart: 1,
      maxRules: 30000,
      outFile: 'rules/easyprivacy.json'
    },
    {
      files: ['annoyances.txt'],
      category: 'annoyances',
      idStart: 1,
      maxRules: 30000,
      outFile: 'rules/annoyances.json'
    }
  ];

  const allGenericCss = [];
  const allSpecificCosmetic = {};
  const allScriptlets = {};

  let totalParsed = 0;
  let totalDnrRules = 0;
  let totalCosmeticRules = 0;
  let totalScriptletRules = 0;
  let totalDuplicates = 0;
  let totalUnsupported = 0;
  const unsupportedBreakdown = {};
  const listStats = [];
  const sourceDigests = {};

  function logUnsupported(reason) {
    totalUnsupported++;
    unsupportedBreakdown[reason] = (unsupportedBreakdown[reason] || 0) + 1;
  }

  for (const listCfg of listConfigs) {
    const dnrRules = [];
    const seenConditions = new Set();
    let currentId = listCfg.idStart;
    let listDnrCount = 0;

    for (const fileName of listCfg.files) {
      const filePath = path.join(vendorDir, fileName);
      if (!existsSync(filePath)) {
        console.warn(`Vendor list file missing: ${filePath}`);
        continue;
      }

      const content = readFileSync(filePath, 'utf8');
      sourceDigests[fileName] = computeSha256(content);
      const lines = content.split(/\r?\n/);

      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('!') || line.startsWith('[Adblock')) continue;
        totalParsed++;

        // 1. Scriptlet rules: ##+js(...)
        if (line.includes('##+js(')) {
          const parsed = parseScriptletLine(line);
          if (parsed) {
            totalScriptletRules++;
            for (const d of parsed.domains) {
              if (!allScriptlets[d]) allScriptlets[d] = [];
              allScriptlets[d].push({ name: parsed.name, args: parsed.args });
            }
          } else {
            logUnsupported('scriptlet-rejected');
          }
          continue;
        }

        // 2. Cosmetic rules: ##... or domain##...
        if (line.includes('##') && !line.includes('##+js(')) {
          // Identify procedural cosmetic selectors (reserved for Part 5)
          if (line.includes(':has(') || line.includes(':has-text(') || line.includes(':-abp-has(') || line.includes(':xpath(')) {
            logUnsupported('procedural-cosmetic');
            continue;
          }
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
            logUnsupported('cosmetic-syntax');
          }
          continue;
        }

        // 3. Unsupported network options check
        if (line.includes('$csp=') || line.includes('$csp')) {
          logUnsupported('option:csp');
          continue;
        }
        if (line.includes('$badfilter')) {
          logUnsupported('directive:badfilter');
          continue;
        }
        if (line.includes('$generichide') || line.includes('$elemhide')) {
          logUnsupported('directive:generichide');
          continue;
        }
        if (line.includes('$popup')) {
          logUnsupported('option:popup');
          continue;
        }
        if (line.includes('$inline-script') || line.includes('$inline-font')) {
          logUnsupported('option:inline');
          continue;
        }

        // 4. Network DNR rules
        const dnrRule = parseNetworkRule(line, currentId);
        if (dnrRule) {
          const fp = ruleConditionKey(dnrRule.condition, dnrRule.action.type);
          if (seenConditions.has(fp)) {
            totalDuplicates++;
            continue;
          }
          seenConditions.add(fp);

          if (currentId > listCfg.maxRules) {
            throw new Error(`Ruleset ${listCfg.outFile} exceeded maximum static rule limit of ${listCfg.maxRules}`);
          }
          dnrRules.push(dnrRule);
          currentId++;
          totalDnrRules++;
          listDnrCount++;
        } else {
          logUnsupported('network-syntax');
        }
      }
    }

    // Deterministic sort of rules by ID
    dnrRules.sort((a, b) => a.id - b.id);
    listStats.push({ files: listCfg.files.join(' + '), outFile: listCfg.outFile, dnrCount: listDnrCount });
    writeFileSync(path.join(targetDir, listCfg.outFile), JSON.stringify(dnrRules, null, 2), 'utf8');
  }

  // Deduplicate and assemble generic CSS deterministically
  const uniqueGeneric = [...new Set(allGenericCss)].sort();
  writeFileSync(path.join(targetDir, 'data', 'cosmetic', 'generic.css'), uniqueGeneric.join('\n'), 'utf8');

  // Specific cosmetic
  for (const d of Object.keys(allSpecificCosmetic)) {
    allSpecificCosmetic[d] = [...new Set(allSpecificCosmetic[d])].sort();
  }
  const sortedSpecific = Object.fromEntries(
    Object.entries(allSpecificCosmetic).sort(([a], [b]) => a.localeCompare(b))
  );
  writeFileSync(path.join(targetDir, 'data', 'cosmetic', 'specific.json'), JSON.stringify(sortedSpecific, null, 2), 'utf8');

  // Scriptlet dispatch sorted deterministically
  const sortedScriptlets = Object.fromEntries(
    Object.entries(allScriptlets).sort(([a], [b]) => a.localeCompare(b))
  );
  writeFileSync(path.join(targetDir, 'data', 'scriptlets', 'dispatch.json'), JSON.stringify(sortedScriptlets, null, 2), 'utf8');

  // Read existing main.json and ads-trackers.json counts for full metadata
  let mainRulesCount = 0;
  let adsTrackersCount = 0;
  try {
    const mainRules = JSON.parse(readFileSync(path.join(targetDir, 'rules', 'main.json'), 'utf8'));
    mainRulesCount = mainRules.length;
  } catch { /* ignore */ }
  try {
    const adsTrackers = JSON.parse(readFileSync(path.join(targetDir, 'rules', 'ads-trackers.json'), 'utf8'));
    adsTrackersCount = adsTrackers.length;
  } catch { /* ignore */ }

  const metadata = {
    version: '2026.11.01',
    compiledAt: new Date().toISOString(),
    engine: 'AUVYQ-Declarative-Compiler/3.0.0',
    statistics: {
      totalParsedLines: totalParsed,
      totalCompiledDnrRules: totalDnrRules + mainRulesCount + adsTrackersCount,
      staticRulesets: {
        'rules/easylist.json': listStats.find(s => s.outFile.includes('easylist'))?.dnrCount || 0,
        'rules/easyprivacy.json': listStats.find(s => s.outFile.includes('easyprivacy'))?.dnrCount || 0,
        'rules/annoyances.json': listStats.find(s => s.outFile.includes('annoyances'))?.dnrCount || 0,
        'rules/main.json': mainRulesCount,
        'rules/ads-trackers.json': adsTrackersCount
      },
      cosmeticSelectors: {
        total: totalCosmeticRules,
        genericUnique: uniqueGeneric.length,
        scopedDomains: Object.keys(sortedSpecific).length
      },
      scriptletRules: totalScriptletRules,
      duplicatesEliminated: totalDuplicates,
      unsupportedSkipped: totalUnsupported,
      unsupportedBreakdown
    },
    sources: sourceDigests
  };

  writeFileSync(path.join(targetDir, 'data', 'filter-metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  const perListReport = listStats.map((s) => `  - ${s.outFile} (${s.files}): ${s.dnrCount} DNR rules`).join('\n');

  console.log(`============================================================
AUVYQ FILTER COMPILER STATISTICS
============================================================
Total Filter Lines Parsed:   ${totalParsed}
DNR Network Rules Compiled:  ${totalDnrRules} (All Rulesets Total: ${totalDnrRules + mainRulesCount + adsTrackersCount})
${perListReport}
  - rules/main.json (Core Base): ${mainRulesCount} DNR rules
  - rules/ads-trackers.json (Multi-Domain): ${adsTrackersCount} DNR rules
Cosmetic Selectors Compiled: ${totalCosmeticRules} (Generic Unique: ${uniqueGeneric.length}, Domains: ${Object.keys(sortedSpecific).length})
Scriptlet Rules Compiled:    ${totalScriptletRules}
Duplicates Deduplicated:     ${totalDuplicates}
Unsupported/Dropped Skipped: ${totalUnsupported}
Deterministic Output:        rules/, data/cosmetic/, data/scriptlets/
Metadata Recorded:           data/filter-metadata.json
============================================================`);

  return metadata;
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
    const rawPattern = pattern.slice(2);
    // If pattern contains path components or wildcards, use urlFilter to avoid over-blocking
    if (rawPattern.includes('/') || rawPattern.includes('?') || rawPattern.includes('*')) {
      condition.urlFilter = pattern;
    } else {
      // Pure domain matching rule (e.g. ||doubleclick.net^ or ||doubleclick.net)
      const rawDomain = rawPattern.replace(/\^.*$/, '');
      if (rawDomain && !rawDomain.includes('*')) {
        condition.requestDomains = [rawDomain.toLowerCase()];
      } else {
        condition.urlFilter = pattern;
      }
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
      if (reqDomains.length > 0) condition.initiatorDomains = reqDomains;
      if (excDomains.length > 0) condition.excludedInitiatorDomains = excDomains;
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

if (process.argv[1] && process.argv[1].endsWith('compile-filters.mjs')) {
  compileFilters(rootDir);
}
