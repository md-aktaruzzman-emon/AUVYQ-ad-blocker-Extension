/*
 * AUVYQ Ad-Blocking Coverage Audit Tool.
 * Parses fixtures/ad-coverage-test.html (132 test ad elements + 22 legitimate content elements)
 * and audits them against:
 *   1. content/cosmetic-injector.js BUILTIN_SELECTORS
 *   2. data/default-filters.txt (cosmetic and network rules)
 *   3. rules/ads-trackers.json and rules/main.json DNR rules
 *
 * Reports exact coverage percentages, false positives, and missed element breakdown.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function runAudit() {
  const fixturePath = path.join(rootDir, 'fixtures/ad-coverage-test.html');
  if (!existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`);
  }
  const fixtureHtml = readFileSync(fixturePath, 'utf8');

  // 1. Extract selectors from content/cosmetic-injector.js
  const injectorPath = path.join(rootDir, 'content/cosmetic-injector.js');
  const injectorCode = readFileSync(injectorPath, 'utf8');
  const builtinSelectors = extractBuiltinSelectors(injectorCode);

  // 2. Extract cosmetic & network rules from data/default-filters.txt
  const defaultFiltersPath = path.join(rootDir, 'data/default-filters.txt');
  const defaultFiltersText = existsSync(defaultFiltersPath) ? readFileSync(defaultFiltersPath, 'utf8') : '';
  const filterListCosmetics = extractFilterListCosmetics(defaultFiltersText);
  const filterListNetwork = extractFilterListNetwork(defaultFiltersText);

  // 3. Extract DNR rules from static rulesets
  const adsTrackersPath = path.join(rootDir, 'rules/ads-trackers.json');
  const mainPath = path.join(rootDir, 'rules/main.json');
  const dnrDomains = new Set();
  const dnrUrlFilters = [];

  for (const p of [adsTrackersPath, mainPath]) {
    if (existsSync(p)) {
      try {
        const rules = JSON.parse(readFileSync(p, 'utf8'));
        for (const rule of rules) {
          if (rule.action?.type === 'block') {
            if (rule.condition?.requestDomains) {
              for (const d of rule.condition.requestDomains) dnrDomains.add(d.toLowerCase());
            }
            if (rule.condition?.urlFilter) {
              dnrUrlFilters.push(rule.condition.urlFilter);
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }

  // Combine all selectors
  const allSelectors = [...builtinSelectors, ...filterListCosmetics];

  // Parse elements from fixture HTML
  const { adElements, legitElements } = parseFixtureElements(fixtureHtml);

  // Audit ad elements
  const results = {
    total: adElements.length,
    blocked: 0,
    missed: 0,
    networkBlocks: 0,
    domBlocks: 0,
    iframeBlocks: 0,
    falsePositives: 0,
    fpList: [],
    breakdown: {},
    missedItems: []
  };

  for (const el of adElements) {
    const group = el.group || 'Unknown';
    if (!results.breakdown[group]) {
      results.breakdown[group] = { total: 0, blocked: 0, missed: 0 };
    }
    results.breakdown[group].total += 1;

    let isBlocked = false;

    // A. Check DOM selectors
    const matchedSelector = matchesAnySelector(el, allSelectors);
    if (matchedSelector) {
      isBlocked = true;
      results.domBlocks += 1;
    }

    // B. Check Network / Iframe rules for iframes with src
    if (el.tag === 'iframe' && el.src) {
      const netMatch = matchesNetworkRule(el.src, dnrDomains, dnrUrlFilters, filterListNetwork);
      if (netMatch) {
        if (!isBlocked) {
          isBlocked = true;
          results.networkBlocks += 1;
        }
        results.iframeBlocks += 1;
      } else if (isBlocked) {
        results.iframeBlocks += 1;
      }
    }

    if (isBlocked) {
      results.blocked += 1;
      results.breakdown[group].blocked += 1;
    } else {
      results.missed += 1;
      results.breakdown[group].missed += 1;
      results.missedItems.push({
        id: el.id,
        tag: el.tag,
        class: el.className,
        group: el.group,
        attrs: el.attrs
      });
    }
  }

  // Check false positives on legitimate elements
  for (const el of legitElements) {
    const matched = matchesAnySelector(el, allSelectors);
    if (matched) {
      results.falsePositives += 1;
      results.fpList.push({ id: el.id, tag: el.tag, class: el.className, matchedSelector: matched });
    }
  }

  return results;
}

// ---- Helpers ---------------------------------------------------------------

function extractBuiltinSelectors(code) {
  const match = code.match(/const\s+BUILTIN_SELECTORS\s*=\s*\[([\s\S]*?)\];/);
  if (!match) return [];
  const body = match[1];
  const items = [];
  const regex = /'([^']+)'|"([^"]+)"/g;
  let m;
  while ((m = regex.exec(body)) !== null) {
    items.push(m[1] || m[2]);
  }
  return items;
}

function extractFilterListCosmetics(text) {
  const cosmetics = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('##')) {
      cosmetics.push(trimmed.slice(2).trim());
    } else if (trimmed.includes('##') && !trimmed.startsWith('#')) {
      const parts = trimmed.split('##');
      if (parts[1]) cosmetics.push(parts[1].trim());
    }
  }
  return cosmetics;
}

function extractFilterListNetwork(text) {
  const rules = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('!') || trimmed.startsWith('[') || trimmed.includes('##')) {
      continue;
    }
    rules.push(trimmed);
  }
  return rules;
}

function parseFixtureElements(html) {
  const adElements = [];
  const legitElements = [];

  const rawSections = html.split(/<div class="section/);
  for (let i = 1; i < rawSections.length; i++) {
    const raw = rawSections[i];
    const isLegit = raw.startsWith(' legitimate-content');
    const titleMatch = raw.match(/<h2>(Group [^<]+)<\/h2>/);
    const groupName = titleMatch ? titleMatch[1] : (isLegit ? 'Legitimate' : `Section ${i}`);

    const elRegex = /<(ins|div|iframe|article|nav|section|img|video|dialog|aside|header|footer)\b([^>]*?)(?:\/>|>([\s\S]*?)(?:<\/\1>|$))/gi;
    let elMatch;

    while ((elMatch = elRegex.exec(raw)) !== null) {
      const tag = elMatch[1].toLowerCase();
      const rawAttrs = elMatch[2];

      const attrs = {};
      const attrRegex = /([a-zA-Z0-9_\-:]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let aMatch;
      while ((aMatch = attrRegex.exec(rawAttrs)) !== null) {
        const name = aMatch[1].toLowerCase();
        const val = aMatch[2] ?? aMatch[3] ?? aMatch[4] ?? '';
        attrs[name] = val;
      }

      if (attrs.class === 'section' || attrs.class === 'box') continue;

      const element = {
        tag,
        id: attrs.id || '',
        className: attrs.class || '',
        classList: (attrs.class || '').split(/\s+/).filter(Boolean),
        src: attrs.src || '',
        attrs,
        group: groupName
      };

      if (element.id || element.className || tag === 'ins' || attrs['data-ad'] || attrs['data-ad-unit'] || attrs['aria-label'] || attrs.src) {
        if (isLegit) {
          legitElements.push(element);
        } else {
          adElements.push(element);
        }
      }
    }
  }

  return { adElements, legitElements };
}

function matchesAnySelector(el, selectors) {
  for (const selector of selectors) {
    if (matchesSingleSelector(el, selector)) {
      return selector;
    }
  }
  return null;
}

function matchesSingleSelector(el, selector) {
  const sel = selector.trim();
  if (!sel) return false;

  // Exact ID: #someId
  if (sel.startsWith('#')) {
    const targetId = sel.slice(1);
    return el.id === targetId;
  }

  // Exact Class: .some-class
  if (sel.startsWith('.')) {
    const targetClass = sel.slice(1);
    return el.classList.includes(targetClass);
  }

  // Tag + Class: ins.adsbygoogle
  if (/^[a-z0-9_-]+\.[a-z0-9_-]+$/i.test(sel)) {
    const [tag, cls] = sel.split('.');
    return el.tag === tag.toLowerCase() && el.classList.includes(cls);
  }

  // Bare Tag: amp-ad, amp-fx-flying-carpet
  if (/^[a-z0-9_-]+$/i.test(sel)) {
    return el.tag === sel.toLowerCase();
  }

  // Attribute prefix: [id^="div-gpt-ad"], [id^="aswift"], [id^="taboola-"]
  const attrPrefixMatch = sel.match(/^(?:([a-z0-9_-]+))?\[([a-z0-9_-]+)\^=["']?([^"']+)["']?\]$/i);
  if (attrPrefixMatch) {
    const [, tag, attr, prefix] = attrPrefixMatch;
    if (tag && el.tag !== tag.toLowerCase()) return false;
    const val = el.attrs[attr.toLowerCase()];
    return typeof val === 'string' && val.startsWith(prefix);
  }

  // Attribute substring / contains: iframe[src*="doubleclick.net"], div[class*="--ad-"]
  const attrContainsMatch = sel.match(/^(?:([a-z0-9_-]+))?\[([a-z0-9_-]+)\*=["']?([^"']+)["']?\]$/i);
  if (attrContainsMatch) {
    const [, tag, attr, sub] = attrContainsMatch;
    if (tag && el.tag !== tag.toLowerCase()) return false;
    const val = el.attrs[attr.toLowerCase()];
    return typeof val === 'string' && val.includes(sub);
  }

  // Attribute presence: [data-ad], [data-ad-slot], [data-dfp]
  const attrPresenceMatch = sel.match(/^(?:([a-z0-9_-]+))?\[([a-z0-9_-]+)\]$/i);
  if (attrPresenceMatch) {
    const [, tag, attr] = attrPresenceMatch;
    if (tag && el.tag !== tag.toLowerCase()) return false;
    return el.attrs[attr.toLowerCase()] !== undefined;
  }

  // Exact attribute: [aria-label="Advertisement"]
  const attrExactMatch = sel.match(/^(?:([a-z0-9_-]+))?\[([a-z0-9_-]+)=["']?([^"']+)["']?\]$/i);
  if (attrExactMatch) {
    const [, tag, attr, val] = attrExactMatch;
    if (tag && el.tag !== tag.toLowerCase()) return false;
    return el.attrs[attr.toLowerCase()] === val;
  }

  return false;
}

function matchesNetworkRule(srcUrl, dnrDomains, dnrUrlFilters, filterListNetwork) {
  if (!srcUrl) return false;
  let hostname = '';
  try {
    hostname = new URL(srcUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  // Check exact or suffix domain match against DNR domains
  for (const d of dnrDomains) {
    if (hostname === d || hostname.endsWith('.' + d)) {
      return true;
    }
  }

  // Check urlFilters
  for (const filter of dnrUrlFilters) {
    if (filter.startsWith('||')) {
      const pattern = filter.slice(2).replace(/\^.*/, '').toLowerCase();
      if (hostname === pattern || hostname.endsWith('.' + pattern)) {
        return true;
      }
    } else if (srcUrl.includes(filter)) {
      return true;
    }
  }

  // Check filterListNetwork
  for (const rule of filterListNetwork) {
    if (rule.startsWith('||')) {
      const domain = rule.slice(2).replace(/[\^$].*/, '').toLowerCase();
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        return true;
      }
    } else {
      const pattern = rule.replace(/\$.*/, '');
      if (pattern && srcUrl.includes(pattern)) {
        return true;
      }
    }
  }

  return false;
}

