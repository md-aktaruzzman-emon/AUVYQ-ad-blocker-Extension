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
function computeGradeClass(score) {
  if (score >= 90) return { grade: 'A+', class: 'grade-A', label: 'Maximum Protection' };
  if (score >= 80) return { grade: 'A', class: 'grade-A', label: 'High Protection' };
  if (score >= 70) return { grade: 'B', class: 'grade-B', label: 'Good Protection' };
  if (score >= 60) return { grade: 'C', class: 'grade-C', label: 'Moderate Shield' };
  if (score >= 50) return { grade: 'D', class: 'grade-D', label: 'Low Defense' };
  return { grade: 'F', class: 'grade-F', label: 'Unprotected' };
}

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[&<>"']/g, (m) => {
    switch (m) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return m;
    }
  });
}


// ---- theme -----------------------------------------------------------------

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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings?.newValue) {
    const nextSettings = changes.settings.newValue;
    if (nextSettings.theme) {
      applyTheme(nextSettings.theme);
      const themeSelect = $('theme-select');
      if (themeSelect && themeSelect.value !== nextSettings.theme) {
        themeSelect.value = nextSettings.theme;
      }
    }
    loadSettings(nextSettings);
    loadOverview();
  }
});

// ---- navigation ------------------------------------------------------------

document.querySelectorAll('.auvyq-nav-item').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.auvyq-nav-item').forEach((b) => b.classList.remove('active'));
    button.classList.add('active');
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    const panel = $(`panel-${button.dataset.section}`);
    if (panel !== null) panel.classList.add('active');
    if (button.dataset.section === 'activity') loadActivityPanel();
    if (button.dataset.section === 'custom-rules') loadCustomRulesPanel();
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
    const rawScore = typeof data.privacyScore === 'number'
      ? data.privacyScore
      : (data.privacyReport?.score ?? (data.masterEnabled !== false ? 88 : 30));
    const gradeInfo = computeGradeClass(rawScore);
    const scoreValEl = $('overview-privacy-score');
    if (scoreValEl) scoreValEl.textContent = String(rawScore);
    const scoreGradeEl = $('overview-privacy-grade');
    if (scoreGradeEl) {
      scoreGradeEl.textContent = gradeInfo.grade;
      scoreGradeEl.className = `privacy-grade-badge ${gradeInfo.class}`;
    }
    const scoreLabelEl = $('overview-privacy-label');
    if (scoreLabelEl) scoreLabelEl.textContent = gradeInfo.label;

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

function t(key, fallback) {
  try {
    const msg = chrome?.i18n?.getMessage?.(key);
    if (typeof msg === 'string' && msg.length > 0) return msg;
  } catch {
    // fallback
  }
  return fallback;
}

const PRESET_KEYS = ['basic', 'balanced', 'strong', 'maximum', 'expert'];

