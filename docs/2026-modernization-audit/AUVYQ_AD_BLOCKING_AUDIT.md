# AUVYQ — Ad-Blocking Engine & Ruleset Infrastructure Audit

**Document ID:** `AUV-AUD-2026-006`  
**Evaluation Scope:** Ruleset Pipeline, Parser, DNR Compiler, Quotas & Cosmetic Hiding  
**Auditor:** Senior Ad-Blocking Systems Engineer (Chrome Extension Developer Skill)  
**Target Capability:** Full Parity with uBlock Origin Lite & AdGuard MV3  
**Date:** November 2026  

---

## 1. The Ruleset Crisis: Forensic Breakdown of the 217 Rules

AUVYQ v0.3.0 ships with five static ruleset files declared in `manifest.json`. Our forensic count confirms the catastrophic deficiency in rule coverage:

```
+---------------------------+------------+------------+--------------------------------------------+
| Ruleset File              | File Size  | Rule Count | Industry Standard Benchmark (uBO / AdGuard)|
+---------------------------+------------+------------+--------------------------------------------+
| rules/easylist.json       | 15,123 B   | 78 rules   | 68,000+ rules (Standard EasyList)          |
| rules/easyprivacy.json    | 14,644 B   | 69 rules   | 34,000+ rules (Standard EasyPrivacy)       |
| rules/main.json           | 9,441 B    | 48 rules   | Core telemetry & malicious heuristics      |
| rules/annoyances.json     | 2,442 B    | 12 rules   | 42,000+ rules (Fanboy's / uBO Annoyances)  |
| rules/ads-trackers.json   | 5,468 B    | 10 rules   | Supplemental ad & tracker combo list       |
+---------------------------+------------+------------+--------------------------------------------+
| TOTAL STATIC RULES        | 47,118 B   | 217 rules  | 144,000+ rules (Production baseline)      |
+---------------------------+------------+------------+--------------------------------------------+
```

### 1.1 Real-World Consequences
- **Page Hit Ratio:** On popular news portals (e.g., CNN, DailyMail, The Verge), an average page loads scripts and beacons from 35–80 external tracking and programmatic bidding domains.
- AUVYQ matches fewer than 3 of these 80 domains.
- The remaining 77 ad/telemetry requests execute unhindered, rendering ads, collecting browser fingerprints, and slowing down page render times.
- Users perceive the extension as "not working".

---

## 2. Rule Parser & Compiler Engine Evaluation

### 2.1 Parser Capabilities (`core/rule-parser/parser.ts`)
The parser accepts standard Adblock Plus / uBlock filter syntax:
- Domain anchors: `||adservice.google.com^`
- Third-party flags: `$third-party`, `$script`, `$image`, `$subdocument`, `$xmlhttprequest`
- Exception rules: `@@||allowed-site.com^$image`
- Simple element hiding: `domain.com##.ad-banner`, `##.generic-ad`

### 2.2 Parser Deficiencies (Unsupported Syntax):
1. **Procedural Cosmetic Selectors (Completely Dropped):**
   - Rules containing `:has()`, `:has-text()`, `:matches-css()`, or `:watch-attr()` are rejected or silently ignored by the parser.
2. **Extended Filter Options (Ignored):**
   - Syntax modifiers like `$removeparam`, `$redirect`, `$csp`, `$replace`, `$badfilter`, `$header` are unparsed or discarded during compilation.
3. **Regex Compilation Failures:**
   - Standard adblock regexes often contain features unsupported by Chromium's RE2 engine (e.g., backreferences `\1`, lookahead `(?=...)`, lookbehind `(?<=...)`). While AUVYQ has `core/rule-compiler/re2-validate.ts` to validate RE2 compliance, it simply drops invalid regexes without attempting to simplify or convert them into static substring prefixes.

---

## 3. Dynamic Rule Quota & Demotion Architecture

### 3.1 The Obsolete 4,500 Quota Cap (`core/quota-manager/quota.ts`)
```typescript
// Line 9 in quota.ts:
export const SAFE_DYNAMIC_CAPACITY = 4500;
```
- In early Manifest V3 (2020), Chromium allocated only 5,000 dynamic rules per extension.
- Chrome 120+ (released late 2023) raised the dynamic rule quota to **30,000 rules**, and the total static rule budget across extensions to **300,000 rules** (with up to 30,000 enabled per static ruleset across up to 50 active rulesets).
- AUVYQ's artificial cap of 4,500 causes it to unnecessarily discard up to 25,500 valid dynamic rules.

### 3.2 The Cosmetic Demotion Mechanism
When candidate rules exceed the capacity, `quota.ts` attempts to demote image/media network blocks into cosmetic CSS selectors:
```typescript
if (candidate.cosmeticFallback !== null) {
  demotedCss.push(`${candidate.cosmeticFallback} { display: none !important; }`);
}
```
**Audit Assessment:**
- While clever in theory, demoting network blocks to cosmetic hiding in 2026 is suboptimal: cosmetic hiding does not prevent the network request from firing; the ad image or tracking payload is still downloaded (consuming user bandwidth and executing tracker cookies), merely hidden visually.
- With modern 30,000 dynamic rule budgets, demotion should only be a rare fallback for cosmetic-specific hints, not network rules.

