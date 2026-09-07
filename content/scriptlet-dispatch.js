/*
 * AUVYQ scriptlet dispatcher — MAIN world, document_start.
 * Pipeline: filter -> parse -> validate -> compile -> dispatch. NEVER eval.
 * Entries arrive via the 'auvyq-scriptlets' DOM event from the ISOLATED-world
 * injector (they were already validated by the service worker; this layer
 * re-validates independently — defense in depth). Only the 15 fixed, allowlisted
 * implementations below can ever run; each is isolated so one failure cannot
 * affect the others.
 */
(() => {
  if (window.__auvyqDispatchActive === true) return;
  window.__auvyqDispatchActive = true;

  const NAMES = new Set([
    'noop-callback', 'json-prune-lite', 'set-constant', 'prevent-addEventListener',
    'prevent-setTimeout', 'noop-fetch', 'close-window', 'no-fetch-if', 'no-xhr-if',
    'abort-on-property-read', 'hide-in-shadow', 'remove-class', 'remove-attr',
    'prevent-eval-if', 'trusted-suppress-console'
  ]);
  const FORBIDDEN = ['<', '>', '`', '"', "'", '\\', '}', '{', ';', '(', ')', '=>'];
  const MAX_ARG = 256;

  function validateEntry(entry) {
    if (typeof entry !== 'object' || entry === null) return null;
    if (typeof entry.name !== 'string' || !NAMES.has(entry.name)) return null;
    if (!Array.isArray(entry.args) || entry.args.length > 8) return null;
    const args = [];
    for (const arg of entry.args) {
      if (typeof arg === 'number' && Number.isFinite(arg)) {
        args.push(arg);
        continue;
      }
      if (typeof arg !== 'string' || arg.length === 0 || arg.length > MAX_ARG) return null;
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001F\u007F]/.test(arg)) return null;
      if (FORBIDDEN.some((token) => arg.includes(token))) return null;
      const lowered = arg.toLowerCase();
      if (lowered.includes('__proto__') || lowered.includes('prototype') || lowered.includes('constructor')) return null;
      args.push(arg);
    }
    return { name: entry.name, args };
  }

  // ---- shared helpers (fixed code) -----------------------------------------

  const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor', 'self', 'window', 'document', 'globalthis']);
  function resolvePath(path) {
    if (typeof path !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*){0,7}$/.test(path)) return null;
    const segments = path.split('.');
    if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s.toLowerCase()))) return null;
    let target = window;
    for (let i = 0; i < segments.length - 1; i++) {
      const next = target[segments[i]];
      if (typeof next !== 'object' && typeof next !== 'function' || next === null) return null;
      target = next;
    }
    return { target, key: segments[segments.length - 1] };
  }

  function parseConstantValue(raw) {
    if (raw === 'undefined') return undefined;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    if (raw === 'null') return null;
    if (raw === 'NaN') return NaN;
    if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
    if (/^\{\}$/.test(raw)) return {};
    if (/^\[\]$/.test(raw)) return [];
    return String(raw);
  }

  // ---- the 15 fixed implementations ----------------------------------------

  const implementations = {
    'noop-callback': (args) => {
      if (args.length === 1) {
        const resolved = resolvePath(args[0]);
        if (resolved) resolved.target[resolved.key] = function noop() {};
        return;
      }
      // no arg: install a global no-op under a non-conflicting name
      window.__auvyqNoop = function noop() {};
    },

    'json-prune-lite': (args) => {
      const keys = String(args[0]).split('.').map((k) => k.trim()).filter((k) => /^[A-Za-z0-9_$]+$/.test(k));
      if (keys.length === 0) return;
      const prune = (value) => {
        if (typeof value !== 'object' || value === null) return value;
        let current = value;
        for (let i = 0; i < keys.length - 1; i++) {
          current = current[keys[i]];
          if (typeof current !== 'object' || current === null) return value;
        }
        try {
          if (Object.prototype.hasOwnProperty.call(current, keys[keys.length - 1])) {
            delete current[keys[keys.length - 1]];
          }
        } catch { /* non-fatal */ }
        return value;
      };
      const originalParse = JSON.parse.bind(JSON);
      JSON.parse = function parse(text, reviver) {
        return prune(originalParse(text, reviver));
      };
    },

    'set-constant': (args) => {
      const resolved = resolvePath(args[0]);
      if (!resolved) return;
      const value = parseConstantValue(String(args[1]));
      try {
        Object.defineProperty(resolved.target, resolved.key, {
          get() { return value; },
          set() { /* hold the constant */ },
          configurable: true,
          enumerable: true
        });
      } catch { /* non-fatal */ }
    },

    'prevent-addEventListener': (args) => {
      const type = String(args[0]).toLowerCase();
      const original = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function addEventListener(kind, listener, options) {
        if (typeof kind === 'string' && kind.toLowerCase() === type) return;
        return original.call(this, kind, listener, options);
      };
    },

    'prevent-setTimeout': (args) => {
      const needle = String(args[0]);
      const original = window.setTimeout.bind(window);
      window.setTimeout = function setTimeoutPatched(callback, delay, ...rest) {
        if (typeof callback === 'function') {
          const source = Function.prototype.toString.call(callback);
          if (needle.length > 0 && source.includes(needle)) return 0;
        } else if (typeof callback === 'string' && callback.includes(needle)) {
          return 0; // string callbacks are the page's own doing; refusing is the point
        }
        return original(callback, delay, ...rest);
      };
    },

    'noop-fetch': (args) => {
      const needle = args.length === 1 ? String(args[0]) : '';
      const original = window.fetch ? window.fetch.bind(window) : null;
      if (original === null) return;
      window.fetch = function fetchPatched(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) ? input.url : '';
        if (needle.length === 0 || url.includes(needle)) {
          return Promise.resolve(new Response('', { status: 200, statusText: 'OK' }));
        }
        return original(input, init);
      };
    },

    'close-window': () => {
      try { window.close(); } catch { /* blocked */ }
    },

    'no-fetch-if': (args) => {
      const needle = String(args[0]);
      const original = window.fetch ? window.fetch.bind(window) : null;
      if (original === null) return;
      window.fetch = function fetchPatched(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) ? input.url : '';
        if (url.includes(needle)) {
          return Promise.reject(new TypeError('blocked'));
        }
        return original(input, init);
      };
    },

    'no-xhr-if': (args) => {
      const needle = String(args[0]);
      const originalOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function openPatched(method, url, ...rest) {
        if (typeof url === 'string' && url.includes(needle)) {
          this.__auvyqBlocked = true;
        }
        return originalOpen.call(this, method, url, ...rest);
      };
      const originalSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.send = function sendPatched(body) {
        if (this.__auvyqBlocked === true) {
          this.dispatchEvent(new Event('error'));
          return;
        }
        return originalSend.call(this, body);
      };
    },

    'abort-on-property-read': (args) => {
      const resolved = resolvePath(args[0]);
      if (!resolved) return;
      try {
        Object.defineProperty(resolved.target, resolved.key, {
          get() { throw new Error('AUVYQ: property read aborted'); },
          set() { /* swallow */ },
          configurable: true
        });
      } catch { /* non-fatal */ }
    },

    'hide-in-shadow': (args) => {
      const selector = String(args[0]);
      if (selector.length === 0) return;
      const hide = (root) => {
        try {
          for (const el of root.querySelectorAll(selector)) {
            el.style.setProperty('visibility', 'hidden', 'important');
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot !== null) hide(el.shadowRoot);
          }
        } catch { /* non-fatal */ }
      };
      hide(document);
    },

    'remove-class': (args) => {
      const className = String(args[0]);
      const selector = args.length === 2 ? String(args[1]) : '*';
      if (className.length === 0) return;
      try {
        for (const el of document.querySelectorAll(selector)) el.classList.remove(className);
      } catch { /* non-fatal */ }
    },

    'remove-attr': (args) => {
      const attr = String(args[0]);
      const selector = args.length === 2 ? String(args[1]) : '*';
      if (attr.length === 0) return;
      try {
        for (const el of document.querySelectorAll(selector)) el.removeAttribute(attr);
      } catch { /* non-fatal */ }
    },

    'prevent-eval-if': (args) => {
      const needle = args.length === 1 ? String(args[0]) : '';
      /* eslint-disable no-eval, no-restricted-properties */
      const originalEval = window.eval;
      window.eval = function evalPatched(code) {
        if (typeof code === 'string' && (needle.length === 0 || code.includes(needle))) {
          throw new Error('AUVYQ: eval blocked');
        }
        return originalEval.call(this, code);
      };
      /* eslint-enable no-eval, no-restricted-properties */
    },

    'trusted-suppress-console': (args) => {
      const methods = (args.length === 1 ? String(args[0]) : 'log,debug,info').split(',');
      for (const name of methods) {
        const trimmed = name.trim();
        if (/^[a-z]+$/.test(trimmed) && typeof console[trimmed] === 'function') {
          console[trimmed] = function suppressed() {};
        }
      }
    }
  };

  const executedKeys = new Set();
  function dispatch(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    for (const raw of entries.slice(0, 32)) {
      const entry = validateEntry(raw);
      if (entry === null) continue;
      const key = `${entry.name}:${JSON.stringify(entry.args)}`;
      if (executedKeys.has(key)) continue;
      executedKeys.add(key);
      const impl = implementations[entry.name];
      if (typeof impl !== 'function') continue;
      try {
        impl(entry.args);
      } catch {
        // isolated failure: other scriptlets are unaffected
      }
    }
  }

  window.addEventListener('auvyq-scriptlets', (event) => {
    dispatch(event.detail);
  });

  try {
    window.dispatchEvent(new CustomEvent('auvyq-scriptlet-ready'));
  } catch {
    // non-fatal
  }
})();

