/*
 * AUVYQ onboarding: transparency -> preset -> telemetry.
 * The logo reveal runs once (320ms). Telemetry starts unchecked.
 */
let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `ob-${Date.now()}-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`;
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

const PRESETS = [
  { key: 'basic', label: 'Basic', desc: 'Blocks ads only. Maximum site compatibility.', recommended: false },
  { key: 'balanced', label: 'Balanced', desc: 'Ads, trackers, cookie cleanup and threat warnings.', recommended: true },
  { key: 'strong', label: 'Strong', desc: 'Stricter heuristic threat detection.', recommended: false },
  { key: 'maximum', label: 'Maximum', desc: 'Adds optional fingerprint shields.', recommended: false },
  { key: 'expert', label: 'Expert', desc: 'Full manual control with developer diagnostics.', recommended: false }
];

let selectedPreset = 'balanced';

function showStep(number) {
  document.querySelectorAll('.step').forEach((step) => step.classList.remove('active'));
  const step = document.getElementById(`step-${number}`);
  if (step !== null) step.classList.add('active');
  document.querySelectorAll('.progress .dot').forEach((dot, index) => {
    dot.classList.toggle('active', index === number - 1);
  });
}

document.querySelectorAll('[data-next]').forEach((button) => {
  button.addEventListener('click', () => showStep(Number(button.dataset.next)));
});

const PRESET_ICONS = {
  basic: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  balanced: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  strong: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
  maximum: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
  expert: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>'
};

// Preset list
const list = document.getElementById('preset-list');
for (const preset of PRESETS) {
  const isSelected = preset.key === 'balanced';
  const option = document.createElement('button');
  option.className = `preset-option${isSelected ? ' selected' : ''}`;
  option.setAttribute('role', 'radio');
  option.setAttribute('aria-checked', String(isSelected));
  option.dataset.preset = preset.key;

  // Icon wrap
  const iconWrap = document.createElement('div');
  iconWrap.className = `preset-icon-wrap preset-icon-${preset.key}`;
  iconWrap.innerHTML = PRESET_ICONS[preset.key] || PRESET_ICONS.balanced;
  option.appendChild(iconWrap);

  // Content body
  const content = document.createElement('div');
  content.className = 'preset-content';

  const titleRow = document.createElement('div');
  titleRow.className = 'preset-title-row';

  const name = document.createElement('span');
  name.className = 'preset-name';
  name.textContent = preset.label;
  titleRow.appendChild(name);

  if (preset.recommended) {
    const rec = document.createElement('span');
    rec.className = 'preset-badge-recommended';
    rec.innerHTML = '<span class="badge-dot"></span>Recommended';
    titleRow.appendChild(rec);
  }
  content.appendChild(titleRow);

  const desc = document.createElement('span');
  desc.className = 'preset-desc';
  desc.textContent = preset.desc;
  content.appendChild(desc);
  option.appendChild(content);

  // Radio indicator
  const radio = document.createElement('div');
  radio.className = 'preset-radio-indicator';
  radio.innerHTML = '<span class="preset-radio-inner"></span>';
  option.appendChild(radio);

  option.addEventListener('click', () => {
    selectedPreset = preset.key;
    document.querySelectorAll('.preset-option').forEach((el) => {
      el.classList.remove('selected');
      el.setAttribute('aria-checked', 'false');
    });
    option.classList.add('selected');
    option.setAttribute('aria-checked', 'true');
  });
  list.appendChild(option);
}

// Telemetry switch (default OFF; the switch itself is the source of truth)
const telemetrySwitch = document.getElementById('telemetry-switch');
const telemetryLabel = document.getElementById('telemetry-status-label');

function updateTelemetryUi(active) {
  telemetrySwitch.setAttribute('aria-checked', String(active));
  if (telemetryLabel) {
    if (active) {
      telemetryLabel.textContent = 'Enabled (Sharing anonymous counts)';
      telemetryLabel.classList.add('status-enabled');
    } else {
      telemetryLabel.textContent = 'Currently Disabled (Recommended)';
      telemetryLabel.classList.remove('status-enabled');
    }
  }
}

telemetrySwitch.addEventListener('click', () => {
  const next = telemetrySwitch.getAttribute('aria-checked') !== 'true';
  updateTelemetryUi(next);
});
telemetrySwitch.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    telemetrySwitch.click();
  }
});

// Finish: apply preset + telemetry choice, mark onboarding done, open a new tab.
document.getElementById('finish').addEventListener('click', async () => {
  const telemetryOptIn = telemetrySwitch.getAttribute('aria-checked') === 'true';
  try {
    await rpc('SET_SETTINGS', { preset: selectedPreset, telemetryOptIn });
  } catch {
    // protection still works with defaults if this fails
  }
  try {
    await chrome.runtime.sendMessage({
      v: 1,
      type: 'SET_ONBOARDING_DONE',
      requestId: nextRequestId(),
      payload: { done: true }
    });
  } catch {
    // non-fatal
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard/dashboard.html') });
  window.close();
});

// One-time logo reveal (320ms), fired after first paint.
requestAnimationFrame(() => {
  const logo = document.getElementById('reveal-logo');
  if (logo !== null) logo.classList.add('auvyq-logo-reveal');
});