// ---- CLI runner ------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('ad-coverage-audit.mjs')) {
  const res = runAudit();
  const pct = Math.round((res.blocked / res.total) * 100);

  console.log('='.repeat(60));
  console.log('AUVYQ AD-BLOCKING COVERAGE AUDIT');
  console.log('='.repeat(60));
  console.log(`Total Tested Elements:   ${res.total}`);
  console.log(`Blocked Elements:        ${res.blocked}`);
  console.log(`Missed Elements:         ${res.missed}`);
  console.log(`Current Block Rate:      ${pct}% (${res.blocked} / ${res.total})`);
  console.log('');
  console.log(`DOM Blocks:              ${res.domBlocks}`);
  console.log(`Network Blocks:          ${res.networkBlocks}`);
  console.log(`Iframe Blocks:           ${res.iframeBlocks}`);
  console.log(`False Positives:         ${res.falsePositives}`);
  console.log('='.repeat(60));
  console.log('GROUP BREAKDOWN:');
  for (const [group, gRes] of Object.entries(res.breakdown)) {
    const gPct = gRes.total > 0 ? Math.round((gRes.blocked / gRes.total) * 100) : 0;
    console.log(`  ${group.padEnd(45)}: ${gRes.blocked}/${gRes.total} (${gPct}%)`);
  }
  console.log('='.repeat(60));

  if (res.falsePositives > 0) {
    console.log('⚠️  FALSE POSITIVES DETECTED:');
    for (const fp of res.fpList) {
      console.log(`  - Element #${fp.id} <${fp.tag}> matched "${fp.matchedSelector}"`);
    }
  } else {
    console.log('✅ ZERO FALSE POSITIVES (all 22 legitimate items are safe)');
  }
  console.log('='.repeat(60));

  if (res.missedItems.length > 0) {
    console.log(`Top Missed Items (${res.missedItems.length} total):`);
    res.missedItems.slice(0, 10).forEach((item, i) => {
      console.log(`  ${i + 1}. <${item.tag} id="${item.id}" class="${item.class}"> in [${item.group}]`);
    });
    if (res.missedItems.length > 10) {
      console.log(`  ... and ${res.missedItems.length - 10} more`);
    }
  }
}
