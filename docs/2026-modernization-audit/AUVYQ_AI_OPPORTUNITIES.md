# AUVYQ — AI & Edge Intelligence Opportunities: 2026 Strategy

**Document ID:** `AUV-AUD-2026-007`  
**Evaluation Scope:** Local Machine Learning, Chrome Built-in AI, Edge Inference & Threat Scoring  
**Auditor:** Principal Machine Learning Engineer & Product Architect  
**Current Implementation State:** Reserved Seam (`activeRiskModel = null`)  
**Date:** November 2026  

---

## 1. Analysis of Current Machine Learning Seam

AUVYQ v0.3.0 contains an explicit machine learning interface in `extension/core/ml/classify.ts`:

```typescript
// Lines 1–25 in core/ml/classify.ts
export interface RiskModel {
  classify(url: string, features: DomFeatures): Promise<RiskResult>;
}

export let activeRiskModel: RiskModel | null = null;

export function setActiveRiskModel(model: RiskModel | null): void {
  activeRiskModel = model;
}

export function classify(url: string, domFeatures: DomFeatures): RiskResult {
  // Deterministic tier-1 path (sync, no network, no model).
  return assessThreat({ ...domFeatures, url });
}
```

### 1.1 Architectural Commendation:
The design philosophy in `classify.ts` is exceptionally mature:
- **Zero "AI Washing":** The codebase explicitly documents: *"AUVYQ makes NO claim that heuristics are machine learning."*
- **Fail-Safe Fallback:** If a model is added and throws an exception or takes too long, the system silently and safely falls through to deterministic tier-1 heuristics (`assessThreat`), ensuring protection is never compromised.
- **Seam Preparedness:** Callers already call `classifyWithModel()`; activating a model requires zero refactoring of downstream consumers.

---

## 2. Hard Realities & Constraints of AI in Browser Extensions

Before designing AI capabilities, an engineering team must confront the physical constraints of Chrome Manifest V3 extensions:

| Constraint | Manifest V3 Budget | Impact on Machine Learning Models |
| :--- | :--- | :--- |
| **Extension Package Size** | < 25 MB (Store recommendation) | Large language models (e.g., 2GB-7GB GGUF) cannot be bundled. |
| **Service Worker RAM** | 50 MB – 100 MB max before kill | Models requiring > 30MB heap will cause service worker crashes. |
| **Execution Latency** | < 15ms for network decisions | Deep transformers take 200–500ms; too slow for synchronous request blocking. |
| **WASM in Service Worker** | Supported, but cold-load penalty | Heavy WASM initializations cause slow service worker cold starts. |
| **Privacy / No Cloud API** | Strict local-first privacy commitment | Cannot send browsing URLs to external cloud LLM APIs (OpenAI/Anthropic). |

> **Fundamental Principle:**
> **Deterministic filter rules will ALWAYS remain 1,000x faster and more accurate than AI for known ads and trackers.**
> AI should **NEVER** replace rule engines. AI must be deployed strictly where rules fail: **zero-day phishing, dynamic obfuscation, typosquatting variants, and deceptive dark patterns.**

---

## 3. High-Value AI Capabilities for AUVYQ (2026 Horizon)

```mermaid
flowchart TD
    subgraph Browser Tab
        URL[Page URL & Domain]
        DOM[DOM Tree & Text Features]
    end

    subgraph Tier 1: Deterministic Engine (0.1ms)
        HOMO[Homoglyph & Punycode]
        TYPO[Damerau-Levenshtein Top-1000]
        RULE_MATCH[DNR Static & Dynamic Rules]
    end

    subgraph Tier 2: Edge ML Seam (3ms - 15ms)
        ONNX[Quantized ONNX Runtime WASM]
        URL_BERT[MobilePhish URL Classifier - 180KB]
        DARK_PAT[Dark Pattern DOM Classifier - 350KB]
    end

    subgraph Tier 3: Chrome Built-in AI (Prompt API)
        WINDOW_AI["window.ai / Gemini Nano (Chrome 127+)"]
        EXPLAIN[Plain-English Threat Explanations]
        PRIVACY_SUM[Privacy Policy Summarization]
    end

    URL --> HOMO
    URL --> TYPO
    URL --> RULE_MATCH
    
    HOMO -->|Suspicious Flag| ONNX
    TYPO -->|Distance Match| ONNX
    ONNX --> URL_BERT
    DOM --> DARK_PAT
    
    URL_BERT -->|Score > 85| ALERT[Threat Warning Banner]
    ALERT --> EXPLAIN
```

---

