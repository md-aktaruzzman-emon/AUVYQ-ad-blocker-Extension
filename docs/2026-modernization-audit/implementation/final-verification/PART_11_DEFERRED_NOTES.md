# PART 11 — DEFERRED ARCHITECTURE NOTES

**Project**: AUVYQ Modernization 2026  
**Module**: Cross-Browser Architecture & Firefox Compatibility  
**Status**: **PART 11 — DEFERRED_BY_USER**  
**Target Future Milestone**: v0.4.0 (Multi-Engine Release)  
**Date**: November 2026  

---

## 1. Directive & Deferral Rationale

In the Part 12 instructions, the user explicitly commanded:
> *"PART 11 — CROSS-BROWSER ARCHITECTURE & FIREFOX COMPATIBILITY IS DEFERRED. I will work on Firefox and other browser compatibility later. For this current verification: Chrome is the primary target. Verify the Chrome extension completely. Do not begin Firefox implementation. Do not begin Safari implementation. Do not treat Part 11 as a failure. Record it clearly as PART 11 — DEFERRED_BY_USER."*

In accordance with this directive:
- **No Firefox or Safari code was written or modified** in this release cycle.
- **Chrome MV3 remains the sole target platform** for v0.3.0-rc1.
- This document compiles the comprehensive technical roadmap, architectural differences, and integration blueprint required when Part 11 implementation commences.

---

## 2. Platform Comparison: Chrome MV3 vs. Firefox (Gecko)

When extending AUVYQ to Mozilla Firefox, the following architectural divergence points must be addressed:

| Architectural Vector | Google Chrome (Current Target) | Mozilla Firefox (Future Part 11 Target) |
| :--- | :--- | :--- |
| **Manifest Version** | Manifest V3 (Strict) | Manifest V3 (Supported) or MV2 (LTS) |
| **Background Execution** | Ephemeral Service Worker only (`"service_worker"`) | Background Page / Event Page (`"scripts"`) or Service Worker |
| **Extension API Namespace**| `chrome.*` (Callbacks & Promises) | `browser.*` (Standard W3C Promises) |
| **DNS Resolution API** | **None** (Cannot resolve CNAMEs) | `browser.dns.resolve()` supported |
| **Blocking Network Filtering** | `declarativeNetRequest` (Asynchronous) | `declarativeNetRequest` + Blocking `webRequest` |
| **Script World Injection** | `chrome.scripting` (`MAIN` / `ISOLATED`) | `browser.scripting` + `wrappedJSObject` |
| **Cookie Privacy Model** | Chrome Privacy Sandbox / Partitioned | Total Cookie Protection / Containers (`contextualIdentities`) |
| **Offscreen Documents** | `chrome.offscreen` API required for DOM | Full DOM available in background page |

---

## 3. Key Cross-Browser Implementation Blueprints

When beginning Part 11 development, the engineering team should execute against the following blueprints:

### 3.1 Universal API Abstraction Layer

To avoid littering the codebase with `if (isFirefox)` conditionals, implement a unified browser wrapper (`extension/core/compat/browser-shim.ts`):

```typescript
// Proposed Part 11 Browser Wrapper
export const ext = (function () {
  if (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime) {
    return globalThis.browser;
  }
  if (typeof globalThis.chrome !== 'undefined' && globalThis.chrome.runtime) {
    return globalThis.chrome;
  }
  throw new Error('Unsupported browser extension runtime');
})();
```

Alternatively, integrate the official `webextension-polyfill` library during the build phase.

### 3.2 Native CNAME Uncloaking via `browser.dns.resolve()`

In Chrome, AUVYQ is restricted to regex-based heuristics for CNAME tracking cloaks due to platform limitations. In Firefox, AUVYQ can achieve 100% true DNS uncloaking:

```typescript
// Proposed Part 11 Firefox CNAME Resolver
async function resolveTrueHost(hostname: string): Promise<string> {
  if (ext.dns && typeof ext.dns.resolve === 'function') {
    try {
      const record = await ext.dns.resolve(hostname, ['canonical_name']);
      return record.canonicalName || hostname;
    } catch {
      return hostname;
    }
  }
  return hostname;
}
```

### 3.3 Manifest Transformation Pipeline

Implement a multi-target build script (`extension/tools/build-manifest.mjs`) that compiles from a single source directory into browser-specific bundles:

1. **Chrome Target (`dist/chrome-mv3/`)**:
   - Uses `"service_worker": "dist/sw.js"`
   - Specifies `"minimum_chrome_version": "109"`
   - Uses `declarativeNetRequest` rulesets as primary engine
2. **Firefox Target (`dist/firefox-mv3/` or `firefox-mv2/`)**:
   - Uses `"background": { "scripts": ["dist/sw.js"] }`
   - Adds `"browser_specific_settings": { "gecko": { "id": "auvyq@shield.local", "strict_min_version": "109.0" } }`
   - Enables `dns` permission for native CNAME uncloaking

### 3.4 Firefox Contextual Identities (Containers)

Firefox users extensively use Multi-Account Containers. AUVYQ's `cookie-manager.ts` and `badge-manager.ts` should be updated to accept `cookieStoreId` parameters to allow per-container cookie decay rules and independent whitelist configurations.

---

## 4. Part 11 Verification Checklist (For Future Milestone)

When Part 11 is unshelved, verify the following before release:

- [ ] Universal extension API shim passes all 36 existing unit test suites in Node / happy-dom.
- [ ] Manifest transformer generates valid Gecko `manifest.json`.
- [ ] `web-ext lint` completes with 0 errors and 0 warnings.
- [ ] Background event page loads cleanly in Firefox Developer Edition.
- [ ] DNR rulesets compile identically in Firefox without unsupported condition errors.
- [ ] `browser.dns.resolve` uncloaks test CNAME trackers (e.g., Adobe Experience Cloud / Criteo CNAMEs).
- [ ] Multi-Account Containers isolate whitelist preferences properly.
- [ ] AMO (addons.mozilla.org) submission bundle packaged and signed.

---

## 5. Conclusion

Part 11 remains formally deferred by explicit user directive. All necessary research, architectural divergence mapping, and implementation strategies have been documented above, ensuring seamless execution when cross-browser expansion is prioritized.
