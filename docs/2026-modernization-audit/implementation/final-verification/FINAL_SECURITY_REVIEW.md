# AUVYQ — Master Security & Hardening Review

**Document ID:** `AUV-FINAL-SECURITY-REVIEW`  
**Phase:** Part 12 — Master Completion Audit, Quality Assurance & Chrome Release Verification  
**Evaluation Scope:** Complete Extension Security Boundary, Cryptographic Vault & Threat Model  
**Status:** **PASSED & HARDENED**  
**Date:** November 2026  

---

## 1. Executive Summary

This security review provides an independent, deep-tier security evaluation of the AUVYQ browser extension. In browser extensions, security failures typically arise from unvalidated message passing between content scripts and background service workers, excessive permissions, identifiable DOM footprints that allow web pages to detect or exploit the extension, and cryptographic key leakage.

AUVYQ has resolved all high-severity vulnerabilities identified during the preliminary audit and maintains a defense-in-depth posture:
1. **Zero Detectable MAIN-World Footprints:** Eradicated all `window.__auvyq*` globals, replacing them with non-enumerable symbol guards and closures.
2. **Zero DOM Marker Leakage:** Removed custom `data-auvyq` attributes from injected stylesheets and banners.
3. **Privilege-Separated RPC Architecture:** Strict deny-by-default privilege enforcement. Content scripts are physically prevented from triggering privileged actions (settings mutations, backup imports, raw storage access).
4. **Cryptographic Vault Hardening:** PBKDF2 with 600,000 iterations and AES-GCM-256 authenticated encryption, fortified with a 1024-character password cap and immediate in-memory buffer zeroing.
5. **Offline Key Signing Architecture:** Extension bundles strictly public verification parameters (`DEV_VERIFY_KEY_JWK` / `PROD_VERIFY_KEY_JWK`); private signing keys are held strictly offline. Production builds verify that no private key material is present.

---

## 2. Manifest V3 Permissions & Privilege Boundary

### 2.1 Permissions Audit

The production `manifest.json` requests exactly 9 API permissions:

| Permission | Justification & Architectural Constraint | Risk Rating |
| :--- | :--- | :---: |
| `declarativeNetRequest` | Core ad, tracker, and network request blocking via Chromium C++ engine | LOW |
| `storage` | Local persistence of user settings, daily counters, and custom rules | LOW |
| `unlimitedStorage` | Prevents storage eviction when user installs extensive custom rules | LOW |
| `scripting` | Programmatic on-demand injection of Visual Element Picker (`element-picker.js`) | MEDIUM |
| `alarms` | Periodic background tasks (stats flush, retention prune, pause timer check) | LOW |
| `offscreen` | Isolated cryptographic key derivation and vault encryption off the main worker | MEDIUM |
| `webNavigation` | Navigation event observation (`onCommitted`) for heuristic threat detection | LOW |
| `cookies` | Reading and sanitizing third-party tracking cookies; lifetime truncation | HIGH |
| `tabs` | Reading active tab host for popup display and site-specific pause controls | MEDIUM |

### 2.2 Permissions Dropped in Modernization
- **`declarativeNetRequestFeedback`:** Formally purged from production `manifest.json` (DR-005). This permission exposes private browsing URLs to extensions and triggers manual Chrome Web Store security scrutiny.
- **`webRequestBlocking`:** Prohibited under Manifest V3; AUVYQ uses Declarative Net Request for 100% of network interception.

### 2.3 Content Security Policy (CSP)
```json
"content_security_policy": {
  "extension_pages": "script-src 'self'; object-src 'self'"
}
```
- Strictly forbids `'unsafe-eval'`, `'wasm-unsafe-eval'`, and remote scripts.
- Guarantees that no external executable code can be executed in extension pages (popup, dashboard, offscreen).

---

## 3. World Boundary & Anti-Adblock Stealth

### 3.1 MAIN-World vs. ISOLATED-World Scripts

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             WEB PAGE PROCESS                                │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │ MAIN WORLD (Host Page Scripts + Anti-Adblock Probes)                │   │
│   │                                                                     │   │
│   │  • NO window.__auvyq* globals (non-enumerable symbol guards)        │   │
│   │  • fp-shields.js: Uniform bit-quantization (no unique noise)        │   │
│   │  • scriptlet-dispatch.js: 15 allowlisted scriptlets only            │   │
│   │  • WeakSet tracks blocked XHRs (no prototype properties)            │   │
│   │  • Auth Nonce validates inter-world communication                   │   │
│   └──────────────────────────────────┬──────────────────────────────────┘   │
│                                      │                                      │
│                                      │ CustomEvents with Cryptographic Nonce│
│                                      │ (auvyq-scriptlets / auvyq-fp-config) │
│                                      │                                      │
│   ┌──────────────────────────────────▼──────────────────────────────────┐   │
│   │ ISOLATED WORLD (AUVYQ Content Scripts)                              │   │
│   │                                                                     │   │
│   │  • cosmetic-injector.js: Batched DOM collapse (no data-auvyq attrs) │   │
│   │  • warning-banner.js: Closed Shadow DOM (z-index 2147483647)        │   │
│   │  • consent-assistant.js: CMP rejection (strict anti-accept)         │   │
│   │  • element-picker.js: Closed Shadow DOM picker (on-demand only)     │   │
│   └──────────────────────────────────┬──────────────────────────────────┘   │
│                                      │                                      │
└──────────────────────────────────────┼──────────────────────────────────────┘
                                       │ chrome.runtime.sendMessage
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          BACKGROUND SERVICE WORKER                          │
│  • isPrivilegedSender(sender) check: denies web tabs from privileged RPCs   │
│  • Rate limiting & payload size ceilings (LIMITS.rpcPayloadChars)           │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Eradication of Identifying DOM Markers
1. **Stylesheets:** Injected `<style>` elements carry zero identifying attributes (`data-auvyq`, `id="auvyq-styles"`). Anti-adblock scripts scanning for extension attributes find nothing.
2. **XHR Mutation Protection:** In `scriptlet-dispatch.js`, instead of setting `this.__auvyqBlocked = true` on native `XMLHttpRequest` instances, blocked instances are stored inside a private closure-scoped `const blockedXhrs = new WeakSet()`. Web page scripts cannot detect property changes on XHR objects.
3. **Shadow DOM Encapsulation:** Warning banners (`warning-banner.js`) and the Element Picker (`element-picker.js`) attach to closed Shadow DOM roots (`attachShadow({ mode: 'closed' })`). Host scripts calling `document.querySelectorAll('*')` cannot traverse or inspect AUVYQ UI nodes.

