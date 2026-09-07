# AUVYQ — Local-First Privacy, Ad, Tracker & Threat Protection

**AUVYQ** is a local-first, privacy-first browser protection extension built for Chrome Manifest V3 (Chrome 120+). It provides silent, resilient background protection against network advertisements, tracking beacons, annoying page elements, URL tracking parameters, third-party tracker cookies, and suspicious destinations.

---

## 1. Core Principles

- **LOCAL-FIRST**: All rule compilation, heuristic scoring, cookie evaluation, and telemetry queues operate strictly within the browser.
- **PRIVACY-FIRST**: No browsing history, raw URLs, form inputs, passwords, or cookies are logged, collected, or transmitted. Telemetry is **disabled by default**.
- **SECURITY-FIRST**: Zero arbitrary code execution (`eval`, `new Function`, `document.write`, dynamic filter scriptlet execution, and remote JavaScript are completely forbidden).
- **FAIL-SAFE & CRASH-RESILIENT**: If dynamic rule update verification or storage encounters an error, AUVYQ preserves the existing working rule pack and falls back safely without leaving the user unprotected.
- **CALM UX**: Protection works quietly without aggressive animations, matrix effects, or flashing alarms. Looping animations in protected idle states are forbidden.

---

## 2. Architecture Overview

AUVYQ follows the Manifest V3 service-worker architecture:

- **Service Worker (`sw.js`)**: Single background service worker entry point. All Chrome event listeners (`onInstalled`, `onStartup`, `onMessage`, `tabs.onRemoved`, `alarms.onAlarm`, `webNavigation.onCommitted`) are registered synchronously at module top-level.
- **Static DNR Rulesets**: `rules/ads-trackers.json` carries real-world, high-confidence ad/tracker infrastructure domains (batched `requestDomains` rules, subdomains included; `main_frame` never blocked). `rules/main.json` / `rules/annoyances.json` remain parser fixtures.
- **Default Filter Pack**: `data/default-filters.txt` is compiled on first run into the dynamic DNR pack (generic ad-delivery path rules, third-party beacon endpoints, Facebook pixel endpoint, campaign-parameter stripping).
- **Built-in Cosmetic Pack**: `content/cosmetic-injector.js` injects a curated generic ad-selector stylesheet synchronously at `document_start` (framework-generated ad ids, exact ad-container class tokens, ad iframes by infrastructure source, narrow overlay patterns) — no RPC wait, no full-document rescans.
- **Master Blocking Switch**: Toggling protection off disables all static rulesets and installs a top-priority session allow rule, so the popup toggle truly suspends all blocking.
- **Offscreen Document (`offscreen.js`)**: Dedicated isolated singleton offscreen document used strictly for non-DOM web crypto operations (PBKDF2 600,000-iteration key derivation for encrypted backups) and DOM parsing. Automatically torn down after ~60s of idle time.
- **Declarative Net Request Adapter (`platform-chrome/dnr-adapter/`)**: Diff-based dynamic rule updates with automatic rollback on API failure.
- **Rule Parser & Compiler (`core/rule-parser/`, `core/rule-compiler/`)**: Converts adblock filter syntax (`||domain^`, `$third-party`, `$image`, `$removeparam`, `$redirect`, `##selector`, `##+js(...)`) into RE2-validated DNR rules and CSS packs.
- **Cosmetic Engine (`content/cosmetic-injector.js`)**: Safe CSS stylesheet injection in isolated content script world at `document_idle`.
- **Scriptlet Engine (`content/scriptlet-dispatch.js`, `core/scriptlet-engine/`)**: MAIN world scriptlet execution using a fixed allowlisted library of 15 validated scriptlets. Never uses `eval`.
- **Cookie Guard (`platform-chrome/cookie-guard/`)**: Domain-classified cookie cleanup for third-party tracking contexts on tab close and periodic sweep alarms. Never deletes authentication or session cookies.
- **Tier-1 Heuristic Engine (`core/heuristic/tier1.ts`)**: Deterministic homoglyph detection, typosquatting checking (Damerau-Levenshtein distance vs ~200 popular domains), redirect-chain scoring, and foreign-origin login form detection.
- **Crypto Vault (`core/crypto/vault.ts`)**: PBKDF2-SHA256 (600,000 iterations) + AES-GCM-256 for user settings backup encryption and export/import.
- **Signed Update Channel (`core/update-channel/channel.ts`)**: ECDSA P-256 signature verification + SHA-256 hash checks + monotonic version enforcement.

---

## 3. Permission Rationale