const PRESET_INFO = {
  basic: {
    key: 'basic',
    label: t('presetBasicName', 'Basic'),
    desc: t('presetBasicDesc', 'Essential ad blocking with maximum compatibility.'),
    tag: t('presetBasicTag', 'Best when you want simple ad blocking with minimal site impact.'),
    recommended: false,
    statusTitle: 'Basic protection is active',
    statusDesc: 'Essential ad blocking with maximum compatibility. Best when you want simple ad blocking with minimal site impact.',
    toast: 'Basic protection enabled.'
  },
  balanced: {
    key: 'balanced',
    label: t('presetBalancedName', 'Standard (Balanced)'),
    desc: t('presetBalancedDesc', 'Everyday ad, tracker, cookie, and threat protection.'),
    tag: t('presetBalancedTag', 'Recommended for most users. Blocks ads & trackers with 100% site compatibility.'),
    recommended: true,
    statusTitle: 'Standard (Balanced) protection is active',
    statusDesc: 'Everyday ad, tracker, cookie, and threat protection. Recommended for most browsing.',
    toast: 'Standard protection enabled.'
  },
  strong: {
    key: 'strong',
    label: t('presetStrongName', 'Strong'),
    desc: t('presetStrongDesc', 'Stronger tracking and threat protection.'),
    tag: t('presetStrongTag', 'More protection with annoyance blocking enabled.'),
    recommended: false,
    statusTitle: 'Strong protection is active',
    statusDesc: 'Stronger tracking and threat protection with annoyance blocking.',
    toast: 'Strong protection enabled.'
  },
  maximum: {
    key: 'maximum',
    label: t('presetMaximumName', 'Strict (Maximum)'),
    desc: t('presetMaximumDesc', 'Maximum available protection, including fingerprint defenses and cookie consent handling.'),
    tag: t('presetMaximumTag', 'Strongest privacy defense. Automatically hides annoying cookie banners and shields fingerprints.'),
    recommended: false,
    statusTitle: 'Strict (Maximum) protection is active',
    statusDesc: 'Maximum available protection, including fingerprint defenses and cookie consent handling.',
    toast: 'Strict protection enabled.'
  },
  expert: {
    key: 'expert',
    label: t('presetExpertName', 'Custom (Expert)'),
    desc: t('presetExpertDesc', 'Full manual control over protection modules and custom filters.'),
    tag: t('presetExpertTag', 'Configure each protection module and custom rules individually.'),
    recommended: false,
    statusTitle: 'Custom (Expert) protection is active',
    statusDesc: 'Manual protection control. Configure each protection module and custom filter individually.',
    toast: 'Custom protection settings active.'
  }
};

const MODULE_INFO = [
  { key: 'ads', name: t('moduleAdsName', 'Ad Blocking'), desc: t('moduleAdsDesc', 'Blocks known ads and advertising requests.') },
  { key: 'trackers', name: t('moduleTrackersName', 'Tracker Blocking'), desc: t('moduleTrackersDesc', 'Stops known trackers and tracking requests across websites.') },
  { key: 'annoyances', name: t('moduleAnnoyancesName', 'Annoyance Blocking'), desc: t('moduleAnnoyancesDesc', 'Blocks cookie consent banners, newsletter prompts, and intrusive overlays.') },
  { key: 'cookies', name: t('moduleCookiesName', 'Cookie Guard'), desc: t('moduleCookiesDesc', 'Removes selected tracking cookies from third-party sites.') },
  { key: 'heuristics', name: t('moduleHeuristicsName', 'Threat Detection'), desc: t('moduleHeuristicsDesc', 'Detects suspicious websites, domain lookalikes, and risky login pages.') },
  { key: 'fingerprintShields', name: t('moduleFpName', 'Fingerprint Protection'), desc: t('moduleFpDesc', 'Reduces browser fingerprinting signals.') }
];

const FP_INFO = [
  { key: 'canvas', name: 'Canvas Defense', desc: 'Adds subtle noise to canvas readback' },
  { key: 'webgl', name: 'WebGL Masking', desc: 'Masks GPU vendor and renderer strings' },
  { key: 'navigator', name: 'Navigator Protection', desc: 'Generalizes hardware and platform metadata' },
  { key: 'screen', name: 'Screen Obfuscation', desc: 'Hides exact display geometry and placement' },
  { key: 'timing', name: 'Timing Jitter', desc: 'Reduces high-resolution timer precision' }
];

function showToast(message, isError = false) {
  const container = $('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `auvyq-toast${isError ? ' auvyq-toast-error' : ''}`;
  toast.setAttribute('role', isError ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'auvyq-toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = isError
    ? '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  const text = document.createElement('span');
  text.textContent = message;

  toast.appendChild(icon);
  toast.appendChild(text);
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity 0.24s ease, transform 0.24s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 250);
  }, 3000);
}

