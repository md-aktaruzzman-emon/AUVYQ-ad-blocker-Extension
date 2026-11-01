/*
 * AUVYQ Threat Warning Experience — ISOLATED world, document_idle.
 * Shadow DOM with z-index 2147483647.
 * Actions:
 *   - Leave Site (primary / recommended)
 *   - Block This Site (installs DNR session block rule)
 *   - Options & Details (inspect signals, report false positive, session bypass, permanent allowlist)
 * All DOM construction uses createElement/textContent; untrusted strings never touch HTML parsing.
 * Closed Shadow DOM prevents host page style interference or script inspection.
 */
(() => {
  const BANNER_GUARD = '__banner_guard_init__';
  if (Object.prototype.hasOwnProperty.call(window, BANNER_GUARD)) return;
  try {
    Object.defineProperty(window, BANNER_GUARD, { value: 1, writable: false, enumerable: false, configurable: false });
  } catch {
    // non-fatal
  }

  let requestCounter = 0;
  function nextRequestId() {
    requestCounter += 1;
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : String(Math.random());
    return `bn-${random.slice(0, 24)}-${requestCounter}`;
  }

  function rpc(type, payload) {
    return chrome.runtime.sendMessage({ v: 1, type, requestId: nextRequestId(), payload })
      .then((response) => {
        if (response === undefined) throw new Error('no response');
        if (response.success !== true) throw new Error(response.error || 'rpc failed');
        return response.data;
      });
  }

  function safeText(value, maxLen) {
    return typeof value === 'string' ? value.slice(0, maxLen) : '';
  }

  const SHADOW_CSS = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '.banner{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0F172A;color:#F8FAFC;border-bottom:3px solid #EF4444;box-shadow:0 16px 48px rgba(0,0,0,.7);transform:translateY(-100%);transition:transform 240ms cubic-bezier(0.22,1,0.36,1);padding:18px 24px;display:flex;flex-direction:column;gap:12px}',
    '.banner.heuristic{border-bottom-color:#F59E0B}',
    '.banner.visible{transform:translateY(0)}',
    '.row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
    '.shield{width:28px;height:28px;flex:0 0 auto}',
    '.title{font-size:16px;font-weight:700;color:#F8FAFC;letter-spacing:-0.01em}',
    '.badge{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#EF4444;background:rgba(239,68,68,.14);border:1px solid rgba(239,68,68,.3);border-radius:999px;padding:3px 10px}',
    '.badge.heuristic{color:#F59E0B;background:rgba(245,158,11,.14);border-color:rgba(245,158,11,.3)}',
    '.host{font-size:12px;color:#94A3B8;font-family:ui-monospace,SFMono-Regular,monospace;background:rgba(255,255,255,.05);padding:3px 8px;border-radius:6px;display:inline-block;max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.reasons-list{display:flex;flex-direction:column;gap:4px;font-size:13px;color:#CBD5E1;line-height:1.45;max-width:760px}',
    '.reason-item{display:flex;align-items:flex-start;gap:6px}',
    '.reason-bullet{color:#EF4444;font-weight:700}',
    '.reason-bullet.heuristic{color:#F59E0B}',
    '.meta-notice{font-size:11px;color:#64748B;line-height:1.4}',
    '.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:2px}',
    'button{border-radius:8px;border:1px solid transparent;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:transform 120ms ease,background-color 160ms ease,border-color 160ms ease}',
    'button:active{transform:scale(.97)}',
    'button:focus-visible{outline:2px solid #6366F1;outline-offset:2px}',
    '.leave{background:linear-gradient(135deg,#6366F1,#4F46E5);color:#fff;box-shadow:0 4px 14px rgba(99,102,241,.35)}',
    '.leave:hover{background:linear-gradient(135deg,#818CF8,#6366F1)}',
    '.block{background:#1E293B;color:#F8FAFC;border:1px solid rgba(255,255,255,.12)}',
    '.block:hover{background:#334155}',
    '.options-btn{background:transparent;color:#94A3B8;border:1px solid rgba(255,255,255,.1)}',
    '.options-btn:hover{color:#F8FAFC;background:rgba(255,255,255,.05);border-color:rgba(255,255,255,.2)}',
    '.warning-note{font-size:12px;color:#F59E0B;min-height:16px}',
    '.banner.shake{animation:auvyq-shake 420ms cubic-bezier(0.4,0,0.2,1)}',
    '@keyframes auvyq-shake{0%{transform:translateY(0) translateX(-2px)}20%{transform:translateY(0) translateX(4px)}40%{transform:translateY(0) translateX(-6px)}60%{transform:translateY(0) translateX(6px)}80%{transform:translateY(0) translateX(0)}}',
    '.modal{position:fixed;inset:0;z-index:2147483647;background:rgba(7,11,20,.85);backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center}',
    '.modal-card{background:#111827;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:24px;max-width:480px;width:calc(100% - 32px);display:flex;flex-direction:column;gap:14px;box-shadow:0 24px 60px rgba(0,0,0,.75)}',
    '.modal-title{font-size:17px;font-weight:700;color:#F8FAFC}',
    '.modal-text{font-size:13px;color:#94A3B8;line-height:1.55}',
    '.modal-section{background:#0F172A;border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}',
    '.modal-section-title{font-size:12px;font-weight:700;color:#E2E8F0;text-transform:uppercase;letter-spacing:0.04em}',
    '.signal-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:#CBD5E1;background:rgba(255,255,255,.04);padding:4px 8px;border-radius:6px}',
    '.modal-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:flex-end;margin-top:4px}',
    'input{background:#070B14;border:1px solid rgba(255,255,255,.14);border-radius:8px;color:#F8FAFC;padding:10px 14px;font-size:14px;width:100%}',
    'input:focus-visible{outline:2px solid #6366F1;outline-offset:2px}',
    '.danger{background:linear-gradient(135deg,#EF4444,#DC2626);color:#fff;box-shadow:0 4px 14px rgba(220,38,38,.35)}',
    '.ghost{background:transparent;color:#94A3B8;border:1px solid rgba(255,255,255,.1)}',
    '.ghost:hover{color:#F8FAFC;background:rgba(255,255,255,.05)}',
    '.secondary-btn{background:#1E293B;color:#CBD5E1;border:1px solid rgba(255,255,255,.1)}',
    '.secondary-btn:hover{background:#334155;color:#fff}',
    '@media (prefers-reduced-motion: reduce){.banner{transition-duration:.01ms}.banner.shake{animation-duration:.01ms}}'
  ].join('\n');

  function buildShieldSvg(document_) {
    const svg = document_.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 512 512');
    svg.setAttribute('class', 'shield');
    const path = document_.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', '#5B4BFF');
    path.setAttribute('fill-rule', 'evenodd');
    path.setAttribute('d', 'M 453.1 240.6 A 197.1 197.1 0 1 0 58.9 240.6 A 197.1 197.1 0 1 0 453.1 240.6 Z M 266.3 84.1 L 384 323 L 152 295 Z M 73.9 205.1 C 195.7 353.7 275.7 378.6 401.9 311.6 A 197.1 197.1 0 1 0 73.9 205.1 Z M 279 377 A 24 24 0 1 0 231 377 A 24 24 0 1 0 279 377 Z');
    svg.appendChild(path);
    return svg;
  }

  let bannerHost = null;

  function removeBanner() {
    if (bannerHost !== null && bannerHost.isConnected) bannerHost.remove();
    bannerHost = null;
  }

  function shake(banner) {
    banner.classList.remove('shake');
    void banner.offsetWidth;
    banner.classList.add('shake');
  }

  function showBanner(risk, host) {
    removeBanner();
    if (document.documentElement === null) return;

    bannerHost = document.createElement('div');
    const shadow = bannerHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadow.appendChild(style);

    const isConfirmed = risk.threatType === 'confirmed' || safeText(risk.severity, 12) === 'malicious';
    const banner = document.createElement('div');
    banner.setAttribute('role', 'alertdialog');
    banner.setAttribute('aria-live', 'assertive');
    banner.setAttribute('aria-label', isConfirmed ? 'Confirmed threat warning' : 'Suspicious website warning');
    banner.className = `banner ${isConfirmed ? 'confirmed' : 'heuristic'}`;

    // Header Row
    const row = document.createElement('div');
    row.className = 'row';
    row.appendChild(buildShieldSvg(document));

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = isConfirmed ? 'Confirmed Malicious Website' : 'Suspicious Website Detected';
    row.appendChild(title);

    const badge = document.createElement('span');
    badge.className = `badge ${isConfirmed ? 'confirmed' : 'heuristic'}`;
    badge.textContent = isConfirmed ? 'CONFIRMED THREAT' : 'HEURISTIC WARNING';
    row.appendChild(badge);

    const hostLine = document.createElement('span');
    hostLine.className = 'host';
    hostLine.textContent = safeText(host, 253);
    row.appendChild(hostLine);

    banner.appendChild(row);

    // Reasons List
    const reasonsContainer = document.createElement('div');
    reasonsContainer.className = 'reasons-list';
    const reasonList = Array.isArray(risk.reasons) ? risk.reasons.slice(0, 3) : [];
    if (reasonList.length > 0) {
      for (const r of reasonList) {
        const item = document.createElement('div');
        item.className = 'reason-item';
        const bullet = document.createElement('span');
        bullet.className = `reason-bullet ${isConfirmed ? 'confirmed' : 'heuristic'}`;
        bullet.textContent = '•';
        const text = document.createElement('span');
        text.textContent = safeText(r, 200);
        item.appendChild(bullet);
        item.appendChild(text);
        reasonsContainer.appendChild(item);
      }
    } else {
      const item = document.createElement('div');
      item.className = 'reason-item';
      const text = document.createElement('span');
      text.textContent = 'This website matches patterns commonly associated with credential phishing.';
      item.appendChild(text);
      reasonsContainer.appendChild(item);
    }
    banner.appendChild(reasonsContainer);

    // Metadata notice
    const metaNotice = document.createElement('div');
    metaNotice.className = 'meta-notice';
    metaNotice.textContent = 'AUVYQ analyzed this website locally on your device. Zero browsing data was sent to remote servers.';
    banner.appendChild(metaNotice);

    // Warning Note
    const note = document.createElement('div');
    note.className = 'warning-note';
    note.setAttribute('aria-live', 'polite');
    banner.appendChild(note);

    // Actions Row
    const actions = document.createElement('div');
    actions.className = 'actions';

    const leave = document.createElement('button');
    leave.className = 'leave';
    leave.textContent = 'Leave site (Recommended)';
    leave.addEventListener('click', () => {
      rpc('THREAT_ACTION', { action: 'leave' }).catch(() => undefined);
      window.location.href = 'about:blank';
    });

    const block = document.createElement('button');
    block.className = 'block';
    block.textContent = 'Block this site';
    block.addEventListener('click', () => {
      rpc('THREAT_ACTION', { action: 'block' }).catch(() => undefined);
      note.textContent = 'Site permanently blocked. Reloading to leave...';
      block.disabled = true;
      setTimeout(() => { window.location.href = 'about:blank'; }, 500);
    });

    const optionsBtn = document.createElement('button');
    optionsBtn.className = 'options-btn';
    optionsBtn.textContent = 'Details & Options';
    optionsBtn.addEventListener('click', () => {
      showDetailsModal(shadow, banner, risk, host, note);
    });

    actions.appendChild(leave);
    actions.appendChild(block);
    actions.appendChild(optionsBtn);
    banner.appendChild(actions);

    shadow.appendChild(banner);
    document.documentElement.appendChild(bannerHost);
    requestAnimationFrame(() => banner.classList.add('visible'));
    leave.focus();
  }

  function showDetailsModal(shadow, banner, risk, host, bannerNote) {
    const isConfirmed = risk.threatType === 'confirmed' || safeText(risk.severity, 12) === 'malicious';
    const modal = document.createElement('div');
    modal.className = 'modal';

    const card = document.createElement('div');
    card.className = 'modal-card';

    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Website Security Details';
    card.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'modal-text';
    desc.textContent = isConfirmed
      ? 'This domain is flagged in verified threat intelligence feeds for distributing malware or hosting credential harvesting forms.'
      : 'This site exhibits multiple suspicious patterns (such as brand impersonation, deceptive structure, or non-matching form targets) that frequently indicate phishing.';
    card.appendChild(desc);

    // Signals Section
    const section = document.createElement('div');
    section.className = 'modal-section';
    const sectionTitle = document.createElement('div');
    sectionTitle.className = 'modal-section-title';
    sectionTitle.textContent = 'Detection Signals';
    section.appendChild(sectionTitle);

    const reasonList = Array.isArray(risk.reasons) ? risk.reasons : ['Suspicious domain patterns'];
    for (const r of reasonList) {
      const pill = document.createElement('div');
      pill.className = 'signal-pill';
      pill.textContent = `⚠️ ${safeText(r, 160)}`;
      section.appendChild(pill);
    }
    card.appendChild(section);

    // Modal Actions
    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    const reportBtn = document.createElement('button');
    reportBtn.className = 'ghost';
    reportBtn.textContent = 'Report False Positive';
    reportBtn.addEventListener('click', () => {
      rpc('THREAT_ACTION', { action: 'report_false_positive' }).catch(() => undefined);
      reportBtn.textContent = 'Reported! Bypassing...';
      reportBtn.disabled = true;
      setTimeout(() => {
        modal.remove();
        removeBanner();
      }, 700);
    });

    const allowlistBtn = document.createElement('button');
    allowlistBtn.className = 'ghost';
    allowlistBtn.textContent = 'Always Allow Domain';
    allowlistBtn.addEventListener('click', () => {
      rpc('THREAT_ACTION', { action: 'allowlist' }).catch(() => undefined);
      modal.remove();
      removeBanner();
    });

    const continueBtn = document.createElement('button');
    continueBtn.className = isConfirmed ? 'danger' : 'secondary-btn';
    continueBtn.textContent = 'Continue for this session';
    continueBtn.addEventListener('click', () => {
      if (isConfirmed) {
        modal.remove();
        showTypedConfirmation(shadow, banner, bannerNote);
        return;
      }
      rpc('THREAT_ACTION', { action: 'continue' }).catch(() => undefined);
      modal.remove();
      removeBanner();
    });

    const backBtn = document.createElement('button');
    backBtn.className = 'secondary-btn';
    backBtn.textContent = 'Go back';
    backBtn.addEventListener('click', () => modal.remove());

    actions.appendChild(reportBtn);
    actions.appendChild(allowlistBtn);
    actions.appendChild(continueBtn);
    actions.appendChild(backBtn);
    card.appendChild(actions);

    modal.appendChild(card);
    shadow.appendChild(modal);
    backBtn.focus();
  }

  function showTypedConfirmation(shadow, banner, note) {
    shake(banner);
    note.textContent = 'Confirmed malicious threat. Type CONTINUE to proceed at your own risk.';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Dangerous Website Warning';
    const text = document.createElement('div');
    text.className = 'modal-text';
    text.textContent = 'This website strongly matches active cyber threat campaigns. To proceed anyway for this session, type CONTINUE in capital letters below.';
    const input = document.createElement('input');
    input.setAttribute('type', 'text');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', 'Type CONTINUE to confirm');
    const row = document.createElement('div');
    row.className = 'modal-actions';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'Go back';
    const confirm = document.createElement('button');
    confirm.className = 'danger';
    confirm.textContent = 'Continue';
    confirm.disabled = true;
    input.addEventListener('input', () => {
      confirm.disabled = input.value !== 'CONTINUE';
    });
    confirm.addEventListener('click', () => {
      if (input.value !== 'CONTINUE') return;
      rpc('THREAT_ACTION', { action: 'continue' }).catch(() => undefined);
      modal.remove();
      removeBanner();
    });
    cancel.addEventListener('click', () => modal.remove());
    row.appendChild(cancel);
    row.appendChild(confirm);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(input);
    card.appendChild(row);
    modal.appendChild(card);
    shadow.appendChild(modal);
    input.focus();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (typeof message !== 'object' || message === null) return;
    if (message.type !== 'AUVYQ_SHOW_THREAT') return;
    const risk = message.risk;
    if (typeof risk !== 'object' || risk === null) return;
    const severity = safeText(risk.severity, 12);
    if (severity !== 'medium' && severity !== 'high' && severity !== 'malicious') return;
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => showBanner(risk, safeText(message.host, 253)), { once: true });
      return;
    }
    showBanner(risk, safeText(message.host, 253));
  });

  function checkInitialThreatState() {
    rpc('GET_TAB_STATE', {}).then((data) => {
      if (!data || !data.state) return;
      const { host, risk, stage } = data.state;
      if (!risk || stage === 'confirmed' || stage === 'acknowledged') return;
      const severity = safeText(risk.severity, 12);
      if (severity === 'medium' || severity === 'high' || severity === 'malicious') {
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', () => showBanner(risk, safeText(host, 253)), { once: true });
        } else {
          showBanner(risk, safeText(host, 253));
        }
      }
    }).catch(() => undefined);
  }

  checkInitialThreatState();
})();
