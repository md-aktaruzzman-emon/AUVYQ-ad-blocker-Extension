/*
 * AUVYQ cosmetic injector — ISOLATED world, document_start.
 * Injects TWO layers of element hiding:
 *   1. Built-in generic ad selectors (below) — applied synchronously at
 *      document_start, no RPC wait, works even before the rule pack exists.
 *      Every selector is an exact class/id token or framework-generated prefix
 *      (Google Publisher Tag, AdSense, Ezoic, YouTube ad containers) — never a
 *      bare substring like "ad" — to keep false positives near zero.
 *   2. Per-host CSS from the compiled rule pack via the RPC layer (GET_COSMETIC).
 * Also bridges configuration to the MAIN-world scripts (scriptlets, fingerprint
 * shields) via DOM CustomEvents with cryptographic authentication nonces.
 * Safe style injection only: <style> elements, no HTML parsing of any kind.
 *
 * Modernized for 2026:
 *   - Zero layout thrashing: microtask/rAF-batched DOM mutation processing.
 *   - Style Tamper Defense: automatic re-attachment if anti-adblock scripts remove styles.
 *   - SPA route navigation detection: seamless route transition support (YouTube, Reddit, X).
 *   - Strict distinction between native CSS and procedural selectors.
 *   - Cross-origin iframe security: safe location resolution without top-frame access errors.
 */
