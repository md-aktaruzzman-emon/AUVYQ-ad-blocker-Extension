/*
 * AUVYQ dashboard. All data flows through the RPC message layer; bounded lists
 * with pagination; theme switching without layout jumps.
 */
import { animateShieldState, sweep, bindPressPop } from '../motion.js';

let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `db-${Date.now()}-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
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

// ---- theme -----------------------------------------------------------------

function applyTheme(theme) {
  const resolved = theme === 'system'
    ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  document.documentElement.setAttribute('data-theme', resolved);
}

// ---- navigation ------------------------------------------------------------

document.querySelectorAll('.auvyq-nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.auvyq-nav-item').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    const panel = $(`panel-${button.dataset.section}`);
    if (panel !== null) panel.classList.add('active');
  });
});

// ---- overview --------------------------------------------------------------

async function loadOverview() {
  try {
    const data = await rpc('GET_SNAPSHOT');
    const snapshot = data && typeof data.snapshot === 'object' ? data.snapshot : {};
    const total =
      (snapshot.adsBlocked || 0) + (snapshot.trackersBlocked || 0) + (snapshot.paramsStripped || 0) +
      (snapshot.cosmeticHidden || 0) + (snapshot.threats || 0) + (snapshot.cookiesCleaned || 0);
    $('total-blocked').textContent = String(total);
    const scoreEl = $('privacy-score');
    if (scoreEl) scoreEl.textContent = String(data && typeof data.privacyScore === 'number' ? data.privacyScore : 55);
    $('d-ads').textContent = String(snapshot.adsBlocked || 0);
    $('d-trackers').textContent = String(snapshot.trackersBlocked || 0);
    $('d-params').textContent = String(snapshot.paramsStripped || 0);
    $('d-cosmetic').textContent = String(snapshot.cosmeticHidden || 0);
    $('d-threats').textContent = String(snapshot.threats || 0);
    $('d-cookies').textContent = String(snapshot.cookiesCleaned || 0);

    const state = $('overview-state');
    if (data.masterEnabled === false) {
      state.className = 'auvyq-pill auvyq-pill-disabled';
      state.textContent = 'Protection disabled';
      animateShieldState($('shield-stage'), 'disabled');
    } else {
      state.className = 'auvyq-pill auvyq-pill-protected';
      state.textContent = 'Protected';
      animateShieldState($('shield-stage'), 'protected');
    }
    renderChart();
  } catch {
    $('overview-state').textContent = 'Unavailable';
  }
}

async function renderChart() {
  try {
    const history = await rpc('GET_STATS_HISTORY');
    const chart = $('chart');
    chart.textContent = '';
    const days = Object.keys(history).sort().slice(-14);
    const max = Math.max(1, ...days.map((day) => {
      const s = history[day];
      return (s.adsBlocked || 0) + (s.trackersBlocked || 0) + (s.paramsStripped || 0);
    }));
    for (const day of days) {
      const s = history[day];
      const value = (s.adsBlocked || 0) + (s.trackersBlocked || 0) + (s.paramsStripped || 0);
      const bar = document.createElement('div');
      bar.className = 'chart-bar';
      bar.style.height = `${Math.max(2, Math.round((value / max) * 100))}%`;
      bar.title = `${day}: ${value} blocked`;
      chart.appendChild(bar);
    }
  } catch {
    // chart is decorative; failure is silent
  }
}

// ---- protection (presets + modules) ----------------------------------------

const PRESET_INFO = {
  basic: { label: 'Basic', desc: 'Ads only. Maximum compatibility.', recommended: false },
  balanced: { label: 'Balanced', desc: 'Recommended everyday protection.', recommended: true },
  strong: { label: 'Strong', desc: 'Adds stricter threat detection.', recommended: false },
  maximum: { label: 'Maximum', desc: 'Adds fingerprint shields.', recommended: false },
  expert: { label: 'Expert', desc: 'Full manual control + diagnostics.', recommended: false }
};

const MODULE_INFO = [
  { key: 'ads', name: 'Ad Blocking', desc: 'Blocks known advertising requests' },
  { key: 'trackers', name: 'Tracker Blocking', desc: 'Stops known tracking requests' },
  { key: 'cookies', name: 'Cookie Guard', desc: 'Cleans selected third-party tracker cookies' },
  { key: 'heuristics', name: 'Threat Heuristics', desc: 'Detects suspicious domains and login forms' },
  { key: 'fingerprintShields', name: 'Fingerprint Shields', desc: 'Optional browser fingerprint defenses' }
];

const FP_INFO = [
  { key: 'canvas', name: 'Canvas', desc: 'Adds subtle noise to canvas readback' },
  { key: 'webgl', name: 'WebGL', desc: 'Masks GPU vendor and renderer strings' },
  { key: 'navigator', name: 'Navigator', desc: 'Generalizes hardware metadata' },
  { key: 'screen', name: 'Screen', desc: 'Hides exact screen placement values' },
  { key: 'timing', name: 'Timing', desc: 'Reduces clock precision' }
];

function makeSwitch(checked, label, onToggle) {
  const button = document.createElement('button');
  button.className = 'auvyq-switch';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-checked', String(checked));
  button.setAttribute('aria-label', label);
  const knob = document.createElement('span');
  knob.className = 'auvyq-knob';
  button.appendChild(knob);
  button.addEventListener('click', () => {
    const next = button.getAttribute('aria-checked') !== 'true';
    button.setAttribute('aria-checked', String(next));
    onToggle(next);
  });
  button.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      button.click();
    }
  });
  return button;
}

async function loadSettings() {
  try {
    const settings = await rpc('GET_SETTINGS');
    // presets
    const grid = $('preset-grid');
    grid.textContent = '';
    for (const [key, info] of Object.entries(PRESET_INFO)) {
      const option = document.createElement('button');
      option.className = `preset-option${settings.preset === key ? ' selected' : ''}`;
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(settings.preset === key));
      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = info.label;
      const desc = document.createElement('span');
      desc.className = 'preset-desc';
      desc.textContent = info.desc;
      option.appendChild(name);
      if (info.recommended) {
        const rec = document.createElement('span');
        rec.className = 'preset-recommended';
        rec.textContent = 'Recommended';
        option.appendChild(rec);
      }
      option.appendChild(desc);
      option.addEventListener('click', () => {
        rpc('SET_SETTINGS', { preset: key }).then(loadSettings).catch(() => undefined);
      });
      grid.appendChild(option);
    }
    // modules
    const moduleList = $('module-list');
    moduleList.textContent = '';
    for (const module of MODULE_INFO) {
      const row = document.createElement('div');
      row.className = 'module-row';
      const info = document.createElement('div');
      info.className = 'module-info';
      const name = document.createElement('span');
      name.className = 'module-name';
      name.textContent = module.name;
      const desc = document.createElement('span');
      desc.className = 'module-desc';
      desc.textContent = module.desc;
      info.appendChild(name);
      info.appendChild(desc);
      row.appendChild(info);
      row.appendChild(makeSwitch(settings.modules[module.key] === true, module.name, (next) => {
        rpc('SET_SETTINGS', { modules: { [module.key]: next } }).catch(() => loadSettings());
      }));
      moduleList.appendChild(row);
    }
    // fp shields
    const fpList = $('fp-list');
    fpList.textContent = '';
    for (const shield of FP_INFO) {
      const row = document.createElement('div');
      row.className = 'module-row';
      const info = document.createElement('div');
      info.className = 'module-info';
      const name = document.createElement('span');
      name.className = 'module-name';
      name.textContent = shield.name;
      const desc = document.createElement('span');
      desc.className = 'module-desc';
      desc.textContent = shield.desc;
      info.appendChild(name);
      info.appendChild(desc);
      row.appendChild(info);
      row.appendChild(makeSwitch(settings.fpShields[shield.key] === true, shield.name, (next) => {
        rpc('SET_SETTINGS', { fpShields: { [shield.key]: next } }).catch(() => loadSettings());
      }));
      fpList.appendChild(row);
    }
    // settings inputs
    $('theme-select').value = settings.theme;
    $('retention-select').value = String(settings.logRetentionDays);
    $('telemetry-switch').setAttribute('aria-checked', String(settings.telemetryOptIn === true));
    applyTheme(settings.theme);
  } catch {
    // keep last rendered state
  }
}

$('theme-select').addEventListener('change', (event) => {
  const theme = event.target.value;
  applyTheme(theme);
  rpc('SET_SETTINGS', { theme }).catch(() => undefined);
});

$('retention-select').addEventListener('change', (event) => {
  rpc('SET_SETTINGS', { logRetentionDays: Number(event.target.value) }).catch(() => undefined);
});

$('telemetry-switch').addEventListener('click', () => {
  const next = $('telemetry-switch').getAttribute('aria-checked') !== 'true';
  $('telemetry-switch').setAttribute('aria-checked', String(next));
  rpc('SET_SETTINGS', { telemetryOptIn: next }).catch(() => undefined);
});

// ---- cookies ---------------------------------------------------------------

let cookiePage = 0;
const COOKIE_PAGE_SIZE = 10;
let cookieCache = [];

async function loadCookies() {
  try {
    const data = await rpc('GET_COOKIE_REPORT');
    cookieCache = Array.isArray(data.entries) ? data.entries : [];
    renderCookies();
  } catch {
    cookieCache = [];
    renderCookies();
  }
}

function renderCookies() {
  const list = $('cookie-list');
  list.textContent = '';
  const start = cookiePage * COOKIE_PAGE_SIZE;
  const slice = cookieCache.slice(start, start + COOKIE_PAGE_SIZE);
  if (slice.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'cookie-empty-state';
    empty.textContent = 'No cookies observed yet.';
    list.appendChild(empty);
  }
  for (const entry of slice) {
    const row = document.createElement('li');
    row.className = 'cookie-row';

    const name = document.createElement('span');
    name.className = 'cookie-name';
    name.textContent = entry.name;
    name.title = entry.name;

    const domain = document.createElement('span');
    domain.className = 'cookie-domain';
    domain.textContent = entry.domain;
    domain.title = entry.domain;

    const cat = document.createElement('span');
    cat.className = `cookie-cat ${entry.category}`;
    const catDot = document.createElement('span');
    catDot.className = 'cat-dot';
    cat.appendChild(catDot);
    cat.appendChild(document.createTextNode(entry.category));

    const actionWrap = document.createElement('div');
    actionWrap.className = 'cookie-action-wrap';

    if (entry.category === 'tracker' || entry.category === 'analytics') {
      const remove = document.createElement('button');
      remove.className = 'auvyq-button cookie-remove-btn';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', `Remove ${entry.name} cookie from ${entry.domain}`);
      remove.addEventListener('click', () => {
        remove.disabled = true;
        rpc('REMOVE_COOKIES', { entries: [{ name: entry.name, domain: entry.domain }] })
          .then(loadCookies)
          .catch(() => { remove.disabled = false; });
      });
      actionWrap.appendChild(remove);
    } else {
      const note = document.createElement('span');
      note.className = 'cookie-kept-pill';
      const keptDot = document.createElement('span');
      keptDot.className = 'kept-dot';
      note.appendChild(keptDot);
      note.appendChild(document.createTextNode('kept'));
      actionWrap.appendChild(note);
    }

    row.appendChild(name);
    row.appendChild(domain);
    row.appendChild(cat);
    row.appendChild(actionWrap);
    list.appendChild(row);
  }
  $('cookie-page').textContent = String(cookiePage + 1);
  $('cookie-prev').disabled = cookiePage === 0;
  $('cookie-next').disabled = start + COOKIE_PAGE_SIZE >= cookieCache.length;
}

$('cookie-prev').addEventListener('click', () => {
  if (cookiePage > 0) {
    cookiePage -= 1;
    renderCookies();
  }
});
$('cookie-next').addEventListener('click', () => {
  if ((cookiePage + 1) * COOKIE_PAGE_SIZE < cookieCache.length) {
    cookiePage += 1;
    renderCookies();
  }
});

const sweepAllBtn = $('sweep-all-cookies');
if (sweepAllBtn) {
  sweepAllBtn.addEventListener('click', async () => {
    const trackers = cookieCache.filter((c) => c.category === 'tracker' || c.category === 'analytics');
    if (trackers.length === 0) return;
    sweepAllBtn.disabled = true;
    try {
      await rpc('REMOVE_COOKIES', { entries: trackers.map((c) => ({ name: c.name, domain: c.domain })) });
      await loadCookies();
    } finally {
      sweepAllBtn.disabled = false;
    }
  });
}

// ---- threats ---------------------------------------------------------------

let threatPage = 0;

async function loadThreats() {
  try {
    const data = await rpc('GET_THREAT_LOG', { page: threatPage });
    const list = $('threat-list');
    list.textContent = '';
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'threat-row';
      empty.textContent = 'No threats detected.';
      list.appendChild(empty);
    }
    for (const entry of entries) {
      const row = document.createElement('li');
      row.className = 'threat-row';
      const top = document.createElement('div');
      top.className = 'threat-top';
      const severity = document.createElement('span');
      severity.className = `threat-severity ${entry.severity}`;
      severity.textContent = entry.severity.toUpperCase();
      const time = document.createElement('span');
      time.className = 'threat-time';
      time.textContent = new Date(entry.time).toLocaleString();
      top.appendChild(severity);
      top.appendChild(time);
      const reason = document.createElement('span');
      reason.className = 'threat-reason';
      reason.textContent = entry.reason;
      const host = document.createElement('span');
      host.className = 'threat-host';
      host.textContent = entry.host;
      row.appendChild(top);
      row.appendChild(reason);
      row.appendChild(host);
      list.appendChild(row);
    }
    $('threat-page').textContent = String(threatPage + 1);
    $('threat-prev').disabled = threatPage === 0;
    $('threat-next').disabled = (threatPage + 1) * 20 >= (data.total || 0);
  } catch {
    // keep last rendered state
  }
}

$('threat-prev').addEventListener('click', () => {
  if (threatPage > 0) {
    threatPage -= 1;
    loadThreats();
  }
});
$('threat-next').addEventListener('click', () => {
  threatPage += 1;
  loadThreats();
});

// ---- reports / updates -----------------------------------------------------

$('open-site-report').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/site-report/report.html') });
});

$('check-updates').addEventListener('click', async () => {
  $('update-status').textContent = 'Checking…';
  try {
    const result = await rpc('CHECK_UPDATES');
    if (result.ok) {
      $('update-status').textContent = 'Up to date. Protection rules are current.';
      sweep($('update-status').parentElement);
    } else {
      $('update-status').textContent = 'Update failed. Your previous protection rules are still active. Try again later.';
    }
  } catch {
    $('update-status').textContent = 'Update failed. Your previous protection rules are still active.';
  }
});

// ---- backup ----------------------------------------------------------------

function setBackupStatus(text) {
  $('backup-status').textContent = text;
}

$('backup-export').addEventListener('click', async () => {
  const password = $('backup-password').value;
  if (password.length < 8) {
    setBackupStatus('Password must be at least 8 characters.');
    return;
  }
  setBackupStatus('Encrypting…');
  try {
    const result = await rpc('EXPORT_BACKUP', { password });
    const bytes = new Uint8Array(result.bytes);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `auvyq-backup-${new Date().toISOString().slice(0, 10)}.auvyq`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setBackupStatus('Backup exported.');
  } catch (error) {
    setBackupStatus(`Export failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
});

