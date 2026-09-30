/*
 * AUVYQ site report. The current tab hostname is validated and used read-only;
 * per-site controls go through the message layer.
 */
import { bindPressPop, stagger } from '../motion.js';

let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `sr-${Date.now()}-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

function rpc(type, payload) {
  return chrome.runtime.sendMessage({ v: 1, type, requestId: nextRequestId(), payload })
    .then((response) => {
      if (response === undefined || response.success !== true) {
        throw new Error((response && response.error) || 'rpc failed');
      }
      return response.data;
    });
}

const $ = (id) => document.getElementById(id);

let currentConfiguredTheme = 'system';

function applyTheme(theme) {
  if (typeof theme === 'string') {
    currentConfiguredTheme = theme;
  }
  const target = theme || currentConfiguredTheme;
  const resolved = target === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : target;
  document.documentElement.setAttribute('data-theme', resolved);
}

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (currentConfiguredTheme === 'system') {
    applyTheme('system');
  }
});

chrome.storage.local.get('settings', (result) => {
  if (result?.settings?.theme) {
    applyTheme(result.settings.theme);
  } else {
    applyTheme('system');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue?.theme) {
    applyTheme(changes.settings.newValue.theme);
  }
});

function safeHostFromUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return /^[a-z0-9.-]+$/.test(host) && host.length <= 253 ? host : '';
  } catch {
    return '';
  }
}

let host = '';
let paused = false;

async function load() {
  let data = null;
  try {
    data = await rpc('GET_SITE_REPORT', {});
    host = typeof data.host === 'string' ? data.host : '';
    paused = data.paused === true;
  } catch {
    // fall back to the active tab's hostname, validated locally
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabHost = tabs[0] && tabs[0].url !== undefined ? safeHostFromUrl(tabs[0].url) : '';
    if (tabHost.length === 0) {
      $('report-host').textContent = 'Open a website to see its report.';
      return;
    }
    data = await rpc('GET_SITE_REPORT', { host: tabHost });
    host = typeof data.host === 'string' ? data.host : tabHost;
    paused = data.paused === true;
  }

  $('report-host').textContent = host;
  $('r-ads').textContent = String(data.adsBlocked || 0);
  $('r-trackers').textContent = String(data.trackersBlocked || 0);
  $('r-params').textContent = String(data.paramsStripped || 0);
  $('r-cosmetic').textContent = String(data.cosmeticHidden || 0);

  const state = $('report-state');
  if (paused) {
    state.className = 'auvyq-pill auvyq-pill-paused';
    state.textContent = 'Protection paused';
    $('site-toggle').textContent = 'Resume protection';
  } else {
    state.className = 'auvyq-pill auvyq-pill-protected';
    state.textContent = 'Protected';
    $('site-toggle').textContent = 'Pause protection';
  }

  const list = $('explanation-list');
  list.textContent = '';
  const items = [];
  const explanations = [
    ['Ads blocked', data.adsBlocked > 0 ? 'Advertising requests matched known ad patterns and were blocked.' : null, false],
    ['Trackers blocked', data.trackersBlocked > 0 ? 'These requests matched a known tracking pattern.' : null, false],
    ['Tracking parameters removed', data.paramsStripped > 0 ? 'Tracking parameters such as utm_ or click identifiers were stripped from links.' : null, false],
    ['Elements hidden', data.cosmeticHidden > 0 ? 'Page elements that only exist to show ads were hidden.' : null, false],
    ['Threat signals', data.threats > 0 ? 'This site produced suspicious signals (domain look-alikes or unsafe login forms).' : null, true]
  ];
  for (const [title, text, isThreat] of explanations) {
    if (text === null) continue;
    const item = document.createElement('li');
    item.className = `explanation-item auvyq-slide-item${isThreat ? ' threat' : ''}`;
    const t = document.createElement('span');
    t.className = 'explanation-title';
    t.textContent = title;
    const d = document.createElement('span');
    d.className = 'explanation-text';
    d.textContent = text;
    item.appendChild(t);
    item.appendChild(d);
    list.appendChild(item);
    items.push(item);
  }
  if (items.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'explanation-item';
    const t = document.createElement('span');
    t.className = 'explanation-title';
    t.textContent = 'Nothing blocked';
    const d = document.createElement('span');
    d.className = 'explanation-text';
    d.textContent = "AUVYQ didn't detect any blocked items on this page.";
    empty.appendChild(t);
    empty.appendChild(d);
    list.appendChild(empty);
  }
  stagger(list);
}

$('site-toggle').addEventListener('click', () => {
  if (host.length === 0) return;
  rpc('SET_SITE_PAUSED', { host, paused: !paused }).then(load).catch(() => undefined);
});

$('site-allow').addEventListener('click', () => {
  if (host.length === 0) return;
  rpc('SET_SITE_PAUSED', { host, paused: true, allow: true })
    .then(() => {
      $('site-note').textContent = 'This site was added to your allowlist. Protection resumes from the dashboard or popup.';
      load();
    })
    .catch(() => undefined);
});

bindPressPop(document);
void load();
