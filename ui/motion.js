/*
 * AUVYQ motion JavaScript API.
 * pop, bounce, sweep, shake, stagger, countUp, animateShieldState.
 * All animations are cancelable, leak no timers, retain no detached DOM,
 * honor prefers-reduced-motion, and terminate. A shared rAF scheduler drives
 * countUp; CSS classes drive the one-shot keyframe effects.
 */

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Cancels any in-flight animation bookkeeping for an element. */
const registry = new WeakMap();

function setController(el, controller) {
  const existing = registry.get(el);
  if (existing !== undefined) existing.cancel();
  registry.set(el, controller);
}

function classOnce(el, className, durationMs, onDone) {
  let timer = null;
  const controller = {
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      el.classList.remove(className);
    }
  };
  setController(el, controller);
  el.classList.remove(className);
  void el.offsetWidth; // restart keyframes if the class was already applied
  el.classList.add(className);
  if (reducedMotion()) {
    controller.cancel();
    if (onDone) onDone();
    return controller;
  }
  timer = setTimeout(() => {
    timer = null;
    el.classList.remove(className);
    if (el.isConnected) {
      if (onDone) onDone();
    }
  }, durationMs);
  return controller;
}

/** Animation 1: press pop — 1 -> 0.96 -> 1 with pop easing. */
export function pop(el) {
  if (!(el instanceof Element)) return;
  classOnce(el, 'auvyq-press-pop', 120);
}

/** Animation 4: counter bounce — 1 -> 1.35 -> 1, safely retriggerable. */
export function bounce(el) {
  if (!(el instanceof Element)) return;
  classOnce(el, 'auvyq-bounce', 320);
}

/** Animation 5: panel sweep — skewed light band across a panel, >=120ms after paint. */
export function sweep(panel) {
  if (!(panel instanceof Element)) return;
  if (!panel.classList.contains('auvyq-sweep-host')) {
    panel.classList.add('auvyq-sweep-host');
  }
  const existing = panel.querySelector('.auvyq-sweep-band');
  const band = existing ?? document.createElement('div');
  band.className = 'auvyq-sweep-band';
  if (existing === null) panel.appendChild(band);
  band.classList.remove('run');
  void band.offsetWidth;
  const start = () => {
    if (!band.isConnected) return; // popup closed: no detached-DOM animation
    band.classList.add('run');
  };
  setTimeout(start, reducedMotion() ? 0 : 120);
}

/** Animation 7: warning shake — -2px, 4px, -6px, 6px with snap easing. */
export function shake(el) {
  if (!(el instanceof Element)) return;
  classOnce(el, 'auvyq-shake', 420);
}

/** Animation 6: staggered slide-in for a list (max 8 items, 30ms stagger). */
export function stagger(list) {
  if (!(list instanceof Element)) return;
  const items = [...list.children].filter((el) => el.classList.contains('auvyq-slide-item')).slice(0, 8);
  items.forEach((item, index) => {
    const delay = reducedMotion() ? 0 : index * 30;
    item.style.transitionDelay = `${delay}ms`;
    requestAnimationFrame(() => item.classList.add('in'));
    item.addEventListener('transitionend', () => {
      item.style.transitionDelay = '';
    }, { once: true });
  });
}

/** Number roll-up using a shared rAF loop; cancelable and leak-free. */
export function countUp(el, from, to) {
  if (!(el instanceof Element) || !Number.isFinite(from) || !Number.isFinite(to)) return;
  const previous = registry.get(el);
  if (previous !== undefined) previous.cancel();
  const durationMs = reducedMotion() ? 0 : 480;
  const start = performance.now();
  let frame = 0;
  let cancelled = false;
  const controller = {
    cancel() {
      cancelled = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    }
  };
  setController(el, controller);
  const render = (now) => {
    if (cancelled || !el.isConnected) return;
    const t = durationMs === 0 ? 1 : Math.min(1, (now - start) / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (t < 1) {
      frame = requestAnimationFrame(render);
    } else {
      frame = 0;
    }
  };
  frame = requestAnimationFrame(render);
}

/**
 * Shield state animation API. States: protected, activating, paused, warning,
 * threat, disabled, updating, error. Protected/paused/disabled are static;
 * activating runs the pulse+ring narrative once; threat runs one emphasis.
 */
export function animateShieldState(stageEl, state) {
  if (!(stageEl instanceof Element)) return;
  const shield = stageEl.querySelector('.auvyq-shield');
  stageEl.classList.remove(
    'activating',
    'auvyq-shield-state-paused',
    'auvyq-shield-state-warning',
    'auvyq-shield-state-threat',
    'auvyq-shield-state-disabled',
    'auvyq-shield-state-error'
  );
  if (shield !== null) {
    shield.classList.remove('auvyq-threat-lock', 'auvyq-success-settle');
  }
  switch (state) {
    case 'protected':
      // static, calm, no animation
      break;
    case 'activating':
      stageEl.classList.add('activating');
      // total narrative <= 900ms (640ms + max 220ms delay); then settle static.
      setTimeout(() => stageEl.classList.remove('activating'), reducedMotion() ? 0 : 880);
      break;
    case 'paused':
      stageEl.classList.add('auvyq-shield-state-paused');
      break;
    case 'warning':
      stageEl.classList.add('auvyq-shield-state-warning');
      break;
    case 'threat':
      stageEl.classList.add('auvyq-shield-state-threat');
      if (shield !== null) classOnce(shield, 'auvyq-threat-lock', 320);
      break;
    case 'disabled':
      stageEl.classList.add('auvyq-shield-state-disabled');
      break;
    case 'updating':
      sweep(stageEl);
      break;
    case 'error':
      stageEl.classList.add('auvyq-shield-state-error');
      if (shield !== null) classOnce(shield, 'auvyq-threat-lock', 320);
      break;
    default:
      break;
  }
}

/** Cancels every tracked animation for a root (used on popup close). */
export function cancelAll(root) {
  if (!(root instanceof Element)) return;
  const targets = [root, ...root.querySelectorAll('*')];
  for (const el of targets) {
    const controller = registry.get(el);
    if (controller !== undefined) controller.cancel();
  }
}

export function prefersReducedMotion() {
  return reducedMotion();
}

/** Convenience: attach press-pop to all buttons inside a root. */
export function bindPressPop(root) {
  if (!(root instanceof Element)) return;
  root.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (target !== null) pop(target);
  });
}