$('backup-import').addEventListener('click', () => {
  $('backup-file').click();
});

$('backup-file').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (file === undefined) return;
  if (file.size > 8 * 1024 * 1024) {
    setBackupStatus('Backup file is too large.');
    return;
  }
  const password = $('backup-password').value;
  if (password.length < 8) {
    setBackupStatus('Enter the backup password first.');
    return;
  }
  setBackupStatus('Decrypting…');
  try {
    const buffer = new Uint8Array(await file.arrayBuffer());
    const result = await rpc('IMPORT_BACKUP', { data: Array.from(buffer), password });
    setBackupStatus(`Backup imported (${result.restored.length} sections restored).`);
    loadSettings();
    loadOverview();
  } catch (error) {
    setBackupStatus(`Import failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  event.target.value = '';
});

// ---- diagnostics + clear data ----------------------------------------------

async function loadDiagnostics() {
  try {
    const data = await rpc('GET_DIAGNOSTICS');
    $('diagnostics').textContent = JSON.stringify(data, null, 2);
  } catch {
    $('diagnostics').textContent = 'Diagnostics unavailable.';
  }
}

$('clear-data').addEventListener('click', () => {
  const confirmed = window.confirm('Clear all AUVYQ data (settings, statistics, logs, rules)? This does not touch any other browser data.');
  if (!confirmed) return;
  rpc('CLEAR_AUVYQ_DATA').then(() => {
    loadSettings();
    loadOverview();
    loadThreats();
    loadDiagnostics();
  }).catch(() => undefined);
});

// ---- boot ------------------------------------------------------------------

bindPressPop(document);
$('about-version').textContent = `Version ${chrome.runtime.getManifest().version} — Manifest V3, local-first.`;
applyTheme('system');
loadOverview();
loadSettings();
loadCookies();
loadThreats();
loadDiagnostics();
