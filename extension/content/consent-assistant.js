/*
 * AUVYQ Privacy-Respecting Cookie Consent Assistant — ISOLATED world, document_idle.
 *
 * Automatically declines optional tracking cookies on common CMPs (OneTrust, Cookiebot, Didomi, Klaro, Quantcast).
 *
 * Strict Privacy Invariants:
 *   1. NEVER automatically clicks "Accept All" or "Allow All".
 *   2. Only clicks genuine "Reject All" / "Decline Optional" / "Necessary Only" buttons.
 *   3. If only "Accept" is present or decline requires deep multi-step menus, falls back
 *      to cosmetic banner hiding WITHOUT accepting tracking.
 *   4. Restores document scrollbars if CMP sets overflow: hidden.
 */
(() => {
  const CONSENT_GUARD = '__auvyq_consent_guard_init__';
  if (Object.prototype.hasOwnProperty.call(window, CONSENT_GUARD)) return;
  try {
    Object.defineProperty(window, CONSENT_GUARD, { value: 1, writable: false, enumerable: false, configurable: false });
  } catch {
    // non-fatal
  }

  if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

  const CMP_CATALOG = [
    {
      name: 'OneTrust',
      bannerSelector: '#onetrust-banner-sdk',
      rejectButton: '#onetrust-reject-all-handler',
      dismissSelectors: ['#onetrust-banner-sdk', '.onetrust-pc-dark-filter']
    },
    {
      name: 'Cookiebot',
      bannerSelector: '#CybotCookiebotDialog',
      rejectButton: '#CybotCookiebotDialogBodyButtonDecline',
      dismissSelectors: ['#CybotCookiebotDialog', '#CybotCookiebotDialogBodyUnderlay']
    },
    {
      name: 'Didomi',
      bannerSelector: '#didomi-host, #didomi-notice',
      rejectButton: '#didomi-notice-disagree-button, button#didomi-notice-disagree-button',
      dismissSelectors: ['#didomi-host', '#didomi-popup']
    },
    {
      name: 'Klaro',
      bannerSelector: '.klaro .cookie-notice, .klaro .cookie-modal',
      rejectButton: '.klaro .cn-decline, .klaro button[data-action="decline"]',
      dismissSelectors: ['.klaro']
    },
    {
      name: 'Quantcast',
      bannerSelector: '.qc-cmp2-container, #qc-cmp2-container',
      rejectButton: '.qc-cmp2-summary-buttons button[mode="secondary"], button[data-testid="qc-cmp-reject-all"]',
      dismissSelectors: ['.qc-cmp2-container', '#qc-cmp2-container']
    },
    {
      name: 'Complianz',
      bannerSelector: '.cmplz-cookiebanner',
      rejectButton: '.cmplz-btn.cmplz-deny',
      dismissSelectors: ['.cmplz-cookiebanner']
    },
    {
      name: 'Axeptio',
      bannerSelector: '#axeptio_overlay',
      rejectButton: 'button[data-axeptio-action="refuse"]',
      dismissSelectors: ['#axeptio_overlay']
    }
  ];

  const GENERIC_REJECT_PATTERNS = [
    /\b(reject all|decline all|only necessary|refuse all|alle ablehnen|nur notwendige|tout refuser|rechazar todo|rifiuta tutti|niekeurige)\b/i
  ];

  let handled = false;

  function restoreScroll() {
    try {
      if (document.body && (document.body.style.overflow === 'hidden' || document.body.style.position === 'fixed')) {
        document.body.style.removeProperty('overflow');
        document.body.style.removeProperty('position');
      }
      if (document.documentElement && document.documentElement.style.overflow === 'hidden') {
        document.documentElement.style.removeProperty('overflow');
      }
    } catch {
      // non-fatal
    }
  }

  function cosmeticallyHideBanner(selectors) {
    try {
      const style = document.createElement('style');
      style.textContent = `${selectors.join(', ')} { display: none !important; opacity: 0 !important; pointer-events: none !important; visibility: hidden !important; }`;
      (document.head || document.documentElement).appendChild(style);
      restoreScroll();
    } catch {
      // non-fatal
    }
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    try {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    } catch {
      return true;
    }
  }

  function evaluateConsent() {
    if (handled) return;

    // 1. Check known CMP catalog
    for (const cmp of CMP_CATALOG) {
      const banner = document.querySelector(cmp.bannerSelector);
      if (banner && isElementVisible(banner)) {
        // Find reject button
        const rejectBtn = document.querySelector(cmp.rejectButton);
        if (rejectBtn && typeof rejectBtn.click === 'function') {
          // Double-check button text does not contain "Accept"
          const btnText = (rejectBtn.innerText || rejectBtn.textContent || '').trim().toLowerCase();
          if (!btnText.includes('accept') && !btnText.includes('allow') && !btnText.includes('agree')) {
            rejectBtn.click();
            handled = true;
            restoreScroll();
            return;
          }
        }

        // If reject button wasn't found or was hidden, hide banner cosmetically WITHOUT accepting
        cosmeticallyHideBanner(cmp.dismissSelectors);
        handled = true;
        return;
      }
    }

    // 2. Generic banner detection with safe text matching
    const potentialBanners = document.querySelectorAll('[id*="cookie"], [class*="cookie"], [id*="consent"], [class*="consent"]');
    for (const banner of potentialBanners) {
      if (!banner || banner.tagName === 'BODY' || banner.tagName === 'HTML' || !isElementVisible(banner)) continue;
      const rect = banner.getBoundingClientRect();
      if (rect.height < 40 || rect.width < 200) continue;

      // Scan buttons inside banner
      const buttons = banner.querySelectorAll('button, a[role="button"], input[type="button"]');
      for (const btn of buttons) {
        const text = (btn.innerText || btn.textContent || '').trim();
        for (const pattern of GENERIC_REJECT_PATTERNS) {
          if (pattern.test(text)) {
            btn.click();
            handled = true;
            restoreScroll();
            return;
          }
        }
      }
    }
  }

  // Initial check
  evaluateConsent();

  // MutationObserver for late-injected banners
  if (!handled && typeof MutationObserver !== 'undefined') {
    let timeoutId = null;
    const observer = new MutationObserver(() => {
      if (handled) {
        observer.disconnect();
        return;
      }
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        evaluateConsent();
        if (handled) observer.disconnect();
      }, 250);
    });

    try {
      observer.observe(document.body || document.documentElement, {
        childList: true,
        subtree: true
      });
      // Safety disconnect after 8 seconds to free observer resources
      setTimeout(() => observer.disconnect(), 8000);
    } catch {
      // non-fatal
    }
  }
})();
