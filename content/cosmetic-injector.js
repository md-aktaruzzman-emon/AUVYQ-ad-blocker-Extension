/*
 * AUVYQ cosmetic injector — ISOLATED world, document_start.
 * Injects TWO layers of element hiding:
 *   1. Built-in generic ad selectors (below) — applied synchronously at
 *      document_start, no RPC wait, works even before the rule pack exists.
 *      Every selector is an exact class/id token or framework-generated prefix
 *      (Google Publisher Tag, AdSense, Ezoic) — never a bare substring like
 *      "ad" — to keep false positives near zero.
 *   2. Per-host CSS from the compiled rule pack via the RPC layer (GET_COSMETIC).
 * Also bridges configuration to the MAIN-world scripts (scriptlets, fingerprint
 * shields) via DOM CustomEvents — MAIN world has no access to chrome.* APIs.
 * Safe style injection only: <style> elements, no HTML parsing of any kind.
 */
(() => {
  if (window.__auvyqCosmeticActive === true) return;
  window.__auvyqCosmeticActive = true;

  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  // ---- Built-in generic ad selectors ---------------------------------------
  // Curated for high precision: framework-generated ids, exact ad-specific class
  // tokens, ad iframes identified by their known ad-infrastructure source, and
  // conservative overlay/interstitial patterns.
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

  const host = location.hostname;

  // ---- CSS injection -------------------------------------------------------

  let injected = false;
  let builtinStyle = null;
  let reportedHidden = 0;

  function mountPoint() {
    return document.head || document.documentElement;
  }

  function injectCss(css) {
    if (injected || typeof css !== 'string' || css.length === 0) return;
    injected = true;
    const style = document.createElement('style');
    style.setAttribute('data-auvyq', 'cosmetic');
    style.textContent = css; // style elements hold CSS text; never parsed as HTML
    const mount = mountPoint();
    if (mount === null) return;
    mount.appendChild(style);
  }

  // Built-in pack is applied immediately (protection is the default state) and
  // removed if the RPC later reports that protection is disabled.
  function tryInjectBuiltin() {
    if (builtinStyle !== null) return;
    const mount = mountPoint();
    if (mount !== null) {
      builtinStyle = document.createElement('style');
      builtinStyle.setAttribute('data-auvyq', 'cosmetic-builtin');
      builtinStyle.textContent = BUILTIN_SELECTORS.map((s) => `${s}{display:none !important}`).join('\n');
      mount.appendChild(builtinStyle);
    } else if (document.documentElement === null) {
      const obs = new MutationObserver(() => {
        if (mountPoint() !== null) {
          obs.disconnect();
          tryInjectBuiltin();
        }
      });
      obs.observe(document, { childList: true });
    }
  }

  function removeBuiltin() {
    if (builtinStyle === null) return;
    builtinStyle.remove();
    builtinStyle = null;
  }

  // Synchronously inject builtin cosmetic CSS to prevent first-paint ad flashes
  tryInjectBuiltin();

  function countHidden(selectors) {
    if (!Array.isArray(selectors) || selectors.length === 0) return 0;
    let count = 0;
    for (const selector of selectors.slice(0, 500)) {
      if (typeof selector !== 'string' || selector.length === 0 || selector.length > 1024) continue;
      try {
        count += document.querySelectorAll(selector).length;
      } catch {
        // invalid selector for this engine: skip
      }
      if (count > 5000) return 5000;
    }
    return count;
  }

  function reportIfChanged(selectors) {
    const hidden = countHidden(selectors);
    if (hidden > reportedHidden) {
      const delta = hidden - reportedHidden;
      reportedHidden = hidden;
      rpc('REPORT_COSMETIC', { host, count: delta }).catch(() => undefined);
    }
  }

  // ---- Config bridge to MAIN world ----------------------------------------

  function dispatchToMain(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {
      // structured clone failures (shouldn't happen with plain data) are non-fatal
    }
  }

  // Scriptlet handshake buffer to prevent race conditions with MAIN-world listener
  let pendingScriptlets = null;
  function sendScriptlets(entries) {
    pendingScriptlets = entries;
    dispatchToMain('auvyq-scriptlets', entries);
  }

  window.addEventListener('auvyq-scriptlet-ready', () => {
    if (pendingScriptlets !== null) {
      dispatchToMain('auvyq-scriptlets', pendingScriptlets);
    }
  });

  // ---- Boot ----------------------------------------------------------------

  rpc('GET_COSMETIC', { host }).then((data) => {
    const enabled = !data || data.enabled !== false;
    if (!enabled) {
      removeBuiltin();
      return;
    }
    // Re-verify builtin injection
    tryInjectBuiltin();
    injectCss(data && typeof data.css === 'string' ? data.css : '');

    const selectors = BUILTIN_SELECTORS.concat(data && Array.isArray(data.selectors) ? data.selectors : []);

    // Initial count once the DOM is interactive; then a bounded, throttled
    // MutationObserver. CSS auto-hides any element that matches later, so the
    // observer only tracks COUNTS for statistics — it never rescans the whole
    // document per mutation and always disconnects.
    const initialScan = () => reportIfChanged(selectors);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialScan, { once: true });
    } else {
      initialScan();
    }

    // Active element collapser for newly inserted nodes (handles inline style overrides & empty boxes)
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

    function collapseMatchingElements(root) {
      if (!root || root.nodeType !== 1) return;
      for (const sel of selectors.slice(0, 150)) {
        try {
          if (root.matches && root.matches(sel)) {
            collapseNode(root);
          }
          const descendants = root.querySelectorAll(sel);
          for (let i = 0; i < descendants.length; i++) {
            collapseNode(descendants[i]);
          }
        } catch {
          // skip invalid selector
        }
      }
    }

    let scheduled = false;
    let lastRun = 0;
    const observer = new MutationObserver((mutations) => {
      // Immediate active collapse on added nodes (SPAs, React, Vue, infinite scroll)
      for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          collapseMatchingElements(added[j]);
        }
      }

      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const now = Date.now();
        if (now - lastRun < 1000) return; // throttle: at most one count pass/second
        lastRun = now;
        reportIfChanged(selectors);
      });
    });
    if (document.documentElement !== null) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
  }).catch(() => undefined);

  rpc('GET_DISPATCH', { host }).then((data) => {
    sendScriptlets((data && Array.isArray(data.entries)) ? data.entries : []);
  }).catch(() => undefined);

  rpc('GET_FP_SHIELDS', {}).then((data) => {
    dispatchToMain('auvyq-fp-config', (data && typeof data.shields === 'object' && data.shields !== null) ? data.shields : {});
  }).catch(() => undefined);

  // ---- Login-form observation (bounded, privacy-preserving: origins only) --

  function scanLoginForms() {
    const forms = document.forms;
    if (forms.length === 0) return;
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
        actionOrigin = form.action.length > 0 ? new URL(form.action, pageOrigin).origin : pageOrigin;
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
