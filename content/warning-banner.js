/*
 * AUVYQ threat warning banner — ISOLATED world, document_idle.
 * Shadow DOM with z-index 2147483647. Entrance: translateY(-100%) -> 0, 240ms.
 * Actions: Leave Site (primary) / Block / Continue Anyway with danger escalation:
 *   first Continue attempt  -> shake + red emphasis + plain-language explanation
 *   second attempt          -> confirmation modal
 *   malicious severity      -> typed confirmation ("CONTINUE")
 * All DOM construction uses createElement/textContent; untrusted strings never
 * touch HTML parsing. Untrusted display text (host, reasons) is truncated and
 * passed through textContent only.
 */
(() => {
  if (window.__auvyqBannerActive === true) return;
  window.__auvyqBannerActive = true;

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
    '.banner{position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1E293B;color:#F1F5F9;border-bottom:3px solid #EF4444;box-shadow:0 16px 40px rgba(0,0,0,.45);transform:translateY(-100%);transition:transform 240ms cubic-bezier(0.22,1,0.36,1);padding:16px 20px;display:flex;flex-direction:column;gap:10px}',
    '.banner.visible{transform:translateY(0)}',
    '.row{display:flex;align-items:center;gap:12px}',
    '.shield{width:28px;height:28px;flex:0 0 auto}',
    '.title{font-size:15px;font-weight:700}',
    '.severity{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#EF4444;background:rgba(239,68,68,.12);border-radius:999px;padding:3px 10px}',
    '.severity.medium{color:#F59E0B;background:rgba(245,158,11,.12)}',
    '.reasons{font-size:13px;color:#94A3B8;line-height:1.5;max-width:640px}',
    '.host{font-size:12px;color:#64748B}',
    '.actions{display:flex;gap:10px;flex-wrap:wrap}',
    'button{border-radius:10px;border:1px solid transparent;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer;transition:transform 120ms cubic-bezier(0.34,1.56,0.64,1),background-color 200ms cubic-bezier(0.4,0,0.2,1)}',
    'button:active{transform:scale(.96)}',
    'button:focus-visible{outline:2px solid #3B82F6;outline-offset:2px}',
    '.leave{background:linear-gradient(135deg,#2563EB,#3B82F6);color:#fff}',
    '.block{background:#273449;color:#F1F5F9;border-color:#334155}',
    '.continue{background:transparent;color:#94A3B8;border-color:#334155}',
    '.warning-note{font-size:12px;color:#F59E0B;min-height:16px}',
    '.banner.shake{animation:auvyq-shake 420ms cubic-bezier(0.4,0,0.2,1)}',
    '@keyframes auvyq-shake{0%{transform:translateY(0) translateX(-2px)}20%{transform:translateY(0) translateX(4px)}40%{transform:translateY(0) translateX(-6px)}60%{transform:translateY(0) translateX(6px)}80%{transform:translateY(0) translateX(0)}}',
    '.modal{position:fixed;inset:0;z-index:2147483647;background:rgba(11,17,32,.80);display:flex;align-items:center;justify-content:center}',
    '.modal-card{background:#1E293B;border:1px solid #334155;border-radius:14px;padding:24px;max-width:420px;width:calc(100% - 40px);display:flex;flex-direction:column;gap:14px}',
    '.modal-title{font-size:16px;font-weight:700;color:#F1F5F9}',
    '.modal-text{font-size:13px;color:#94A3B8;line-height:1.5}',
    'input{background:#0B1120;border:1px solid #334155;border-radius:10px;color:#F1F5F9;padding:10px 12px;font-size:14px}',
    'input:focus-visible{outline:2px solid #3B82F6;outline-offset:2px}',
    '.danger{background:#EF4444;color:#fff}',
    '.ghost{background:transparent;color:#B8B5D0;border-color:#3B326D}',
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
  let continueAttempts = 0;

  function removeBanner() {
    if (bannerHost !== null && bannerHost.isConnected) bannerHost.remove();
    bannerHost = null;
    continueAttempts = 0;
  }

  function shake(banner) {
    banner.classList.remove('shake');
    void banner.offsetWidth; // restart the animation
    banner.classList.add('shake');
  }

  function showBanner(risk, host) {
    removeBanner();
    if (document.documentElement === null) return;

    bannerHost = document.createElement('div');
    bannerHost.setAttribute('data-auvyq', 'warning-banner');
    const shadow = bannerHost.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    shadow.appendChild(style);

    const banner = document.createElement('div');
    banner.setAttribute('role', 'alertdialog');
    banner.setAttribute('aria-live', 'assertive');
    banner.setAttribute('aria-label', 'AUVYQ threat warning');
    banner.className = 'banner';

    const row = document.createElement('div');
    row.className = 'row';
    row.appendChild(buildShieldSvg(shadow));
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = 'Potential threat detected';
    row.appendChild(title);
    const severity = document.createElement('span');
    severity.className = `severity ${safeText(risk.severity, 12)}`;
    severity.textContent = safeText(risk.severity, 12) === 'malicious' ? 'Malicious' : safeText(risk.severity, 12) === 'high' ? 'High risk' : 'Medium risk';
    row.appendChild(severity);
    banner.appendChild(row);

    const hostLine = document.createElement('div');
    hostLine.className = 'host';
    hostLine.textContent = safeText(host, 253);
    banner.appendChild(hostLine);

    const reasons = document.createElement('div');
    reasons.className = 'reasons';
    const reasonList = Array.isArray(risk.reasons) ? risk.reasons.slice(0, 4) : [];
    reasons.textContent = reasonList.length > 0
      ? reasonList.map((r) => safeText(r, 200)).join(' ')
      : 'This site behaves like a known scam pattern.';
    banner.appendChild(reasons);

    const note = document.createElement('div');
    note.className = 'warning-note';
    note.setAttribute('aria-live', 'polite');
    banner.appendChild(note);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const leave = document.createElement('button');
    leave.className = 'leave';
    leave.textContent = 'Leave site';
    leave.addEventListener('click', () => {
      rpc('THREAT_ACTION', { action: 'leave' }).catch(() => undefined);
      window.location.href = 'about:blank';
    });

    const block = document.createElement('button');
    block.className = 'block';
    block.textContent = 'Block this site';
    block.addEventListener('click', () => {
      rpc('THREAT_ACTION', { action: 'block' }).catch(() => undefined);
      note.textContent = 'Site blocked. Reload to leave this page.';
      block.disabled = true;
    });

    const cont = document.createElement('button');
    cont.className = 'continue';
    cont.textContent = 'Continue anyway';
    cont.addEventListener('click', () => {
      continueAttempts += 1;
      if (safeText(risk.severity, 12) === 'malicious') {
        showTypedConfirmation(shadow, banner, note);
        return;
      }
      if (continueAttempts === 1) {
        shake(banner);
        note.textContent = 'This page may be dangerous. Continuing is not recommended — click again to confirm.';
        return;
      }
      showConfirmation(shadow, note, () => {
        rpc('THREAT_ACTION', { action: 'continue' }).catch(() => undefined);
        removeBanner();
      });
    });

    actions.appendChild(leave);
    actions.appendChild(block);
    actions.appendChild(cont);
    banner.appendChild(actions);

    shadow.appendChild(banner);
    document.documentElement.appendChild(bannerHost);
    requestAnimationFrame(() => banner.classList.add('visible'));
    leave.focus();
  }

  function showConfirmation(shadow, note, onConfirm) {
    note.textContent = '';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Are you sure?';
    const text = document.createElement('div');
    text.className = 'modal-text';
    text.textContent = 'AUVYQ believes this site is suspicious. Your password or personal data could be at risk if you continue.';
    const row = document.createElement('div');
    row.className = 'actions';
    const cancel = document.createElement('button');
    cancel.className = 'ghost';
    cancel.textContent = 'Go back';
    const confirm = document.createElement('button');
    confirm.className = 'danger';
    confirm.textContent = 'Continue anyway';
    confirm.addEventListener('click', onConfirm);
    cancel.addEventListener('click', () => modal.remove());
    row.appendChild(cancel);
    row.appendChild(confirm);
    card.appendChild(title);
    card.appendChild(text);
    card.appendChild(row);
    modal.appendChild(card);
    shadow.appendChild(modal);
    cancel.focus();
  }

  function showTypedConfirmation(shadow, banner, note) {
    shake(banner);
    note.textContent = 'This site looks malicious. Type CONTINUE to proceed at your own risk.';
    const modal = document.createElement('div');
    modal.className = 'modal';
    const card = document.createElement('div');
    card.className = 'modal-card';
    const title = document.createElement('div');
    title.className = 'modal-title';
    title.textContent = 'Malicious site';
    const text = document.createElement('div');
    text.className = 'modal-text';
    text.textContent = 'This site strongly matches malicious patterns. To continue anyway, type CONTINUE in capital letters.';
    const input = document.createElement('input');
    input.setAttribute('type', 'text');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('aria-label', 'Type CONTINUE to confirm');
    const row = document.createElement('div');
    row.className = 'actions';
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
})();