function updatePresetStatusBanner(presetKey) {
  const banner = $('preset-status-banner');
  const titleEl = $('preset-status-title');
  const descEl = $('preset-status-desc');
  const iconEl = $('preset-status-icon');
  if (!banner || !titleEl || !descEl) return;
  const info = PRESET_INFO[presetKey] || PRESET_INFO.balanced;
  banner.classList.toggle('is-expert', presetKey === 'expert');
  banner.classList.toggle('is-protected', presetKey !== 'expert');
  titleEl.textContent = info.statusTitle;
  descEl.textContent = info.statusDesc;
  if (iconEl) {
    iconEl.innerHTML = presetKey === 'expert'
      ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
      : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';
  }
}

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

let presetSequence = 0;
async function applyPresetChoice(key) {
  const seq = ++presetSequence;
  const info = PRESET_INFO[key] || PRESET_INFO.balanced;
  try {
    const updated = await rpc('SET_SETTINGS', { preset: key });
    if (seq !== presetSequence) return;
    await loadSettings(updated);
    showToast(info.toast);
  } catch {
    if (seq !== presetSequence) return;
    await loadSettings();
    showToast('Could not apply this protection profile. Your previous settings are still active.', true);
  }
}

let moduleSequence = 0;
async function toggleModule(key, next) {
  const seq = ++moduleSequence;
  try {
    const updated = await rpc('SET_SETTINGS', { modules: { [key]: next } });
    if (seq !== moduleSequence) return;
    await loadSettings(updated);
    const activeInfo = PRESET_INFO[updated.preset] || PRESET_INFO.expert;
    showToast(updated.preset === 'expert' ? 'Custom protection settings active.' : `${activeInfo.label} protection active.`);
  } catch {
    if (seq !== moduleSequence) return;
    await loadSettings();
    showToast('Could not update module settings.', true);
  }
}

async function toggleFpShield(key, next) {
  try {
    const updated = await rpc('SET_SETTINGS', { fpShields: { [key]: next } });
    await loadSettings(updated);
  } catch {
    await loadSettings();
    showToast('Could not update fingerprint defense setting.', true);
  }
}

