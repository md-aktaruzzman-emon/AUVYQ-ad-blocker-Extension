# AUVYQ — Part 1: Pre-Implementation Verification Report

**Document ID:** `AUV-IMP-PART1-001`  
**Phase:** Part 1 — Pre-Implementation Verification, Project Safety & Baseline  
**Evaluation Target:** Previous 15 Audit Deliverables (`docs/2026-modernization-audit/`) vs. Actual Source Code & Official Specs  
**Date:** November 2026  
**Auditor Roles:** Senior Browser Extension Engineer, Lead Security Auditor, Principal Systems Specialist  

---

## 1. Executive Summary of Verification Findings

The pre-implementation verification of the 15 audit deliverables revealed that while the high-level diagnosis of AUVYQ's strengths and weaknesses was directionally sound, **several critical technical claims and implementation recommendations in the original audit were inaccurate, incomplete, or technically risky**.

This report corrects those inaccuracies against the actual source code and current official browser specifications before any implementation commences.

```
+-----------------------------------------------------------------------------------------------------------------+
|                               VERIFICATION SCORECARD: PREVIOUS AUDIT CLAIMS                                     |
+-------------------------------------+-------------------+-------------------------------------------------------+
| Audit Claim / Recommendation        | Verification State| Actual Technical Reality                              |
+-------------------------------------+-------------------+-------------------------------------------------------+
| A. DNR Ruleset Limit (300k static)  | PARTIALLY FLAWED  | Chrome guarantees 30,000 static rules per extension;  |
|                                     |                   | 300,000 is a shared global pool across all extensions.|
| B. Quota Limit (4,500 dynamic cap)  | MISUNDERSTOOD     | 30k safe dynamic rules allowed (Chrome 121+), but     |
|                                     |                   | unsafe dynamic rules (redirect/headers) capped at 5k. |
| C. declarativeNetRequestFeedback    | OVERSTATED        | Not automatically rejected in CWS; however,           |
|                                     |                   | onRuleMatchedDebug only fires in unpacked mode!       |
| D. Development Key Exposure         | FACTUALLY WRONG   | DEV_VERIFY_KEY_JWK is a public key, not a private key;|
|                                     |                   | contains NO private signing material whatsoever.      |
| E. YouTube 16x Playback Hack        | HARMFUL / REJECTED| Arbitrary 16x speed & currentTime jumps crash player, |
|                                     |                   | desync audio, and break playback. Scriptlets needed.  |
| F. Built-in AI (window.ai)          | IMMATURE / FLAWED | window.ai is experimental and unavailable in cross-   |
|                                     |                   | browser environments; Prompt API needs origin trial.  |
| G. Static Rule Count (217 rules)    | VERIFIED ACCURATE | Exactly 217 static rules across 5 JSON files. In      |
|                                     |                   | addition, 132 builtin cosmetic selectors exist.       |
+-------------------------------------+-------------------+-------------------------------------------------------+
```

---

## 2. In-Depth Technical Verification & Corrections

### A. Declarative Net Request (DNR) Ruleset Quotas & Limits

#### 1. The Audit's Claim:
The previous audit claimed that AUVYQ can immediately expand to 5 static rulesets of 30,000 rules each (150,000 rules) up to 300,000 static rules, and that the 4,500 dynamic rule limit in `quota.ts` is simply outdated.

#### 2. Actual Code Inspection:
- `extension/core/quota-manager/quota.ts` line 9: `export const SAFE_DYNAMIC_CAPACITY = 4500;`.
- `extension/manifest.json` lines 65–93 declares 5 ruleset resources: `main`, `ads`, `trackers`, `annoyances`, `ads-trackers`. All 5 are `"enabled": true`.

#### 3. Official Chrome DNR Specifications (Chrome 120–135+):
Based on official Chrome Extension documentation (`chrome.declarativeNetRequest`):
- **`MAX_NUMBER_OF_STATIC_RULESETS`**: **100** rulesets can be declared in `manifest.json`.
- **`MAX_NUMBER_OF_ENABLED_STATIC_RULESETS`**: **50** rulesets can be enabled simultaneously.
- **`GUARANTEED_MINIMUM_STATIC_RULES`**: **30,000 rules total** guaranteed across all enabled static rulesets for a single extension.
  - *Correction:* Chrome does **NOT** guarantee 150,000 or 300,000 static rules per extension. The 300,000 limit is a global browser pool shared across all installed extensions. If another extension consumes pool rules, enabling rulesets exceeding 30,000 rules will fail unless verified at runtime via `chrome.declarativeNetRequest.getAvailableStaticRuleCount()`.