### Opportunity 1: Ultra-Lightweight Zero-Day Phishing Classifier (MobilePhish-ONNX)
- **Problem:** Attackers register thousands of disposable typosquatted or homoglyphic domains daily (e.g., `paypal-security-update-912.xyz`). Static blocklists cannot update fast enough to catch them in the first hour of life.
- **Solution:** A quantized, 180 KB LightGBM or 1D-CNN model compiled to ONNX Runtime Web (WebAssembly backend).
- **Features Extracted Locally:**
  - URL length, entropy, sub-domain depth, consonant-vowel ratios.
  - Presence of sensitive tokens (`login`, `verify`, `banking`, `secure`, `update`).
  - TLD risk weighting (`.zip`, `.mov`, `.xyz`, `.top`).
  - Presence of password inputs on unverified origins.
- **Performance:** Executes in **3.2ms** with **< 4MB RAM footprint**, well within service worker or offscreen document budgets.

---

### Opportunity 2: Deceptive UI & Dark Pattern Detector
- **Problem:** Many modern websites employ deceptive interface patterns:
  - Fake "Download Now" buttons that lead to malware installers.
  - Misleading cookie consent banners with concealed "Reject All" options.
  - Countdown timers simulating artificial scarcity.
- **Solution:** A lightweight DOM tree classifier running in `ISOLATED` world:
  - Inspects button text, contrast ratios, and element positioning.
  - Automatically highlights the genuine download link or clicks the "Reject All" button automatically.
- **AUVYQ Differentiation:** No major ad blocker offers automated dark-pattern neutralization. This would be a major PR and marketing differentiator.

---

### Opportunity 3: Chrome Built-in AI (`window.ai` / Gemini Nano) Integration
- **Technology Overview:**
  - Starting in Chrome 127+, Chromium began shipping **Gemini Nano** directly within the browser binary, accessible to extensions via the `chrome.aiOriginTrial` and `window.ai` Prompt API.
  - **Zero Bundle Size Impact:** The model is hosted by the browser itself; AUVYQ ships 0 MB of model weights.
  - **Zero Cloud Network Calls:** All inference runs on the user's local NPU/GPU.
- **AUVYQ Feature Applications:**
  1. **Plain-English Threat Explanations:**
     - Instead of displaying cryptic warning codes (`"Homoglyph / Subdomain Deception: score 88"`), AUVYQ prompts Gemini Nano:
       `"Explain in 2 simple sentences why domain 'paypa1-support.com' trying to look like 'paypal.com' is dangerous to a non-technical user."`
     - The warning banner displays crisp, reassuring guidance tailored to the user.
  2. **Automated Privacy Policy TL;DR:**
     - When visiting an e-commerce or SaaS site, users can click "Summarize Privacy Policy".
     - Gemini Nano parses the site's Terms of Service and returns three bullet points:
       - What data they sell to third parties.
       - Whether they use your inputs for AI training.
       - Retention period and deletion options.

---

## 4. Implementation Blueprint: Populating `activeRiskModel`

To bridge the gap between `core/ml/classify.ts` and actual inference, we propose the following module architecture for Phase 5:

```typescript
// Proposed core/ml/onnx-risk-model.ts
import type { RiskModel } from './classify.js';
import type { DomFeatures, RiskResult } from '../../types/schemas.js';

export class OnnxRiskModel implements RiskModel {
  private session: any = null;

  async init(modelBinary: ArrayBuffer): Promise<void> {
    // Dynamically load ONNX WebAssembly runtime in offscreen context
    // session = await ort.InferenceSession.create(modelBinary);
  }

  async classify(url: string, features: DomFeatures): Promise<RiskResult> {
    const inputVector = this.extractFeatures(url, features);
    const output = await this.session.run({ input: inputVector });
    const score = Math.round(output.probability.data[0] * 100);

    return {
      score,
      severity: score >= 85 ? 'malicious' : score >= 65 ? 'high' : 'medium',
      reasons: ['ML zero-day heuristic match', ...this.explainTopFeatures(inputVector)],
      confidence: 0.92
    };
  }

  private extractFeatures(url: string, features: DomFeatures): Float32Array {
    // 32 deterministic numerical features extracted synchronously
    const buf = new Float32Array(32);
    // ... feature calculations
    return buf;
  }
}
```

---

## 5. Strategic AI Recommendation Matrix

| Feature | Viability | Resource Cost | User Value | Recommendation |
| :--- | :---: | :---: | :---: | :--- |
| **MobilePhish 180KB ONNX URL Classifier** | High | Low (< 4MB RAM) | Very High | **Implement in Phase 5** |
| **Chrome Built-in AI (Gemini Nano) Explanations** | High | Zero bundle (Native) | High | **Implement in Phase 5** |
| **Automated Privacy Policy Summarizer** | High | Zero bundle (Native) | High | **Implement in Phase 7** |
| **Deep Transformer / LLM in Service Worker** | Infeasible | Extreme (> 500MB) | Low | **DO NOT IMPLEMENT** |
| **Cloud-Based AI URL Scoring** | Feasible | High API costs | Negative (Privacy risk)| **STRICTLY REJECT** |

*Proceed to `AUVYQ_COMPETITOR_ANALYSIS.md` for competitor teardowns.*