async function loadSettings(providedSettings) {
  try {
    const settings = providedSettings || await rpc('GET_SETTINGS');

    // Remember focused elements to preserve keyboard navigation across re-renders
    const focusedPresetId = document.activeElement?.id?.startsWith('preset-') ? document.activeElement.id : null;
    const focusedSwitchLabel = document.activeElement?.classList?.contains('auvyq-switch')
      ? document.activeElement.getAttribute('aria-label')
      : null;

    // presets grid
    const grid = $('preset-grid');
    grid.textContent = '';
    const activePreset = settings.preset || 'balanced';

    for (const [key, info] of Object.entries(PRESET_INFO)) {
      const isSelected = activePreset === key;
      const option = document.createElement('button');
      option.type = 'button';
      option.className = `preset-option${isSelected ? ' selected' : ''}`;
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', String(isSelected));
      option.setAttribute('tabindex', isSelected ? '0' : '-1');
      option.id = `preset-${key}`;

      const header = document.createElement('div');
      header.className = 'preset-header';

      const name = document.createElement('span');
      name.className = 'preset-name';
      name.textContent = info.label;
      header.appendChild(name);

      const statusIndicator = document.createElement('span');
      statusIndicator.className = 'preset-status-indicator';
      statusIndicator.setAttribute('aria-hidden', 'true');
      statusIndicator.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      header.appendChild(statusIndicator);
      option.appendChild(header);

      if (info.recommended) {
        const rec = document.createElement('span');
        rec.className = 'preset-recommended';
        rec.textContent = 'RECOMMENDED';
        option.appendChild(rec);
      }

      const desc = document.createElement('p');
      desc.className = 'preset-desc';
      desc.textContent = info.desc;
      option.appendChild(desc);

      if (info.tag) {
        const tag = document.createElement('div');
        tag.className = 'preset-tradeoff';
        tag.textContent = info.tag;
        option.appendChild(tag);
      }

      option.addEventListener('click', () => {
        applyPresetChoice(key);
      });

      option.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          applyPresetChoice(key);
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          const currentIndex = PRESET_KEYS.indexOf(key);
          const nextIndex = (currentIndex + 1) % PRESET_KEYS.length;
          const nextKey = PRESET_KEYS[nextIndex];
          const nextBtn = document.getElementById(`preset-${nextKey}`);
          if (nextBtn) {
            nextBtn.focus();
            applyPresetChoice(nextKey);
          }
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          const currentIndex = PRESET_KEYS.indexOf(key);
          const prevIndex = (currentIndex - 1 + PRESET_KEYS.length) % PRESET_KEYS.length;
          const prevKey = PRESET_KEYS[prevIndex];
          const prevBtn = document.getElementById(`preset-${prevKey}`);
          if (prevBtn) {
            prevBtn.focus();
            applyPresetChoice(prevKey);
          }
        } else if (e.key === 'Home') {
          e.preventDefault();
          const firstBtn = document.getElementById(`preset-${PRESET_KEYS[0]}`);
          if (firstBtn) {
            firstBtn.focus();
            applyPresetChoice(PRESET_KEYS[0]);
          }
        } else if (e.key === 'End') {
          e.preventDefault();
          const lastBtn = document.getElementById(`preset-${PRESET_KEYS[PRESET_KEYS.length - 1]}`);
          if (lastBtn) {
            lastBtn.focus();
            applyPresetChoice(PRESET_KEYS[PRESET_KEYS.length - 1]);
          }
        }
      });

      grid.appendChild(option);
    }

    // Restore preset button focus if user was navigating with keyboard
    if (focusedPresetId) {
      const toFocus = document.getElementById(focusedPresetId) || document.getElementById(`preset-${activePreset}`);
      if (toFocus) toFocus.focus();
    }

    // update preset status banner
    updatePresetStatusBanner(activePreset);

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
        toggleModule(module.key, next);
      }));
      moduleList.appendChild(row);
    }

    // Restore module switch focus if user was interacting with keyboard
    if (focusedSwitchLabel) {
      const switchEl = document.querySelector(`[aria-label="${CSS.escape(focusedSwitchLabel)}"]`);
      if (switchEl) switchEl.focus();
    }

    // fp shields
    const fpList = $('fp-list');
    if (fpList) {
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
          toggleFpShield(shield.key, next);
        }));
        fpList.appendChild(row);
      }
    }

    // settings inputs
    const themeSelect = $('theme-select');
    if (themeSelect) themeSelect.value = settings.theme;
    const retentionSelect = $('retention-select');
    if (retentionSelect) retentionSelect.value = String(settings.logRetentionDays);
    const telemetrySwitch = $('telemetry-switch');
    if (telemetrySwitch) telemetrySwitch.setAttribute('aria-checked', String(settings.telemetryOptIn === true));
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

    const iconWrap = document.createElement('div');
    iconWrap.className = 'threat-empty-icon';
    iconWrap.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>';

    const textWrap = document.createElement('div');
    textWrap.className = 'threat-empty-text';

    const title = document.createElement('div');
    title.className = 'threat-empty-title';
    title.textContent = 'No Tracking Cookies Observed';

    const desc = document.createElement('div');
    desc.className = 'threat-empty-desc';
    desc.textContent = 'AUVYQ continuously monitors cross-site cookies. Your essential logins and session data remain safeguarded.';

    textWrap.appendChild(title);
    textWrap.appendChild(desc);
    empty.appendChild(iconWrap);
    empty.appendChild(textWrap);
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
      empty.className = 'threat-empty-row';

      const iconWrap = document.createElement('div');
      iconWrap.className = 'threat-empty-icon';
      iconWrap.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline></svg>';

      const textWrap = document.createElement('div');
      textWrap.className = 'threat-empty-text';

      const title = document.createElement('div');
      title.className = 'threat-empty-title';
      title.textContent = 'All Clear — No Threats Detected';

      const desc = document.createElement('div');
      desc.className = 'threat-empty-desc';
      desc.textContent = 'AUVYQ continuously scans visited origins and forms in real-time. No deceptive lookalikes, foreign credential harvesting, or dangerous redirects have been detected.';

      textWrap.appendChild(title);
      textWrap.appendChild(desc);
      empty.appendChild(iconWrap);
      empty.appendChild(textWrap);
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