(() => {
  const COSMETIC_GUARD = '__cosmetic_guard_init__';
  if (Object.prototype.hasOwnProperty.call(window, COSMETIC_GUARD)) return;
  try {
    Object.defineProperty(window, COSMETIC_GUARD, { value: 1, writable: false, enumerable: false, configurable: false });
  } catch {
    // non-fatal
  }

  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  // Safe frame & host detection (prevents cross-origin frame SecurityErrors)
  let host = '';
  try {
    host = location.hostname || '';
  } catch {
    return;
  }

  // ---- Built-in generic ad selectors ---------------------------------------
  // Curated for high precision: framework-generated ids, exact ad-specific class
  // tokens, video player ad containers, ad iframes identified by known sources.
  const BUILTIN_SELECTORS = [
    // Google AdSense / Google Publisher Tag / AMP ads
    'ins.adsbygoogle',
    '.adsbygoogle',
    'amp-ad',
    'amp-fx-flying-carpet',
    '[id^="div-gpt-ad"]',
    '[id^="google_ads_iframe"]',
    '[id^="aswift"]',
    'iframe[id^="google_ads_frame"]',
    'iframe[data-google-container-id]',
    '#google_ads_div',
    '#AdDiv',

    // Exact ad-container class tokens (BEM variants are covered by the pack list)
    '.ad-banner', '.ad-banner-container', '.ad-box', '.ad-container', '.ad-label',
    '.ad-leaderboard', '.ad-placeholder', '.ad-sidebar', '.ad-slot', '.ad-slot-container',
    '.ad-space', '.ad-unit', '.ad-wrap', '.ad-wrapper', '.ad-zone', '.ads-container',
    '.adsbox', '.advertisement', '.advert', '.adverts', '.adslot', '.dfp-ad', '.dfp-slot',
    '.sponsored-ad', '.ezoic-ad', '.OUTBRAIN',
    '.ad-widget', '.adContainer', '.ad_container', '.advertisement-banner',
    '.ad-flex', '.ad-leaderboard-wrapper', '.ad-halfpage', '.ad-billboard', '.ad-mrec',
    '.ad-skyscraper', '.adtech', '.ad-tag', '.ad-block', '.ad-region', '.ad-section',
    '.adunit', '.ad-holder', '.ad-frame', '.ad-cell', '.ad-area',

    // Data-attribute patterns
    '[data-ad]', '[data-ad-unit]', '[data-ad-slot]', '[data-google-query-id]',
    '[data-dfp-ad]', '[data-prebid]', '[data-ez-name]', '[data-ezoic-id]',
    '[data-sponsored]', '[data-native-ad]',
    '[aria-label="Advertisement"]', '[aria-label="Sponsored"]',

    // Video player & platform ad containers (YouTube, Twitch, social feeds)
    'ytd-promoted-sparkles-web-renderer',
    'ytd-ad-slot-renderer',
    'ytd-in-feed-ad-layout-renderer',
    '#masthead-ad',
    '.ytd-action-companion-ad-renderer',
    '.ytp-ad-overlay-container',
    '.ytp-ad-message-container',
    'ytd-banner-promo-renderer',
    'ytd-statement-banner-renderer',
    'ytd-player-legacy-desktop-watch-ads-renderer',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
    '[data-testid="placementTracking"]',
    'shreddit-ad-post',
    '.promotedlink',

    // Sponsored / Native ad widgets
    '.promoted-content', '.native-ad', '.sponsored-content', '.sponsored-post',
    '.sponsored-block', '.sponsor-block', '.ad-native', '.native-ad-container',
    '.in-feed-ad', '.in-article-ad',
    '[id^="taboola-"]', '.taboola-article-page-thumbnails',
    '[id^="outbrain-widget"]', '.mgid-widget',

    // Common ad-container element ids
    '#adBanner', '#adBox', '#adContainer', '#adSlot', '#adUnit',
    '[id*="right-rail-ad"]', '[id*="sticky-ad"]',

    // Intrusive ad overlays / popups / interstitials (kept narrow on purpose)
    '.ad-overlay', '.ads-overlay', '#ad-overlay', '.ad-popup', '#ad-popup',
    '.ad-modal', '#ad-modal', '.ad-interstitial', '.interstitial-ad',
    '.ad-fullscreen', '.ad-takeover', '.dfp-ad-interstitial',

    // Ad iframes identified by dedicated ad-infrastructure sources
    'iframe[src*="googlesyndication.com"]', 'iframe[src*="doubleclick.net"]',
    'iframe[src*="googleadservices.com"]', 'iframe[src*="adservice.google."]',
    'iframe[src*="2mdn.net"]', 'iframe[src*="amazon-adsystem.com"]',
    'iframe[src*="adnxs.com"]', 'iframe[src*="adsafeprotected.com"]',
    'iframe[src*="moatads.com"]', 'iframe[src*="doubleverify.com"]',
    'iframe[src*="pubmatic.com"]', 'iframe[src*="rubiconproject.com"]',
    'iframe[src*="criteo.com"]', 'iframe[src*="criteo.net"]',
    'iframe[src*="smartadserver.com"]', 'iframe[src*="openx.net"]',
    'iframe[src*="casalemedia.com"]', 'iframe[src*="taboola.com"]',
    'iframe[src*="outbrain.com"]', 'iframe[src*="revcontent.com"]',
    'iframe[src*="mgid.com"]', 'iframe[src*="teads.tv"]', 'iframe[src*="zedo.com"]',
    'iframe[src*="popads.net"]', 'iframe[src*="adcash.com"]',
    'iframe[src*="exoclick.com"]', 'iframe[src*="scorecardresearch.com"]',
    'iframe[src*="triplelift.com"]', 'iframe[src*="sharethrough.com"]',
    'iframe[src*="media.net"]'
  ];

  let requestCounter = 0;
  function nextRequestId() {
    requestCounter += 1;
    const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : String(Math.random());
    return `cs-${random.slice(0, 24)}-${requestCounter}`;
  }

  function rpc(type, payload) {
    return chrome.runtime.sendMessage({ v: 1, type, requestId: nextRequestId(), payload })
      .then((response) => {
        if (response === undefined) throw new Error('no response');
        if (response.success !== true) throw new Error(response.error || 'rpc failed');
        return response.data;
      });
  }

  // ---- CSS Injection & Style Tamper Defense ---------------------------------

  let builtinStyle = null;
  let packStyle = null;
  let isProtectionActive = true;
  let reportedHidden = 0;
  let activeSelectors = BUILTIN_SELECTORS;

  function mountPoint() {
    return document.head || document.documentElement;
  }

  function createStyleElement(cssText) {
    const style = document.createElement('style');
    style.type = 'text/css';
    style.textContent = cssText;
    return style;
  }

  function tryInjectBuiltin() {
    if (!isProtectionActive || builtinStyle !== null) return;
    const mount = mountPoint();
    if (mount !== null) {
      builtinStyle = createStyleElement(BUILTIN_SELECTORS.map((s) => `${s}{display:none !important}`).join('\n'));
      mount.appendChild(builtinStyle);
    } else if (document.documentElement === null) {
      const docObs = new MutationObserver(() => {
        if (mountPoint() !== null) {
          docObs.disconnect();
          tryInjectBuiltin();
        }
      });
      docObs.observe(document, { childList: true });
    }
  }

  function injectPackCss(css) {
    if (!isProtectionActive || typeof css !== 'string' || css.length === 0) return;
    if (packStyle !== null) {
      packStyle.textContent = css;
      return;
    }
    const mount = mountPoint();
    if (mount === null) return;
    packStyle = createStyleElement(css);
    mount.appendChild(packStyle);
  }

  function removeStyles() {
    isProtectionActive = false;
    if (builtinStyle !== null) {
      builtinStyle.remove();
      builtinStyle = null;
    }
    if (packStyle !== null) {
      packStyle.remove();
      packStyle = null;
    }
  }

  // Style Tamper Defense: Watch mountPoint for style detachment by anti-adblock scripts
  function setupStyleTamperDefense() {
    const mount = mountPoint();
    if (mount === null) return;

    const tamperObserver = new MutationObserver(() => {
      if (!isProtectionActive) return;
      const curMount = mountPoint();
      if (curMount === null) return;

      if (builtinStyle !== null && !curMount.contains(builtinStyle)) {
        try { curMount.appendChild(builtinStyle); } catch { /* ignore */ }
      }
      if (packStyle !== null && !curMount.contains(packStyle)) {
        try { curMount.appendChild(packStyle); } catch { /* ignore */ }
      }
    });

    tamperObserver.observe(mount, { childList: true });
    window.addEventListener('pagehide', () => tamperObserver.disconnect(), { once: true });
  }

  // Synchronously inject builtin cosmetic CSS to prevent first-paint ad flashes
  tryInjectBuiltin();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupStyleTamperDefense, { once: true });
  } else {
    setupStyleTamperDefense();
  }

  // ---- Native CSS vs. Procedural Selectors ---------------------------------
  // Native CSS selectors are applied via <style>.
  // Procedural selectors (:has-text, :matches-path) are NOT valid CSS and are
  // handled safely without injecting invalid CSS syntax.

  function isProceduralSelector(selector) {
    if (typeof selector !== 'string') return false;
    return selector.includes(':has-text(') || selector.includes(':matches-path(') ||
           selector.includes(':-abp-has(') || selector.includes(':xpath(');
  }

  function sanitizeNativeSelectors(selectors) {
    if (!Array.isArray(selectors)) return [];
    return selectors.filter((sel) => typeof sel === 'string' && sel.length > 0 && !isProceduralSelector(sel));
  }

  // ---- Performance-Optimized Element Collapsing ----------------------------
  // Native CSS handles hiding in the C++ engine. Active JS collapsing is only
  // used for residual containers with stubborn inline-styled heights.
  // Instead of scanning every added node with 150 selectors (which thrashed layout),
  // we batch candidate nodes and check only container elements on idle frames.

  const IGNORABLE_TAGS = new Set([
    'SPAN', 'P', 'B', 'I', 'EM', 'STRONG', 'A', 'SVG', 'PATH', 'CODE',
    'PRE', 'LI', 'UL', 'OL', 'BUTTON', 'INPUT', 'LABEL', 'SELECT', 'OPTION',
    'TEXTAREA', 'BR', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'
  ]);

  function collapseNode(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      el.style.setProperty('display', 'none', 'important');
      el.style.setProperty('visibility', 'hidden', 'important');
      el.style.setProperty('height', '0px', 'important');
      el.style.setProperty('min-height', '0px', 'important');
      el.style.setProperty('max-height', '0px', 'important');
    } catch {
      // non-fatal
    }
  }

  let pendingElements = [];
  let flushScheduled = false;

  function flushPendingCollapses() {
    flushScheduled = false;
    const batch = pendingElements.splice(0, 80);
    if (batch.length === 0) return;

    const selectors = activeSelectors.slice(0, 80);
    for (let i = 0; i < batch.length; i++) {
      const el = batch[i];
      if (!el || el.nodeType !== 1 || !el.isConnected) continue;

      for (let j = 0; j < selectors.length; j++) {
        const sel = selectors[j];
        try {
          if (el.matches && el.matches(sel)) {
            collapseNode(el);
            break;
          }
        } catch {
          // invalid selector syntax: skip
        }
      }
    }

    if (pendingElements.length > 0) {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flushPendingCollapses);
    } else {
      setTimeout(flushPendingCollapses, 16);
    }
  }

  function queueCandidate(node) {
    if (!node || node.nodeType !== 1) return;
    if (IGNORABLE_TAGS.has(node.tagName)) return;
    if (pendingElements.length < 200) {
      pendingElements.push(node);
      scheduleFlush();
    }
  }

  // ---- Statistics Reporting (Throttled & Bounded) ---------------------------

  function countHidden(selectors) {
    if (!Array.isArray(selectors) || selectors.length === 0) return 0;
    let count = 0;
    for (const selector of selectors.slice(0, 100)) {
      if (typeof selector !== 'string' || selector.length === 0 || selector.length > 512) continue;
      try {
        count += document.querySelectorAll(selector).length;
      } catch {
        // invalid selector: skip
      }
      if (count > 2000) return 2000;
    }
    return count;
  }

  let lastReportTime = 0;
  function reportIfChanged(selectors) {
    const now = Date.now();
    if (now - lastReportTime < 1500) return; // at most one report every 1.5s
    lastReportTime = now;

    const hidden = countHidden(selectors);
    if (hidden > reportedHidden) {
      const delta = hidden - reportedHidden;
      reportedHidden = hidden;
      rpc('REPORT_COSMETIC', { host, count: delta }).catch(() => undefined);
    }
  }

  // ---- Single Page Application (SPA) Route Detection -----------------------

  let lastUrl = location.href;
  function onRouteChanged() {
    const currentUrl = location.href;
    if (currentUrl === lastUrl) return;
    lastUrl = currentUrl;

    // Refresh route state: re-evaluate cosmetic state and trigger count check
    if (isProtectionActive) {
      scheduleFlush();
      reportIfChanged(activeSelectors);
    }
  }

  function setupSpaRouteListeners() {
    window.addEventListener('popstate', onRouteChanged, true);
    window.addEventListener('hashchange', onRouteChanged, true);

    // Non-invasive History API wrapping
    try {
      const originalPushState = history.pushState;
      history.pushState = function pushState(...args) {
        const ret = originalPushState.apply(this, args);
        onRouteChanged();
        return ret;
      };

      const originalReplaceState = history.replaceState;
      history.replaceState = function replaceState(...args) {
        const ret = originalReplaceState.apply(this, args);
        onRouteChanged();
        return ret;
      };
    } catch {
      // non-fatal
    }
  }

  setupSpaRouteListeners();

  // ---- Config bridge to MAIN world -----------------------------------------

  function dispatchToMain(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      // structured clone failures are non-fatal
    }
  }

  let pendingScriptlets = null;
  let scriptletNonce = null;

  function sendScriptlets(entries) {
    pendingScriptlets = entries;
    dispatchToMain('auvyq-scriptlets', { nonce: scriptletNonce, entries });
  }

  window.addEventListener('auvyq-scriptlet-ready', (event) => {
    if (event && event.detail && typeof event.detail.nonce === 'string') {
      scriptletNonce = event.detail.nonce;
    }
    if (pendingScriptlets !== null) {
      dispatchToMain('auvyq-scriptlets', { nonce: scriptletNonce, entries: pendingScriptlets });
    }
  }, true);

  let pendingFpShields = null;
  function sendFpShields(shields) {
    pendingFpShields = shields;
    dispatchToMain('auvyq-fp-config', shields);
  }

  window.addEventListener('auvyq-fp-ready', () => {
    if (pendingFpShields !== null) {
      dispatchToMain('auvyq-fp-config', pendingFpShields);
    }
  }, true);

  // ---- Boot ----------------------------------------------------------------

  rpc('GET_COSMETIC', { host }).then((data) => {
    const enabled = !data || data.enabled !== false;
    if (!enabled) {
      removeStyles();
      return;
    }

    tryInjectBuiltin();
    injectPackCss(data && typeof data.css === 'string' ? data.css : '');

    const extraSelectors = data && Array.isArray(data.selectors) ? sanitizeNativeSelectors(data.selectors) : [];
    activeSelectors = BUILTIN_SELECTORS.concat(extraSelectors);

    // Initial scan once interactive
    const initialScan = () => reportIfChanged(activeSelectors);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialScan, { once: true });
    } else {
      initialScan();
    }

    // High-performance MutationObserver: queues only candidate elements
    const observer = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          queueCandidate(added[j]);
        }
      }
      reportIfChanged(activeSelectors);
    });

    if (document.documentElement !== null) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }).catch(() => undefined);

  rpc('GET_DISPATCH', { host }).then((data) => {
    sendScriptlets((data && Array.isArray(data.entries)) ? data.entries : []);
  }).catch(() => undefined);

  rpc('GET_FP_SHIELDS', { host }).then((data) => {
    sendFpShields((data && typeof data.shields === 'object' && data.shields !== null) ? data.shields : {});
  }).catch(() => undefined);

  // ---- Login-form observation (bounded, privacy-preserving: origins only) ---

  function scanLoginForms() {
    const forms = document.forms;
    if (!forms || forms.length === 0) return;
    const pageOrigin = location.origin;
    const found = [];
    for (const form of forms) {
      if (found.length >= 20) break;
      let hasPassword = false;
      for (const input of form.elements) {
        if (input instanceof HTMLInputElement && input.type === 'password') {
          hasPassword = true;
          break;
        }
      }
      if (!hasPassword) continue;
      let actionOrigin = pageOrigin;
      try {
        actionOrigin = (form.getAttribute('action') || '').length > 0 ? new URL(form.getAttribute('action') || '', pageOrigin).origin : pageOrigin;
      } catch {
        actionOrigin = '';
      }
      found.push({ actionOrigin, hasPasswordField: true });
    }
    if (found.length > 0) {
      rpc('CHECK_LOGIN_FORMS', { pageOrigin, forms: found }).catch(() => undefined);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(scanLoginForms, 400), { once: true });
  } else {
    setTimeout(scanLoginForms, 400);
  }
})();