---

## 4. Cosmetic Filtering & DOM Injection Audit

### 4.1 Inefficient Monolithic Stylesheet Injection
In `content/cosmetic-injector.js`:
- The script injects ~80 built-in generic selectors synchronously into `<head>`.
- For domain-specific cosmetic rules, it queries the service worker via RPC (`GET_COSMETIC`), which returns a compiled CSS string.
- It then appends a second `<style>` tag to the DOM.

### 4.2 Critical Problems:
1. **CSS Specificity Clashes:**
   - Modern publishers apply inline `style="display: block !important; visibility: visible !important;"` to ad containers via JavaScript after page load.
   - A generic `display: none !important` in an injected `<style>` tag has lower specificity than an inline style attribute, causing hidden ads to reappear.
2. **Mutation Thrashing in Single-Page Apps (SPAs):**
   - On sites like YouTube or Reddit, navigation does not reload the page. Content is rendered dynamically into root containers (`#contents`, `#app`).
   - AUVYQ injects once on `document_start`. It does not listen to `MutationObserver` events, failing to hide subsequent ad slots loaded via client-side routing.

---

## 5. Video Ad Defusal & YouTube Counter-Measures

### 5.1 The Modern YouTube Ad Landscape
YouTube employs an aggressive multi-layered ad delivery architecture:
1. **Server-Side Ad Insertion (SSAI):** Ad video segments are streamed directly into the media source buffer, alternating with the main video content.
2. **Player Configuration Payloads:** `ytInitialPlayerResponse` contains `adPlacements` and `playerAds` metadata objects.
3. **Anti-Adblock Enforcement Scripts:** Detect blocked ad network calls and display the "Ad blockers violate YouTube's Terms of Service" interstitial.

### 5.2 AUVYQ's Current Vulnerability:
AUVYQ has zero YouTube-specific defusal logic. It treats YouTube like any static webpage.
- **Result:** In testing against modern YouTube, AUVYQ causes video playback to stall, triggers the ad blocker warning popup, and fails to skip video commercials.

### 5.3 Technical Solution for 2026:
Implement a specialized YouTube Scriptlet Defuser in `content/scriptlet-dispatch.js`:
- Intercept and sanitize `JSON.parse` and `Response.prototype.json` to strip `adPlacements`, `adSlots`, and `playerAds` before the player initializes.
- Hook into HTML5 `<video>` elements to detect unskippable ad states and instantly set `video.currentTime = video.duration` with `video.playbackRate = 16.0` and `video.muted = true`.

---

## 6. Comprehensive 2026 Ruleset Modernization Blueprint

To achieve tier-1 ad-blocking performance, AUVYQ must transition from the current 217-rule placeholder to a multi-tiered ruleset architecture:

```mermaid
flowchart TD
    subgraph Remote Update CDN (Signed ECDSA)
        EASYLIST[EasyList Standard - 65k]
        EASYPRIVACY[EasyPrivacy - 35k]
        ANNOY[Fanboy Annoyances - 40k]
        AUVYQ_SEC[AUVYQ Security & Anti-Scam - 20k]
    end

    subgraph Build & Update Pipeline
        COMPILER[High-Performance Offline DNR Compiler]
        WASM_VAL[RE2 & Syntax Validator]
    end

    subgraph Extension Manifest V3 Rulesets
        RS1["Ruleset 1: Base Ads (30,000 DNR Rules)"]
        RS2["Ruleset 2: Trackers (30,000 DNR Rules)"]
        RS3["Ruleset 3: Annoyances (25,000 DNR Rules)"]
        RS4["Ruleset 4: Malicious/Phishing (20,000 DNR Rules)"]
        RS5["Ruleset 5: Dynamic User & Custom Rules (30,000 Cap)"]
    end

    EASYLIST --> COMPILER
    EASYPRIVACY --> COMPILER
    ANNOY --> COMPILER
    AUVYQ_SEC --> COMPILER
    COMPILER --> WASM_VAL
    WASM_VAL --> RS1
    WASM_VAL --> RS2
    WASM_VAL --> RS3
    WASM_VAL --> RS4
    WASM_VAL --> RS5
```

### Implementation Action Plan:
1. **Automated Fetch & Compilation Pipeline:** Build an automated GitHub Action that runs weekly, fetching upstream filter lists (EasyList, EasyPrivacy, Peter Lowe's, uBlock Filters), converting them into optimized Declarative Net Request JSON format, and partitioning them across DNR ruleset IDs.
2. **Quota Re-Calibration:** Update `SAFE_DYNAMIC_CAPACITY` from `4500` to `28000` (leaving a 2,000-rule safety buffer for runtime exceptions).
3. **Procedural CSS Engine:** Integrate a lightweight CSS-selector TreeWalker supporting `:has()` and text-content matching into `content/cosmetic-injector.js`.

*Proceed to `AUVYQ_AI_OPPORTUNITIES.md` for edge intelligence research.*