| Permission | Purpose & Justification |
|---|---|
| `declarativeNetRequest` | Core network-level ad and tracker blocking engine without intercepting request bodies. |
| `declarativeNetRequestFeedback` | Accurate counting of blocked rules in development/unpacked builds for user feedback. |
| `storage` | Persistent storage of user settings, protection presets, and local daily aggregated snapshots. |
| `unlimitedStorage` | Ensures local rule packs and snapshot history are not prematurely evicted by Chrome. |
| `scripting` | Dynamic registration of content scripts for cosmetic filtering and MAIN world scriptlet dispatch. |
| `alarms` | Periodic maintenance tasks (stats flush, log retention pruning, idle sweeps, offscreen teardown). |
| `offscreen` | Spawning isolated offscreen document for PBKDF2 cryptography operations. |
| `webNavigation` | Inspecting navigation commitments for tier-1 heuristic risk evaluation. |
| `cookies` | Reading cookie domains to perform cleanup of third-party tracking cookies on tab removal. |
| `tabs` | Reading active tab hostname to provide per-site pause/allowlist controls and tab state. |
| `<all_urls>` (Host) | Universal protection across all web domains visited by the user. |

---

## 4. Storage & Migration Model

AUVYQ uses `chrome.storage.local` with schema versioning (`schemaVersion: 3`).
Migrations are deterministic, idempotent, and crash-safe:
- `v1 -> v2`: Flat counter properties migrated into a daily snapshot map.
- `v2 -> v3`: Backfills appearance theme and fingerprint shield preferences.
- Missing or corrupted values fall back to safe defaults with audit repair logs without erasing user configurations.

---

## 5. Security & Threat Model

- **No Remote Code Execution**: All executable JavaScript is bundled at build time. Updates supply compiled JSON data rules only.
- **Scriptlet Sandboxing**: Scriptlet parameters are strictly validated against character allowlists, prototype pollution keys (`__proto__`, `constructor`, `prototype`), and length caps before execution.
- **Signed Rule Updates**: Rules received over the update channel must have a valid ECDSA P-256 signature against the trusted public key and matching SHA-256 digests.
- **Rollback Protection**: If an update package fails signature validation, hash checks, schema parsing, or DNR rule limits, the previous active rule set is preserved intact.

> **DEVELOPMENT VERIFICATION KEY NOTICE**: The public key configured in `core/update-channel/channel.ts` is a development testing key (`REPLACE BEFORE PRODUCTION`). Before publishing to the Chrome Web Store, replace with production keys.

---

## 6. Fingerprint Shields & Compatibility

Fingerprint shielding is **OFF by default**. When enabled, it provides defensive noise and spoofing for canvas, WebGL, navigator, screen metrics, and high-precision timing APIs.

> **Compatibility Notice**: Certain modern web applications, WebGL games, and streaming video players may degrade when fingerprint shields are active. Users can selectively toggle fingerprint shields in the Dashboard.

---

## 7. Third-Party Filter List Licensing

AUVYQ ships with clean, original fixture rule definitions (`rules/main.json`, `rules/annoyances.json`). Bundling or distributing third-party filter lists (such as EasyList or uBlock Origin filter sets) requires independent licensing, copyright compliance, and attribution review.

---

## 8. Build, Test, and Verification

### Prerequisites
- Node.js 20+
- npm 10+

### Commands

```bash
# 1. Install dependencies
npm install

# 2. Typecheck with strict TypeScript
npm run typecheck

# 3. Lint with ESLint
npm run lint

# 4. Run automated test suite (Vitest)
npm test

# 5. Build extension bundle to dist/
npm run build

# 6. Run full validation pipeline (typecheck + lint + test + build)
npm run check
```

---

## 9. Loading in Google Chrome

1. Run `npm run build` to generate the `dist/` directory.
2. Open Google Chrome and navigate to `chrome://extensions`.
3. Enable **Developer mode** toggle in the top-right corner.
4. Click **Load unpacked**.
5. Select the `dist/` directory inside this project.
6. The AUVYQ icon will appear in the Chrome toolbar.

---

## 10. Manual Verification Checklist

1. **Install Extension**: Load unpacked from `dist/`; verify icon appears and initial notification/badge initializes.
2. **Onboarding**: Open onboarding (`ui/onboarding/onboarding.html`) and verify 3-step setup (transparency, preset selection, telemetry opt-in).
3. **Popup Interface**: Click toolbar icon; verify popup opens in <300ms showing protection state, master toggle, daily statistics, and current domain.
4. **Master Toggle**: Toggle protection OFF and ON; verify shield pulse animation, ring burst, and persistence across service worker restart.
5. **Per-Site Pause**: Click "Pause on this site"; verify status changes to Paused (amber indicator) and persists.
6. **Ad & Tracker Blocking**: Open `fixtures/test-page.html`; verify ad banners and promo elements are cosmetically hidden. On real websites, verify ad iframes (AdSense/Taboola/Outbrain) are blocked at network level and ad containers are hidden.
7. **Tracking Parameter Stripping**: Click tracking link with UTM/fbclid query parameters; verify parameters are stripped.
8. **Threat Warning Banner**: Open `fixtures/threat-page.html`; verify heuristic warning banner appears in Shadow DOM with Leave Site and Continue options.
9. **Encrypted Backup Export/Import**: In Dashboard, export settings with password; verify AES-GCM encrypted binary file downloads and re-imports successfully.
10. **Reduced Motion**: Enable `prefers-reduced-motion: reduce` in OS; verify UI transitions become instantaneous while preserving all visual state indicators.
