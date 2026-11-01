# AUVYQ — 2026 Implementation Roadmap & Engineering Plan

**Document ID:** `AUV-AUD-2026-012`  
**Evaluation Scope:** Prioritized Development Phases, Task IDs, Dependencies, Complexity & Acceptance Criteria  
**Auditor:** Principal Technical Project Manager (Plan Skill)  
**Total Development Window:** 19 Weeks (Phases 1–8)  
**Date:** November 2026  

---

## 1. Roadmap Architecture & Phase Overview

```mermaid
gantt
    title AUVYQ 2026 Modernization Schedule
    dateFormat  YYYY-MM-DD
    section Core Hardening
    Phase 1: Security Hardening & Stealth      :active, p1, 2026-11-01, 14d
    Phase 2: High-Volume Ruleset Pipeline     :p2, after p1, 21d
    Phase 3: Service Worker Modularization    :p3, after p2, 14d
    section Advanced Engines
    Phase 4: Procedural Cosmetic & SSAI Video :p4, after p3, 21d
    Phase 5: Edge ML & Threat Intelligence    :p5, after p4, 21d
    section Cross-Platform & UI
    Phase 6: Multi-Browser Firefox/Safari     :p6, after p5, 14d
    Phase 7: Modernized UI & Interactive Tools:p7, after p6, 14d
    section Release Verification
    Phase 8: Benchmarking, E2E & Launch Prep  :p8, after p7, 14d
```

---

## 2. Granular Task Breakdown by Phase

### Phase 1: Security Hardening & Zero-Leakage Stealth (Weeks 1–2)
*Goal: Eliminate all anti-adblock detection vectors, replace development keys, and resolve Chrome Web Store review blockers.*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-101** | Remove all `window.__auvyq*` global variables from `MAIN` world scripts. | `content/fp-shields.js`, `content/scriptlet-dispatch.js` | Low | None | Probing `window` object in console yields zero `auvyq` references. |
| **TASK-102** | Strip `data-auvyq` custom attributes from injected `<style>` tags. | `content/cosmetic-injector.js` | Low | None | `document.querySelectorAll('[data-auvyq]').length === 0` on all web pages. |
| **TASK-103** | Replace CustomEvent DOM messaging bridge with anonymous IIFE code execution. | `content/cosmetic-injector.js`, `manifest.json` | Medium | TASK-101 | Scriptlets receive configuration via closure arguments without emitting DOM events. |
| **TASK-104** | Drop `declarativeNetRequestFeedback` permission from `manifest.json`. | `manifest.json`, `sw.ts` | Medium | None | Extension builds and compiles; badge count derives from cosmetic counts & heuristic signals. |
| **TASK-105** | Replace `DEV_VERIFY_KEY_JWK` with offline-generated production ECDSA P-256 public key. | `core/update-channel/channel.ts` | Low | None | Hardcoded development key removed; signature verifier tests pass with production mock key. |

*Milestone Gate 1: Extension is 100% invisible to automated anti-adblock scanners (Admiral, PageFair) and passes automated CWS permission pre-validation.*

---

### Phase 2: High-Volume Ruleset Infrastructure & Remote Sync (Weeks 3–5)
*Goal: Overcome the 217-rule limitation and establish an automated, continuous ruleset update pipeline.*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-201** | Build automated upstream filter harvester (EasyList, EasyPrivacy, Peter Lowe, uBlock filters). | `tools/build-rules.mjs` | Medium | None | Script downloads, normalizes, and strips duplicate rules into validated raw buffers. |
| **TASK-202** | Implement high-performance DNR compiler partitioning rules across 5 static rulesets (30k rules each). | `core/rule-compiler/compiler.ts`, `tools/compile-dnr.mjs` | High | TASK-201 | Generates 150,000+ valid Declarative Net Request rules distributed across ruleset JSON files. |
| **TASK-203** | Update dynamic rule quota limit from 4,500 to 28,000 rules. | `core/quota-manager/quota.ts` | Low | None | `SAFE_DYNAMIC_CAPACITY` set to `28000`; quota tests pass. |
| **TASK-204** | Implement query parameter stripping (`$removeparam`) rule compiler. | `core/rule-compiler/compiler.ts` | Medium | TASK-202 | DNR rules generate `redirect: { transform: { queryTransform: { removeParams: [...] } } }`. |
| **TASK-205** | Deploy differential rule package update worker with rollback safeguards. | `core/update-channel/channel.ts` | High | TASK-105 | Incremental rule diffs download, verify signature, and hot-swap rulesets without restarting extension. |