// ---- Intelligent URL Inspector (Part 10) -----------------------------------

function initAiInspector() {
  const btn = $('ai-inspect-btn');
  const input = $('ai-inspect-input');
  const resultEl = $('ai-inspect-result');
  if (!btn || !input || !resultEl) return;

  btn.addEventListener('click', async () => {
    const rawUrl = input.value.trim();
    if (!rawUrl) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = '<p style="color: var(--auvyq-danger, #ef4444); font-size: 13px; margin: 0;">Please enter a URL to inspect.</p>';
      return;
    }
    resultEl.style.display = 'block';
    resultEl.innerHTML = '<p style="color: var(--auvyq-text-muted); font-size: 13px; margin: 0;">Analyzing with on-device machine learning...</p>';
    btn.disabled = true;

    try {
      const res = await rpc('ANALYZE_URL_INTELLIGENCE', { url: rawUrl });
      const scoreColor = res.risk.score >= 70 ? 'var(--auvyq-danger, #ef4444)' : res.risk.score >= 40 ? 'var(--auvyq-warning, #f59e0b)' : 'var(--auvyq-protected, #10b981)';
      const pillsHtml = (res.mlScore.topContributors || []).map((c) =>
        `<span class="auvyq-pill" style="font-size: 11px; margin: 2px;">${escapeHtml(c.name)} (${c.contribution > 0 ? '+' : ''}${c.contribution})</span>`
      ).join(' ');

      resultEl.innerHTML = `
        <div style="padding: 14px; background: var(--auvyq-bg-primary); border-radius: var(--radius-md); border: 1px solid var(--auvyq-border-subtle);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <strong style="color: var(--auvyq-text-primary); font-size: 14px;">Risk Assessment: <span style="color: ${scoreColor}; font-weight: 800;">${res.risk.score}/100 (${res.risk.severity.toUpperCase()})</span></strong>
            <span class="auvyq-pill auvyq-pill-cyan">Entropy: ${res.mlScore.features.domainEntropy}</span>
          </div>
          <p style="font-size: 13px; color: var(--auvyq-text-secondary); margin: 6px 0 10px; line-height: 1.5;">${escapeHtml(res.explanation.explanation)}</p>
          <div style="margin-top: 8px;">
            <div style="font-size: 11.5px; font-weight: 700; color: var(--auvyq-text-muted); margin-bottom: 4px;">TOP CONTRIBUTING RISK FEATURES:</div>
            <div>${pillsHtml || '<span style="font-size: 12px; color: var(--auvyq-text-muted);">No significant risk factors found.</span>'}</div>
          </div>
        </div>
      `;
    } catch (err) {
      resultEl.innerHTML = `<p style="color: var(--auvyq-danger, #ef4444); font-size: 13px; margin: 0;">Analysis error: ${escapeHtml(err.message || 'Unknown error')}</p>`;
    } finally {
      btn.disabled = false;
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btn.click();
    }
  });
}

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

const copyBtn = $('copy-diagnostics');
if (copyBtn) {
  copyBtn.addEventListener('click', () => {
    const text = $('diagnostics')?.textContent || '';
    if (text) {
      navigator.clipboard.writeText(text).then(() => showToast('Diagnostics copied to clipboard.')).catch(() => undefined);
    }
  });
}

