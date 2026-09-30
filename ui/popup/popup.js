/*
 * AUVYQ popup. Reads settings/snapshot ONLY through the message layer.
 * Performance target: visible content <300ms — no compilation, no heavy work.
 */
import { animateShieldState, bounce, sweep, cancelAll, bindPressPop, pop } from '../motion.js';

let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `pp-${Date.now()}-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
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

const elements = {
  statePill: document.getElementById('state-pill'),
  stateText: document.getElementById('state-text'),
  shieldStage: document.getElementById('shield-stage'),
  heroText: document.getElementById('hero-text'),
  masterSwitch: document.getElementById('master-switch'),
  statAds: document.getElementById('stat-ads'),
  statTrackers: document.getElementById('stat-trackers'),
  statThreats: document.getElementById('stat-threats'),
  siteHost: document.getElementById('site-host'),
  siteStatus: document.getElementById('site-status'),
  sitePause: document.getElementById('site-pause'),
  openDashboard: document.getElementById('open-dashboard'),
  sweepPanel: document.getElementById('sweep-panel')
};

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
  if (area === 'local' && changes.settings?.newValue) {
    if (changes.settings.newValue.theme) {
      applyTheme(changes.settings.newValue.theme);
    }
    void refresh();
  }
});

let masterEnabled = false;
let sitePaused = false;
let currentHost = '';
let switching = false;
let pollTimer = null;
let recentBlockEvents = [];
const previousStats = { ads: 0, trackers: 0, threats: 0 };

function setPill(kind, text) {
  elements.statePill.className = `auvyq-pill auvyq-pill-${kind}`;
  elements.stateText.textContent = text;
}

function applyShieldState(state) {
  animateShieldState(elements.shieldStage, state);
}

function renderSnapshot(data) {
  if (data === null || typeof data !== 'object') return;
  if (typeof data.theme === 'string') {
    applyTheme(data.theme);
  }
  const nextMaster = data.masterEnabled === true;
  const wasEnabled = masterEnabled;
  masterEnabled = nextMaster;
  sitePaused = data.sitePaused === true;
  currentHost = typeof data.host === 'string' ? data.host : '';

  elements.masterSwitch.setAttribute('aria-checked', String(nextMaster));

  if (!nextMaster) {
    setPill('disabled', 'Protection disabled');
    elements.heroText.textContent = 'AUVYQ is off';
    applyShieldState('disabled');
  } else if (sitePaused) {
    setPill('paused', 'Protection paused');
    elements.heroText.textContent = 'Paused on this site';
    applyShieldState('paused');
  } else {
    setPill('protected', 'Protected');
    elements.heroText.textContent = "You're protected";
    applyShieldState('protected');
  }

  const snapshot = typeof data.snapshot === 'object' && data.snapshot !== null ? data.snapshot : {};
  updateCounter(elements.statAds, 'ads', snapshot.adsBlocked);
  updateCounter(elements.statTrackers, 'trackers', snapshot.trackersBlocked);
  updateCounter(elements.statThreats, 'threats', snapshot.threats);

  if (currentHost.length > 0) {
    elements.siteHost.textContent = currentHost;
    elements.siteStatus.textContent = sitePaused ? 'Paused on this site' : 'This site is protected';
    elements.siteStatus.classList.toggle('paused', sitePaused);
    elements.sitePause.textContent = sitePaused ? 'Resume' : 'Pause';
    elements.sitePause.disabled = false;
    elements.sitePause.classList.toggle('is-paused', sitePaused);
  } else {
    elements.siteHost.textContent = 'No active tab';
    elements.siteStatus.textContent = nextMaster ? 'Ready to protect tabs' : 'Protection disabled';
    elements.siteStatus.classList.remove('paused');
    elements.sitePause.textContent = 'Pause';
    elements.sitePause.disabled = true;
    elements.sitePause.classList.remove('is-paused');
  }

  if (!wasEnabled && nextMaster) {
    applyShieldState('activating');
  }
}

function updateCounter(el, key, value) {
  const next = Number.isFinite(value) ? value : 0;
  const previous = previousStats[key];
  if (next > previous) {
    const delta = next - previous;
    bounce(el);
    registerBlockEvent(el, delta);
  }
  previousStats[key] = next;
  el.textContent = String(next);
}

/** +N chip when >=3 blocking events occur within 2 seconds. */
function registerBlockEvent(el, delta) {
  const now = Date.now();
  recentBlockEvents = recentBlockEvents.filter((t) => now - t < 2000);
  for (let i = 0; i < delta; i++) recentBlockEvents.push(now);
  if (recentBlockEvents.length >= 3) {
    const chip = document.createElement('span');
    chip.className = 'auvyq-chip';
    chip.textContent = `+${recentBlockEvents.length}`;
    el.parentElement.appendChild(chip);
    setTimeout(() => chip.remove(), 900);
    recentBlockEvents = [];
  }
}

async function refresh() {
  try {
    const data = await rpc('GET_SNAPSHOT');
    renderSnapshot(data);
  } catch {
    setPill('disabled', 'Unavailable');
    elements.heroText.textContent = 'Background service not responding';
  }
}

elements.masterSwitch.addEventListener('click', async () => {
  if (switching) return;
  switching = true;
  pop(elements.masterSwitch);
  const target = !(elements.masterSwitch.getAttribute('aria-checked') === 'true');
  try {
    await rpc('SET_SETTINGS', { masterEnabled: target });
    if (target) applyShieldState('activating');
    await refresh();
  } catch {
    await refresh();
  } finally {
    switching = false;
  }
});

elements.masterSwitch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    elements.masterSwitch.click();
  }
});

elements.sitePause.addEventListener('click', async () => {
  if (currentHost.length === 0) return;
  pop(elements.sitePause);
  try {
    await rpc('SET_SITE_PAUSED', { host: currentHost, paused: !sitePaused });
    await refresh();
  } catch {
    elements.siteStatus.textContent = 'Could not update this site';
  }
});

elements.openDashboard.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard/dashboard.html') });
});

// Cancel transient animations when the popup closes (no leaked timers / detached DOM).
window.addEventListener('unload', () => {
  if (pollTimer !== null) clearInterval(pollTimer);
  cancelAll(document);
});

bindPressPop(document);

// Boot: render immediately, then sweep >=120ms after first paint while protected.
void refresh().then(() => {
  if (masterEnabled && !sitePaused) sweep(elements.sweepPanel);
});
pollTimer = setInterval(refresh, 1500);