*Milestone Gate 2: Static rule capacity reaches 150,000+ active rules; ad-blocking hit rate on Alexa Top 100 increases from 5% to 94%+.*

---

### Phase 3: Service Worker Modularization & Lifecycle Optimization (Weeks 6–7)
*Goal: Decompose monolithic 1,176-line `sw.ts` into decoupled, maintainable domain managers.*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-301** | Extract RPC routing and payload schema validation into `core/background/dispatcher.ts`. | `sw.ts`, `core/background/dispatcher.ts` | Medium | None | All RPC requests route cleanly through typed dispatcher; `sw.ts` reduced by 300 LOC. |
| **TASK-302** | Extract DNR ruleset synchronization and dynamic quota updates into `core/background/dnr-manager.ts`. | `sw.ts`, `core/background/dnr-manager.ts` | High | TASK-203 | DNR state changes isolated in dedicated manager; zero race conditions on concurrent tabs. |
| **TASK-303** | Extract tab tracking, badge debouncing, and UI sync into `core/background/badge-manager.ts`. | `sw.ts`, `core/background/badge-manager.ts` | Low | None | Badge text and color update smoothly with 100ms debounce; no UI thread lockup. |
| **TASK-304** | Extract alarm registration and scheduled maintenance into `core/background/alarm-scheduler.ts`. | `sw.ts`, `core/background/alarm-scheduler.ts` | Low | None | Alarms trigger clean domain events; persistent state restores from `chrome.storage.local`. |
| **TASK-305** | Optimize cold-start initialization latency to < 25ms. | `sw.ts`, `core/background/` | High | TASK-301–304| Service worker wake-up from sleep completes in under 25ms on benchmark device. |

*Milestone Gate 3: `sw.ts` reduced to < 180 lines of bootstrap code; cold-start latency drops below 25ms.*

---

### Phase 4: Advanced Cosmetic Filtering & SSAI Video Defusal (Weeks 8–10)
*Goal: Defeat evasive ads, dynamic CSS classes, and streaming video ads (YouTube/Twitch).*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-401** | Implement lightweight procedural CSS engine (`:has()`, `:has-text()`, `:matches-path()`). | `content/cosmetic-injector.js` | High | None | Procedural selectors successfully match and hide obfuscated parent ad containers. |
| **TASK-402** | Implement debounced MutationObserver TreeWalker for Single-Page Applications (SPAs). | `content/cosmetic-injector.js` | Medium | TASK-401 | Late-rendered ads on YouTube, Reddit, and Twitter are hidden within 50ms of DOM insertion. |
| **TASK-403** | Expand scriptlet library from 15 to 45 standard scriptlets with native `toString` mocking. | `content/scriptlet-dispatch.js` | High | TASK-101 | Injected scriptlets pass `Function.prototype.toString` introspection checks. |
| **TASK-404** | Implement YouTube SSAI player response sanitizer and 16x video rate accelerator. | `content/scriptlet-dispatch.js` | High | TASK-403 | YouTube video playback begins with zero ads; player does not trigger anti-adblock interstitial. |
| **TASK-405** | Implement Google Privacy Sandbox disabler scriptlet (`Topics`, `Protected Audience`). | `content/scriptlet-dispatch.js` | Low | TASK-403 | `document.browsingTopics()` returns empty array; ad auctions disabled. |

*Milestone Gate 4: Flawless video ad skipping on YouTube, Twitch, and news portals; zero broken player crashes.*

---

### Phase 5: Edge Machine Learning & Threat Intelligence (Weeks 11–13)
*Goal: Populate the `activeRiskModel` seam with local, zero-latency phishing and scam detection.*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-501** | Integrate ONNX Runtime WebAssembly runtime into `offscreen.ts`. | `extension/offscreen.ts` | Medium | None | ONNX runtime initializes in isolated offscreen worker; does not bloat service worker heap. |
| **TASK-502** | Package and quantize 180KB MobilePhish URL feature classifier model. | `core/ml/onnx-risk-model.ts`, `data/models/` | High | TASK-501 | Model scores URL in < 5ms; accurately detects homoglyph and deceptive banking scams. |
| **TASK-503** | Wire `OnnxRiskModel` into `core/ml/classify.ts` as the active provider. | `core/ml/classify.ts` | Medium | TASK-502 | `classifyWithModel` executes ONNX model with seamless fallback to `tier1.ts` on timeout. |
| **TASK-504** | Implement Chrome Built-in AI (`window.ai` / Gemini Nano) Prompt API explanation generator. | `content/warning-banner.js`, `core/ml/ai-explainer.ts` | Medium | None | When available, banner displays crisp, two-sentence explanation of detected risk. |