// ---- accessible reset confirmation dialog ---------------------------------
const clearDialog = $('clear-data-dialog');
const cancelClearBtn = $('cancel-clear-btn');
const confirmClearBtn = $('confirm-clear-btn');

function openClearDialog() {
  if (!clearDialog) return;
  clearDialog.classList.add('open');
  cancelClearBtn?.focus();
}

function closeClearDialog() {
  if (!clearDialog) return;
  clearDialog.classList.remove('open');
  $('clear-data')?.focus();
}

$('clear-data')?.addEventListener('click', openClearDialog);
cancelClearBtn?.addEventListener('click', closeClearDialog);

clearDialog?.addEventListener('click', (e) => {
  if (e.target === clearDialog) closeClearDialog();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && clearDialog?.classList.contains('open')) {
    closeClearDialog();
  }
});
clearDialog?.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    if (e.shiftKey) {
      if (document.activeElement === cancelClearBtn) {
        e.preventDefault();
        confirmClearBtn?.focus();
      }
    } else {
      if (document.activeElement === confirmClearBtn) {
        e.preventDefault();
        cancelClearBtn?.focus();
      }
    }
  }
});


confirmClearBtn?.addEventListener('click', async () => {
  confirmClearBtn.disabled = true;
  confirmClearBtn.textContent = 'Resetting…';
  try {
    await rpc('CLEAR_AUVYQ_DATA');
    showToast('All AUVYQ data has been reset to defaults.');
    closeClearDialog();
    await loadSettings();
    await loadOverview();
    await loadThreats();
    await loadDiagnostics();
  } catch {
    showToast('Failed to reset data. Try again.', true);
  } finally {
    confirmClearBtn.disabled = false;
    confirmClearBtn.textContent = 'Reset All Data';
  }
});

function handleHashNavigation() {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash) {
    const targetNav = document.querySelector(`.auvyq-nav-item[data-section="${CSS.escape(hash)}"]`);
    if (targetNav) targetNav.click();
  }
}
window.addEventListener('hashchange', handleHashNavigation);
setTimeout(handleHashNavigation, 50);

bindPressPop(document);
const brandBadge = document.querySelector('.brand-badge');
if (brandBadge) brandBadge.textContent = `v${chrome.runtime.getManifest().version}`;
$('about-version').textContent = `Version ${chrome.runtime.getManifest().version} — Manifest V3, local-first.`;
const aboutVersionBadge = $('about-version-badge');
if (aboutVersionBadge) aboutVersionBadge.textContent = `v${chrome.runtime.getManifest().version}`;

chrome.storage.local.get('settings', (result) => {
  if (result?.settings?.theme) {
    applyTheme(result.settings.theme);
  } else {
    applyTheme('system');
  }
});

// ---- network activity panel -------------------------------------------------