- **`MAX_NUMBER_OF_DYNAMIC_RULES`**: **30,000** safe rules (introduced in Chrome 121).
- **`MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES`**: **5,000** rules.
  - *Correction:* "Unsafe" dynamic rules are those that redirect requests or modify headers (such as `$removeparam` or local resource redirects). They count against the 5,000 limit.
  - Therefore, raising `SAFE_DYNAMIC_CAPACITY` in `quota.ts` to 28,000 is **only valid for pure block/allow rules**. If rules include redirects, they will violate the 5,000 unsafe rule limit and trigger an exception.
- **`MAX_NUMBER_OF_SESSION_RULES`**: **5,000** session-scoped rules.
- **`MAX_NUMBER_OF_REGEX_RULES`**: **1,000** regular expression rules total across all rulesets.

---

### B. `declarativeNetRequestFeedback` Permission Analysis

#### 1. The Audit's Claim:
The audit claimed that `declarativeNetRequestFeedback` triggers automatic Chrome Web Store rejection and should be stripped immediately.

#### 2. Actual Code Inspection:
- `extension/manifest.json` line 17: `"declarativeNetRequestFeedback"`.
- `extension/platform-chrome/request-observer/observer.ts` lines 140–157:
  ```typescript
  // Precise blocked-rule counting in unpacked/development builds.
  if (chrome.declarativeNetRequest.onRuleMatchedDebug !== undefined) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => { ... });
  }
  ```

#### 3. Verified Technical Reality:
- In Google Chrome, `chrome.declarativeNetRequest.onRuleMatchedDebug` is **only available for unpacked extensions** loaded in developer mode. In packed extensions distributed through the Chrome Web Store, `onRuleMatchedDebug` is undefined and does not fire.
- The AUVYQ codebase already contains a defensive check (`if (chrome.declarativeNetRequest.onRuleMatchedDebug !== undefined)`) and documents this in code comments.
- **Marketplace Implication:** Requesting `declarativeNetRequestFeedback` in a production store build does not provide blocked rule telemetry in production, but causes Chrome Web Store automated reviewers to flag the extension for heightened scrutiny regarding user browsing visibility.
- **Corrected Decision:** Maintain separate manifest targets: keep `declarativeNetRequestFeedback` in a development manifest for debugging, but remove it from the production store manifest.

---

### C. Development Signing Key (`DEV_VERIFY_KEY_JWK`)

#### 1. The Audit's Claim:
The audit repeatedly asserted: *"Hardcoded dev signing key in channel.ts; if an attacker extracts the dev private key from the code, they can sign rogue updates."*

#### 2. Actual Code Inspection:
`extension/core/update-channel/channel.ts` lines 17–24:
```typescript
export const DEV_VERIFY_KEY_JWK = {
  crv: 'P-256',
  ext: true,
  key_ops: ['verify'],
  kty: 'EC',
  x: 'K2hKGuIXDdm-9JMKrvGHXIa9yc4Py8PFGhMScfBWmbk',
  y: 'cCzTHgf3BxaSkGZ9myF6ZBIOSKkYy2pXT2N3HxQGm88'
} as const;
```

#### 3. Cryptographic Verification:
- Under RFC 7517 and RFC 7518 (JSON Web Key standards for Elliptic Curve Cryptography), an ECDSA P-256 public key consists of parameters `kty`, `crv`, `x`, and `y`.
- A private key requires the secret scalar `d`.
- `DEV_VERIFY_KEY_JWK` contains **only `x` and `y`** and declares `key_ops: ['verify']`. It is **strictly a public key**.
- There is **zero private key material** in the codebase.
- **Why the comment says "REPLACE BEFORE PRODUCTION":** The author noted this because if the corresponding private key was used in public testing or committed in early repository history, someone who has that offline private key could sign filter updates.
- **Corrected Decision:** The task is **NOT** to remove the verification key (which would break update verification), but to generate a fresh offline production keypair, store the private key in a secure offline vault/HSM, and replace the public coordinates (`x`, `y`) before release.

---

### D. Video Ad Filtering (YouTube & SSAI)

#### 1. The Audit's Recommendation:
The audit recommended implementing a 16x video rate accelerator on HTML5 `<video>` elements, muting audio, and seeking `video.currentTime = video.duration` during ad segments.

#### 2. Technical Evaluation & Flaw Analysis:
- Forcing `video.playbackRate = 16.0` and jumping `currentTime` directly on YouTube or Twitch:
  1. Triggers player desynchronization between the MediaSource audio/video buffers.
  2. Frequently causes player crashes with Error 5000 or infinite loading spinners.
  3. Triggers YouTube's client-side anti-adblock detection scripts that monitor abnormal timeline jumps.
  4. If the ad segment boundary detection has a 500ms error, it skips into the user's actual video content.