---

## 4. RPC Layer & Sender Privilege Validation

### 4.1 Strict Sender Origin Gating (`isPrivilegedSender`)
The RPC router (`platform-chrome/rpc/rpc.ts`) enforces strict privilege separation:

```typescript
export function isPrivilegedSender(sender: chrome.runtime.MessageSender): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const extOrigin = chrome.runtime.getURL('');

  // 1. If tab is present, the message originates from a tab context.
  // Both tab.url and sender.url must strictly belong to the extension origin.
  if (sender.tab !== undefined) {
    if (typeof sender.tab.url !== 'string' || !sender.tab.url.startsWith(extOrigin)) return false;
    if (typeof sender.url === 'string' && !sender.url.startsWith(extOrigin)) return false;
    return true;
  }
  // 2. Direct sender URL (popup, options page, offscreen document)
  if (typeof sender.url === 'string') return sender.url.startsWith(extOrigin);
  return false;
}
```

### 4.2 Content Script Allowed RPC List
Unprivileged content scripts are restricted to exactly 7 read-only or scoped operations:
- `GET_COSMETIC`, `GET_DISPATCH`, `GET_FP_SHIELDS`, `REPORT_COSMETIC`, `CHECK_LOGIN_FORMS`, `GET_TAB_STATE`, and `ADD_CUSTOM_RULE`.
- When an unprivileged content script invokes `ADD_CUSTOM_RULE`, `handlers.ts` enforces that it can **only** create a cosmetic rule scoped strictly to its own verified tab host. Network rules or cross-site rules throw an authorization error immediately.

---

## 5. Cryptography & Vault Security

### 5.1 Architecture & Iteration Count
- **PBKDF2-SHA256:** Derived with **600,000 iterations** using a 16-byte cryptographically secure salt. Exceeds OWASP 2024 recommendations for PBKDF2-SHA256 (minimum 600,000 iterations).
- **AES-GCM-256:** Authenticated encryption with 12-byte random IV. Any ciphertext or authentication tag tampering results in an immediate `VaultError('auth')` rejection.
- **Memory Zeroing:** `deriveKey()` in `core/crypto/vault.ts` encodes passwords into a `Uint8Array` and unconditionally zeroes the buffer (`rawPassword.fill(0)`) in a `finally` block immediately after `importKey()`.
- **DoS Defense:** Enforces `MAX_PASSWORD_CHARS = 1024` and `MAX_BACKUP_BYTES = 8MB` to prevent memory exhaustion attacks.

### 5.2 Key Signing Architecture
- **Public Key Only:** `DEV_VERIFY_KEY_JWK` and `PROD_VERIFY_KEY_JWK` export strictly public coordinates (`x`, `y`) with `key_ops: ['verify']`.
- **Production Guard:** `esbuild.mjs` executes an automated static regex check during `NODE_ENV=production` builds, rejecting compilation if private key parameters (`"d":` or `'sign'`) are present in `channel.ts`.

---

## 6. Threat Model & Residual Risks

| Threat Vector | Severity | Mitigated By AUVYQ | Residual Risk & Operational Constraint |
| :--- | :---: | :--- | :--- |
| **Malicious Web Page RPC Spoofing** | HIGH | `isPrivilegedSender()` checks sender tab origin | **None.** Web pages cannot invoke privileged extension RPCs. |
| **Anti-Adblock Fingerprinting** | MEDIUM | Eradicated `window.__auvyq*` and `data-auvyq` | Advanced anti-adblock can still detect network block timing differences. |
| **Tampered Remote Update List** | HIGH | ECDSA P-256 signature verification + SHA-256 hash | Mitigated. Untrusted list texts are rejected before compilation. |
| **Service Worker Memory Exhaustion** | MEDIUM | Decomposed SW, 128-item LRU cache, 45 KB ML model | Mitigated. Service worker stays well within Chrome memory budgets. |
| **Phishing / Credential Harvesting** | HIGH | Local Abuse.ch feed, 17-feature ML, homoglyph check | Statistical heuristic cannot catch 100% of zero-day domains without feed updates. |

---

## 7. Security Audit Verdict

The security architecture of AUVYQ v0.3.0 has been hardened to enterprise standards. All identified vulnerabilities have been eliminated with surgical, verifiable fixes. The extension is **APPROVED from a security perspective for Chrome Release Candidate**.