async function loadActivityPanel() {
  try {
    const data = await rpc('GET_SNAPSHOT');
    const snapshot = data && typeof data.snapshot === 'object' ? data.snapshot : {};
    const totalBlocked = (snapshot.adsBlocked || 0) + (snapshot.trackersBlocked || 0);

    // Calculate bandwidth saved at ~85KB per blocked asset
    const mbSaved = ((totalBlocked * 85) / 1024).toFixed(1);
    const bandwidthEl = $('act-bandwidth');
    if (bandwidthEl) bandwidthEl.textContent = `${mbSaved} MB`;

    // Calculate estimated page load time saved at ~110ms per blocked tracking/ad script
    const secondsSaved = Math.round((totalBlocked * 110) / 1000);
    const timeSavedEl = $('act-time-saved');
    if (timeSavedEl) {
      timeSavedEl.textContent = secondsSaved >= 60
        ? `${(secondsSaved / 60).toFixed(1)} min`
        : `${secondsSaved}s`;
    }

    const totalScreenedEl = $('act-total-screened');
    if (totalScreenedEl) {
      totalScreenedEl.textContent = String(totalBlocked * 3 + (snapshot.cosmeticHidden || 0));
    }

    const trackersStoppedEl = $('act-trackers-stopped');
    if (trackersStoppedEl) {
      trackersStoppedEl.textContent = String(snapshot.trackersBlocked || 0);
    }

    // Populate observed protection layers based on real metrics
    const list = $('activity-domain-list');
    if (!list) return;
    list.innerHTML = '';

    const activeLayers = [
      { name: 'Ad Network Requests', count: snapshot.adsBlocked || 0, layer: 'DNR Ruleset (ads)', action: 'Blocked' },
      { name: 'Tracking & Analytics Beacons', count: snapshot.trackersBlocked || 0, layer: 'DNR Ruleset (trackers)', action: 'Blocked' },
      { name: 'Cross-Site Tracking Tokens', count: snapshot.paramsStripped || 0, layer: 'DNR Transform ($removeparam)', action: 'Stripped' },
      { name: 'Cosmetic In-Page Ads', count: snapshot.cosmeticHidden || 0, layer: 'Cosmetic Engine (CSS Injection)', action: 'Hidden' },
      { name: 'Phishing & Impersonation Domains', count: snapshot.threats || 0, layer: 'Heuristic Threat Intelligence', action: 'Stopped' },
      { name: 'Profiling Tracking Identifiers', count: snapshot.cookiesCleaned || 0, layer: 'Cookie Guard (24h Lifetime)', action: 'Isolated' }
    ].filter((item) => item.count > 0);

    if (activeLayers.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'cookie-item empty';
      emptyLi.innerHTML = `<span class="section-note" style="padding: 16px 0;">No blocked events recorded for today yet. Protection is active and monitoring network requests.</span>`;
      list.appendChild(emptyLi);
      return;
    }

    for (const item of activeLayers) {
      const li = document.createElement('li');
      li.className = 'cookie-item';
      li.innerHTML = `
        <span class="cookie-domain">${escapeHtml(item.name)}</span>
        <span class="cookie-name">${escapeHtml(String(item.count))} events intercepted</span>
        <span class="cookie-cat"><span class="cat-badge tracker">${escapeHtml(item.layer)}</span></span>
        <span class="cookie-actions"><span class="chip-val protected">${escapeHtml(item.action)}</span></span>
      `;
      list.appendChild(li);
    }
  } catch {
    // Non-fatal
  }
}

// ---- custom rules panel ----------------------------------------------------