- **Safer, Proven Industry Alternatives:**
  - YouTube ad blocking in uBlock Origin and AdGuard relies on:
    - Declarative network blocking of Google ad delivery endpoints.
    - Scriptlet injection that cleanses `ytInitialPlayerResponse.adPlacements` and `playerAds` before the player initializes.
    - Stubbing Google IMA SDK (`window.google.ima`).
- **Corrected Decision:** **REJECT** the 16x video acceleration hack. Adopt standard declarative network filters and player JSON sanitization scriptlets.

---

### E. Anti-Fingerprinting & Leaked Globals

#### 1. Code Inspection:
- `extension/content/fp-shields.js` line 11: `window.__auvyqFpActive = true;` (runs in `MAIN` world).
- `extension/content/scriptlet-dispatch.js` line 11: `window.__auvyqDispatchActive = true;` (runs in `MAIN` world).
- `extension/content/cosmetic-injector.js` lines 122 & 137: `style.setAttribute('data-auvyq', 'cosmetic')` and `style.setAttribute('data-auvyq', 'cosmetic-builtin')`.
- `extension/content/fp-shields.js` lines 13–25: LCG PRNG seeded by `location.hostname` adding deterministic noise (-1, 0, +1) to canvas pixel readbacks.

#### 2. Verification Finding:
- **Verified Accurate:** These global variables and DOM attributes are directly readable by webpage scripts, creating a trivial anti-adblock detection vector.
- **Canvas Noise Flaw:** The deterministic PRNG noise produces a static, repeatable hash delta for each domain. Commercial fingerprinting scripts (e.g., FingerprintJS Pro) detect this as canvas tampering, ironically making the user *more* unique than standard unshielded browsers.
- **Corrected Decision:** Remove all `window.__auvyq*` properties and `data-auvyq` DOM attributes. Switch fingerprint defense to property normalization (e.g., standardizing `navigator.hardwareConcurrency` to 4 or 8) rather than noisy pixel scrambling.

---

### F. AI & Machine Learning Integration

#### 1. Code Inspection:
`extension/core/ml/classify.ts` lines 16–25:
```typescript
export let activeRiskModel: RiskModel | null = null;
export function classify(url: string, domFeatures: DomFeatures): RiskResult {
  return assessThreat({ ...domFeatures, url });
}
```
`activeRiskModel` is `null`.

#### 2. Current Chrome Built-in AI Status:
- The Prompt API (`chrome.aiOriginTrial.languageModel` or `window.ai`) is currently an experimental capability requiring an Origin Trial token (`aiLanguageModelOriginTrial`) and compatible local hardware.
- It is **not supported** in Firefox or Safari.
- Making core extension protection dependent on Chrome Built-in AI would introduce a critical cross-browser failure.
- **Corrected Decision:** Keep the deterministic `tier1.ts` heuristics as the primary, zero-latency defense. Local ML must remain an optional, progressive enhancement (e.g., via a self-contained 180KB ONNX WebAssembly model in `offscreen.ts`), never a mandatory runtime dependency.

---

### G. Ruleset Count Verification

#### 1. Forensic Verification:
We inspected all JSON rulesets in `extension/rules/`:
- `rules/ads-trackers.json`: **10** rules (10 block)
- `rules/annoyances.json`: **12** rules (12 block)
- `rules/easylist.json`: **78** rules (71 block, 7 redirect)
- `rules/easyprivacy.json`: **69** rules (67 block, 2 allow)
- `rules/main.json`: **48** rules (35 block, 13 redirect)
- **Total Static Declarative Net Request Rules:** **Exactly 217 rules**.

#### 2. Additional Component Rules Discovered:
- Built-in generic cosmetic selectors in `extension/content/cosmetic-injector.js`: **132 selectors** in `BUILTIN_SELECTORS`.
- Vendor reference lists in `extension/vendor/lists/`:
  - `annoyances.txt`: 47 active lines
  - `easylist.txt`: 175 active lines
  - `easyprivacy.txt`: 69 active lines
- Dynamic rules bundled: **0** (dynamic rules are empty on fresh install).

---

## 3. Official References & Documentation Sources

| Subject | Official Source URL | Verification Date |
| :--- | :--- | :--- |
| **Chrome Declarative Net Request** | `https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest` | Nov 2026 |
| **Chrome Dynamic Rule Limits (v121+)** | `https://developer.chrome.com/docs/extensions/how-to/integrate/declarative-net-request` | Nov 2026 |
| **Chrome onRuleMatchedDebug** | `https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#event-onRuleMatchedDebug` | Nov 2026 |
| **Mozilla WebExtensions DNR** | `https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest` | Nov 2026 |
| **Chrome Built-in AI (Prompt API)** | `https://developer.chrome.com/docs/extensions/ai/prompt-api` | Nov 2026 |
| **OWASP Password Storage** | `https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html` | Nov 2026 |

*Proceed to `PART_01_BASELINE_REPORT.md` for baseline execution results.*