*Milestone Gate 5: Local AI risk scoring operational in < 5ms; zero external cloud calls; zero false positives on Top 10,000 domains.*

---

### Phase 6: Multi-Browser Abstraction Layer (Weeks 14–15)
*Goal: Enable true cross-browser distribution across Chrome, Firefox, Edge, and Safari.*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-601** | Create browser API abstraction layer (`core/platform/browser-adapter.ts`). | `core/platform/`, `sw.ts` | Medium | None | Unifies `chrome.*` and `browser.*` APIs behind a typed Promise-based interface. |
| **TASK-602** | Implement Firefox MV3 target build with background event pages and CNAME uncloaking. | `esbuild.mjs`, `manifest.firefox.json` | High | TASK-601 | Extension loads cleanly in Firefox Nightly/Stable; passes `web-ext lint` with zero errors. |
| **TASK-603** | Implement automated multi-target esbuild pipeline (`npm run build:all`). | `esbuild.mjs`, `package.json` | Low | TASK-602 | Compiles separate production zip archives for `dist/chrome` and `dist/firefox`. |

*Milestone Gate 6: Single codebase builds cleanly for both Chrome MV3 and Firefox WebExtensions.*

---

### Phase 7: UI Modernization, Interactive Tools & Glassmorphism (Weeks 16–17)
*Goal: Elevate the visual interface to 2026 design standards and deliver high-utility user tools.*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-701** | Implement interactive visual Element Picker with Shadow DOM point-and-click overlay. | `content/element-picker.js`, `ui/popup/` | High | None | User clicks element on page; extension generates optimal CSS rule and saves to dynamic storage. |
| **TASK-702** | Add active tab domain inspector tray to `ui/popup/popup.html`. | `ui/popup/popup.html`, `popup.js`, `popup.css` | Medium | None | Popup reveals expandable list of blocked third-party domains with per-site toggles. |
| **TASK-703** | Implement real-time network request visualizer in `ui/dashboard/dashboard.html`. | `ui/dashboard/dashboard.html`, `dashboard.js` | Medium | TASK-301 | Live scrolling feed shows network requests, block decisions, latency, and rule origins. |
| **TASK-704** | Refactor theme tokens to ensure 100% WCAG 2.2 AA contrast compliance in light/dark modes. | `ui/tokens.css`, `dashboard.css`, `popup.css` | Low | None | Color contrast checks pass with > 5.0:1 ratio across all text and icon components. |
| **TASK-705** | Add one-click exportable PDF/HTML Privacy Compliance Audit report generator. | `ui/dashboard/dashboard.js` | Medium | None | Generates professional, styled privacy compliance certificate summarizing blocked telemetry. |

*Milestone Gate 7: Design system passes WCAG 2.2 AA audit; Element Picker and Live Network Visualizer fully functional.*

---

### Phase 8: Production Verification, Benchmarking & CWS Launch (Weeks 18–19)
*Goal: Validate performance, eliminate regressions, and secure Chrome Web Store approval.*

| Task ID | Task Description | Target Files | Complexity | Dependencies | Acceptance Criteria |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **TASK-801** | Implement Playwright E2E browser automation suite covering top 50 real-world websites. | `tests/e2e/`, `playwright.config.ts` | High | All | Automated suite verifies ad blocking, page integrity, and zero console crashes on 50 sites. |
| **TASK-802** | Conduct WebPageTest load time and memory leak benchmarking. | `tests/perf/` | Medium | None | AUVYQ demonstrates < 18MB idle memory and reduces average page load time by > 35%. |
| **TASK-803** | Complete Chrome Web Store single-purpose justification and privacy policy documentation. | `docs/store/`, `PRIVACY.md` | Low | None | Privacy disclosures and store metadata ready for instant compliance review. |
| **TASK-804** | Package and sign production release build (v1.0.0). | `esbuild.mjs`, `package.json` | Low | TASK-801–803| Final zip packages signed, validated with `node tools/validate-manifest.mjs`. |

*Milestone Gate 8: Chrome Web Store submission accepted without rejection flags.*

*Proceed to `AUVYQ_TESTING_STRATEGY.md` for quality assurance specifications.*