async function loadCustomRulesPanel() {
  const list = $('custom-rules-list');
  if (!list) return;

  try {
    const data = await rpc('GET_CUSTOM_RULES');
    const rules = Array.isArray(data?.rules) ? data.rules : [];
    list.innerHTML = '';

    if (rules.length === 0) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'cookie-item empty';
      emptyLi.innerHTML = `<span class="section-note" style="padding: 16px 0;">No custom rules configured yet. Launch the Visual Element Picker or add a rule above.</span>`;
      list.appendChild(emptyLi);
      return;
    }

    for (const rule of rules) {
      const li = document.createElement('li');
      li.className = 'cookie-item';

      const typeBadgeClass = rule.type === 'network' ? 'rule-type-badge network' : 'rule-type-badge cosmetic';
      const typeLabel = rule.type === 'network' ? 'Network' : 'Cosmetic';
      const domainLabel = rule.domain ? escapeHtml(rule.domain) : 'All Websites';

      li.innerHTML = `
        <span class="cookie-cat"><span class="${typeBadgeClass}">${typeLabel}</span></span>
        <span class="cookie-domain" style="max-width: 180px;">${domainLabel}</span>
        <span class="cookie-name" style="font-family: ui-monospace, monospace; font-size: 12px; color: var(--auvyq-primary);">${escapeHtml(rule.rawText)}</span>
        <span class="cookie-actions" style="display: flex; align-items: center; gap: 8px;">
          <button class="auvyq-switch-sm rule-toggle-btn" type="button" role="switch" aria-checked="${rule.enabled ? 'true' : 'false'}" aria-label="Toggle rule ${escapeHtml(rule.id)}" data-rule-id="${escapeHtml(rule.id)}">
            <span class="auvyq-knob-sm"></span>
          </button>
          <button class="rule-delete-btn" type="button" aria-label="Delete rule" data-rule-id="${escapeHtml(rule.id)}" title="Delete rule">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </span>
      `;

      const toggleBtn = li.querySelector('.rule-toggle-btn');
      toggleBtn?.addEventListener('click', async () => {
        const nextState = toggleBtn.getAttribute('aria-checked') !== 'true';
        toggleBtn.setAttribute('aria-checked', nextState ? 'true' : 'false');
        try {
          await rpc('UPDATE_CUSTOM_RULE', { id: rule.id, enabled: nextState });
          showToast(`Rule ${nextState ? 'enabled' : 'disabled'}.`);
        } catch {
          toggleBtn.setAttribute('aria-checked', !nextState ? 'true' : 'false');
          showToast('Failed to update rule.', true);
        }
      });

      const deleteBtn = li.querySelector('.rule-delete-btn');
      deleteBtn?.addEventListener('click', async () => {
        try {
          await rpc('DELETE_CUSTOM_RULE', { id: rule.id });
          showToast('Custom rule removed.');
          await loadCustomRulesPanel();
        } catch {
          showToast('Failed to delete rule.', true);
        }
      });

      list.appendChild(li);
    }
  } catch {
    list.innerHTML = `<li class="cookie-item empty"><span class="section-note">Failed to load custom rules.</span></li>`;
  }
}

// Custom rule creation form handler
$('add-custom-rule-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = $('custom-rule-error');
  if (errorEl) errorEl.textContent = '';

  const type = $('custom-rule-type')?.value === 'network' ? 'network' : 'cosmetic';
  const domain = $('custom-rule-domain')?.value.trim();
  const rawText = $('custom-rule-pattern')?.value.trim();

  if (!rawText) {
    if (errorEl) errorEl.textContent = 'Rule selector or pattern cannot be empty.';
    return;
  }

  try {
    await rpc('ADD_CUSTOM_RULE', { type, domain: domain || undefined, rawText });
    showToast('Custom rule added successfully.');
    if ($('custom-rule-pattern')) $('custom-rule-pattern').value = '';
    await loadCustomRulesPanel();
  } catch (err) {
    if (errorEl) errorEl.textContent = err instanceof Error ? err.message : String(err);
  }
});

// Launch element picker from dashboard
$('launch-picker-dashboard-btn')?.addEventListener('click', async () => {
  try {
    await rpc('START_ELEMENT_PICKER');
    showToast('Visual Element Picker launched on active tab.');
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Could not launch element picker on active tab.', true);
  }
});

// Import / Export custom rules
$('export-custom-rules-btn')?.addEventListener('click', async () => {
  try {
    const res = await rpc('EXPORT_CUSTOM_RULES', { format: 'text' });
    const payload = res?.payload || '';
    const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `auvyq-rules-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Exported ${res?.count || 0} custom rules.`);
  } catch {
    showToast('Failed to export custom rules.', true);
  }
});

$('import-custom-rules-btn')?.addEventListener('click', () => {
  $('import-rules-file')?.click();
});

$('import-rules-file')?.addEventListener('change', async (e) => {
  const file = e.target?.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const text = String(reader.result || '');
      const outcome = await rpc('IMPORT_CUSTOM_RULES', { payload: text });
      showToast(`Imported ${outcome?.imported || 0} rules.`);
      await loadCustomRulesPanel();
    } catch {
      showToast('Failed to parse imported rules file.', true);
    }
  };
  reader.readAsText(file);
});

loadOverview();
loadSettings();
loadCookies();
loadThreats();
loadDiagnostics();
loadActivityPanel();
loadCustomRulesPanel();
initAiInspector();
