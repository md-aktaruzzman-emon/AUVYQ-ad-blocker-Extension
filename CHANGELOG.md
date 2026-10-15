# Changelog

All notable changes to the AUVYQ extension project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-10-15

### Security
- **Threat Warning Banner Crash Fix**: Fixed `buildShieldSvg` crash on `ShadowRoot` which lacks `createElementNS`, restoring functional in-page threat alerts.
- **Fail-Closed RPC Privileges**: Changed fallthrough in `isPrivilegedSender` to return `false` by default when sender origin context is absent.
- **Privilege Separation**: Removed `THREAT_ACTION` from content-script-allowed RPC types to prevent malicious web pages from triggering domain blocks or forced tab navigation.
- **Scriptlet Nonce Authentication**: Added cryptographic one-time nonce handshake between ISOLATED and MAIN worlds with capture-phase event consumption and immediate listener teardown, preventing untrusted page scripts from injecting scriptlets.
- **Login Phishing Scanner Verification**: Validated `CHECK_LOGIN_FORMS` origin strictly against sender tab URL and removed active tab fallback to eliminate cross-tab threat misdirection.
- **Production Build Key Guard**: Added automated check in `esbuild.mjs` that aborts builds when `NODE_ENV=production` if `DEV_VERIFY_KEY_JWK` is present.
- **Crypto Error Categorization**: Strengthened `VaultError` kinds and verified deterministic SHA-256 digests.

### Fixed
- **Filter Compiler Initiator Mapping**: Mapped ABP `$domain=` rules to DNR `initiatorDomains` instead of destination `requestDomains`, correcting inverted filter scoping.
- **Facebook Tracking Rules**: Fixed `^*` separator syntax in default filter rules to reliably block Facebook pixel and tracking script network requests.
- **CSS Selector Parsing**: Filtered out rule blocks lacking `{` to prevent CSS property declarations from being injected as invalid DOM selectors.
- **Combined Ruleset Logic**: Enabled `ads-trackers` ruleset when either `ads` or `trackers` modules are active.
- **DNR Dynamic Pack Rollback**: Removed all active pack rule IDs before re-applying previous pack rules, preventing duplicate ID collision crashes during rollbacks.
- **Site Pause Navigation**: Permitted direct `main_frame` navigations to paused sites without requiring an external initiator.
- **Settings Migration Data Retention**: Merged existing settings during v1→v2 migration instead of replacing them with defaults.
- **Offscreen Document Lifecycle**: Fixed stale resolved promise retention when Chrome evicts idle offscreen documents under memory pressure.
- **Per-Site Pause Storage Synchronization**: Applied DNR session allow rules prior to committing pause state in persistent storage.
- **Pack Rule Quota Guard**: Added defensive capacity checks in `assignPackIds` to prevent infinite collision loops.
- **GA4 Cookie Classification**: Updated analytics pattern regex to recognize Google Analytics 4 (`_ga_*`) container cookies.
- **Cookie Cleaning Metrics**: Verified return values of `chrome.cookies.remove` so non-existent cookies are not recorded as cleaned.
- **Expert Preset Preservation**: Checked `developerMode: true` in `matchPreset` so Expert users are not reclassified as Maximum.
- **Hostname Port Normalization**: Stripped arbitrary port suffixes (`localhost:3000`, `test.dev:8080`) during hostname normalization.
- **Public Suffix Emission**: Stopped `getDomainCandidates` from emitting public suffixes (e.g. `co.uk`), preventing overbroad domain matching.
- **DNR Session State Cleared**: Cleared session rules and properly awaited default pack activation in `CLEAR_AUVYQ_DATA`.

### Added
- **Localization Files**: Created `_locales/en/messages.json` with complete extension name, description, and UI keys.
- **Onboarding Completion RPC**: Implemented `SET_ONBOARDING_DONE` in RPC types and storage handlers.
- **Handshake Buffer for Fingerprint Shields**: Added `auvyq-fp-ready` event listener to ensure early configuration is not dropped.
- **Annoyances Cosmetic Module Support**: Filtered cookie and newsletter popups in `GET_COSMETIC` according to `settings.modules.annoyances`.

### Performance & Privacy
- **Eliminated Continuous Popup Polling**: Replaced 1.5s interval polling with reactive `chrome.storage.onChanged` event listeners.
- **Canvas Noise Multi-Channel Distribution**: Applied subtle host-deterministic PRNG noise to Red, Green, and Blue channels.
- **Preserved WebGL Canvas Exports**: Retained 3D canvas drawing buffers without blank exports in `toDataURL()`.
- **Randomized WebGL GPU Profiles**: Masked WebGL vendor and renderer across realistic profiles deterministically per origin.
- **Enumerable Navigator Properties**: Configured `hardwareConcurrency` and `deviceMemory` as enumerable properties.
- **Accessibility & Motion Tokens**: Added `prefers-reduced-motion` overrides in `popup.css` and replaced deprecated `unload` with `pagehide`.
- **Package Size Optimization**: Excluded test fixtures from the production distribution bundle.

## [0.3.0] - 2026-10-05

### Added
- Initial Manifest V3 ad blocking and tracker protection engine.
- Declarative Net Request static rule integration (EasyList, EasyPrivacy, annoyances).
- Cookie Guard and storage partitioning tools.
- Threat heuristics (homoglyph, typosquatting, redirect chain scoring).
- Offscreen crypto vault for PBKDF2 + AES-256-GCM encrypted settings backups.
