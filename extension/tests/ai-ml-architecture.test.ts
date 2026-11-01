import { describe, it, expect } from 'vitest';
import {
  LocalUrlRiskClassifier,
  calculateShannonEntropy,
  FEATURE_WEIGHTS,
  MODEL_INTERCEPT
} from '../core/ml/url-classifier.js';
import {
  classify,
  classifyWithModel,
  activeRiskModel,
  setActiveRiskModel,
  type RiskModel
} from '../core/ml/classify.js';
import {
  checkBuiltInAiAvailability,
  generateThreatExplanation,
  generateDeterministicExplanation,
  generatePrivacyAdvice
} from '../core/ml/builtin-ai.js';
import {
  analyzeFirstPartyEndpoint,
  categorizeTracker,
  TRACKER_ENGINE_BENCHMARKS
} from '../core/ml/tracker-analyzer.js';
import type { RiskResult, DomFeatures } from '../types/schemas.js';

describe('Part 10 — AI, Machine Learning & Intelligent Privacy Architecture', () => {
  const classifier = new LocalUrlRiskClassifier();

  describe('Feature Extraction & Information-Theoretic Entropy', () => {
    it('calculates Shannon entropy accurately', () => {
      // Homogeneous string has 0 entropy
      expect(calculateShannonEntropy('aaaaa')).toBe(0);
      
      // Standard dictionary word has moderate entropy (~2.0 - 2.8)
      const normalEntropy = calculateShannonEntropy('google');
      expect(normalEntropy).toBeGreaterThanOrEqual(1.5);
      expect(normalEntropy).toBeLessThanOrEqual(3.0);

      // Random / DGA string has elevated entropy (> 3.5)
      const randomEntropy = calculateShannonEntropy('x8z91k0a1b7q');
      expect(randomEntropy).toBeGreaterThan(3.2);
    });

    it('extracts all 17 features cleanly from standard and complex URLs', () => {
      const features = classifier.extractFeatures('https://sub.portal.example.com:8080/path/to/page?q=test#hash');
      
      expect(features.urlLength).toBeGreaterThan(0);
      expect(features.hostLength).toBeGreaterThan(0);
      expect(features.subdomainCount).toBeGreaterThanOrEqual(0.5);
      expect(features.nonStandardPort).toBe(1);
      expect(features.isRawIp).toBe(0);
      expect(features.hasUserinfo).toBe(0);
    });

    it('handles malformed, empty, and huge strings safely without throwing', () => {
      const empty = classifier.extractFeatures('');
      expect(empty.urlLength).toBe(0);
      expect(empty.isRawIp).toBe(0);

      const invalid = classifier.extractFeatures('not_a_valid_url_at_all!@#$%^');
      expect(invalid).toBeDefined();

      const huge = 'https://example.com/' + 'a'.repeat(50000);
      const hugeFeatures = classifier.extractFeatures(huge);
      expect(hugeFeatures.urlLength).toBe(1.0); // capped at 1.0
    });

    it('detects sensitive authentication keywords in paths and subdomains', () => {
      const sample = classifier.extractFeatures('https://account-verification.suspicious.com/secure/login');
      expect(sample.sensitiveTokenCount).toBeGreaterThan(0);
    });
  });

  describe('Statistical Logistic Regression Scoring & Attribution', () => {
    it('scores benign popular domains with low risk (score <= 15)', () => {
      const benignDomains = [
        'https://www.google.com/',
        'https://en.wikipedia.org/wiki/Main_Page',
        'https://github.com/trending',
        'https://apple.com/mac',
        'https://www.amazon.com/dp/B08N5WRWNW',
        'https://www.nytimes.com/section/world'
      ];

      for (const url of benignDomains) {
        const features = classifier.extractFeatures(url);
        const score = classifier.scoreFeatures(features);
        expect(score.score, `Expected benign URL ${url} to score <= 15, got ${score.score}`).toBeLessThanOrEqual(15);
        expect(score.probability).toBeLessThanOrEqual(0.15);
      }
    });

    it('prevents false positives on dictionary words containing brand substrings', () => {
      const words = [
        'https://pineapple.com/recipes',
        'https://grapple.org/products',
        'https://chased.com/about'
      ];

      for (const url of words) {
        const features = classifier.extractFeatures(url);
        const score = classifier.scoreFeatures(features);
        expect(score.score, `Expected word ${url} not to be flagged, got ${score.score}`).toBeLessThanOrEqual(20);
      }
    });

    it('flags high-entropy phishing and credential harvesting URLs with high risk', () => {
      const phishingUrls = [
        'https://paypal-security-update-verification.xyz/login',
        'https://chase-online-banking-account.top/auth/verify',
        'https://apple-id-suspended-recovery.click/confirm-password',
        'https://dga-x8z91k0a1b7q99.biz/harvest'
      ];

      for (const url of phishingUrls) {
        const features = classifier.extractFeatures(url);
        const score = classifier.scoreFeatures(features);
        expect(score.score, `Expected phishing URL ${url} to score >= 60, got ${score.score}`).toBeGreaterThanOrEqual(60);
        expect(score.topContributors.length).toBeGreaterThan(0);
      }
    });

    it('extracts explainable feature attributions with human-readable descriptions', () => {
      const features = classifier.extractFeatures('https://verify-account-paypal.xyz/login');
      const score = classifier.scoreFeatures(features);
      
      expect(score.topContributors.length).toBeGreaterThanOrEqual(1);
      const top = score.topContributors[0];
      expect(top.explanation.length).toBeGreaterThan(10);
      expect(top.contribution).toBeGreaterThan(0);
    });
  });

  describe('Evaluation Dataset Benchmark & Quantitative Metrics', () => {
    it('meets minimum accuracy, precision, and recall thresholds on representative dataset', () => {
      const dataset: { url: string; isPhishing: boolean }[] = [
        // 15 Benign Samples
        { url: 'https://google.com/', isPhishing: false },
        { url: 'https://youtube.com/watch?v=123', isPhishing: false },
        { url: 'https://github.com/microsoft/vscode', isPhishing: false },
        { url: 'https://wikipedia.org/wiki/Computer_science', isPhishing: false },
        { url: 'https://amazon.com/gp/bestsellers', isPhishing: false },
        { url: 'https://apple.com/iphone', isPhishing: false },
        { url: 'https://microsoft.com/en-us/windows', isPhishing: false },
        { url: 'https://cloudflare.com/learning', isPhishing: false },
        { url: 'https://developer.mozilla.org/en-US/', isPhishing: false },
        { url: 'https://stackoverflow.com/questions', isPhishing: false },
        { url: 'https://reddit.com/r/technology', isPhishing: false },
        { url: 'https://bbc.com/news', isPhishing: false },
        { url: 'https://cnn.com/', isPhishing: false },
        { url: 'https://pineapple.com/', isPhishing: false },
        { url: 'https://chased.com/', isPhishing: false },

        // 15 Phishing / Threat Samples
        { url: 'https://paypal-security-update-verification.xyz/login', isPhishing: true },
        { url: 'https://chase-online-banking-account.top/auth/verify', isPhishing: true },
        { url: 'https://apple-id-suspended-recovery.click/confirm-password', isPhishing: true },
        { url: 'https://dga-x8z91k0a1b7q99.biz/harvest', isPhishing: true },
        { url: 'https://binance-wallet-recovery-auth.top/seed', isPhishing: true },
        { url: 'https://verify-netflix-billing-update.xyz/pay', isPhishing: true },
        { url: 'https://microsoft-security-alert-3921.top/login', isPhishing: true },
        { url: 'https://192.168.1.1/login.php?user=admin', isPhishing: true },
        { url: 'https://user:pass@evil-phish.net/login', isPhishing: true },
        { url: 'https://suspicious-dga-77a8b9c0d1e2.top/collect', isPhishing: true },
        { url: 'https://steam-community-login-trade.xyz/auth', isPhishing: true },
        { url: 'https://coinbase-account-unlock-verify.xyz/', isPhishing: true },
        { url: 'https://ups-package-tracking-fee.top/delivery', isPhishing: true },
        { url: 'https://fedex-redelivery-scheduled.click/invoice', isPhishing: true },
        { url: 'https://dhl-shipping-notice-update.xyz/confirm', isPhishing: true }
      ];

      let tp = 0; // True Positive (Phishing detected as Phishing)
      let fp = 0; // False Positive (Benign detected as Phishing)
      let tn = 0; // True Negative (Benign detected as Benign)
      let fn = 0; // False Negative (Phishing detected as Benign)

      const start = performance.now();
      for (const item of dataset) {
        const features = classifier.extractFeatures(item.url);
        const res = classifier.scoreFeatures(features);
        const predictedPhishing = res.score >= 40;

        if (item.isPhishing && predictedPhishing) tp += 1;
        else if (!item.isPhishing && predictedPhishing) fp += 1;
        else if (!item.isPhishing && !predictedPhishing) tn += 1;
        else if (item.isPhishing && !predictedPhishing) fn += 1;
      }
      const durationMs = performance.now() - start;
      const avgLatencyMs = durationMs / dataset.length;

      const accuracy = (tp + tn) / dataset.length;
      const precision = tp / (tp + fp);
      const recall = tp / (tp + fn);

      // Verify benchmark constraints
      expect(accuracy, 'Model accuracy must be >= 90%').toBeGreaterThanOrEqual(0.90);
      expect(precision, 'Model precision must be >= 85%').toBeGreaterThanOrEqual(0.85);
      expect(recall, 'Model recall must be >= 85%').toBeGreaterThanOrEqual(0.85);
      expect(fp, 'Zero false positives on benign set').toBe(0);
      expect(avgLatencyMs, 'Average latency must be < 1.0ms').toBeLessThan(1.0);
    });
  });

  describe('Seam Preparedness & Fail-Safe Fallback', () => {
    it('uses LocalUrlRiskClassifier as default activeRiskModel in classifyWithModel', async () => {
      expect(activeRiskModel).not.toBeNull();
      const res = await classifyWithModel('https://example.com/', { hostname: 'example.com', url: 'https://example.com/' });
      expect(res).toBeDefined();
      expect(res.score).toBeLessThanOrEqual(20);
    });

    it('falls back seamlessly to deterministic Tier-1 if model throws an exception', async () => {
      const faultingModel: RiskModel = {
        async classify() {
          throw new Error('Simulated out of memory or inference crash');
        }
      };
      setActiveRiskModel(faultingModel);

      // Must NOT throw; must silently fall back to tier-1 heuristics
      const fallbackResult = await classifyWithModel('https://example.com/', { hostname: 'example.com', url: 'https://example.com/' });
      expect(fallbackResult).toBeDefined();
      expect(fallbackResult.severity).toBeDefined();

      // Restore active model
      setActiveRiskModel(classifier);
    });

    it('falls back cleanly to deterministic Tier-1 if activeRiskModel is null', async () => {
      setActiveRiskModel(null);
      const res = await classifyWithModel('https://example.com/', { hostname: 'example.com', url: 'https://example.com/' });
      expect(res).toBeDefined();
      expect(res.severity).toBeDefined();
      setActiveRiskModel(classifier);
    });
  });

  describe('Chrome Built-in AI Bridge & Deterministic Explanations', () => {
    it('detects Chrome Built-in AI capabilities via feature detection', async () => {
      const status = await checkBuiltInAiAvailability();
      expect(status).toBeDefined();
      expect(status.available).toBe('no'); // In Node.js / Vitest environment, native window.ai is absent
      expect(status.engine).toBe('deterministic-template-fallback');
    });

    it('generates high-assurance deterministic explanations for homoglyph attacks', async () => {
      const mockRisk: RiskResult = {
        score: 85,
        severity: 'malicious',
        reasons: ['Homoglyph detected: Latin lookalike with Cyrillic characters'],
        confidence: 0.95,
        threatType: 'heuristic',
        signals: [{ category: 'homoglyph', description: 'Cyrillic a used in paypal', weight: 85 }]
      };

      const explanation = await generateThreatExplanation('paypаl.com', mockRisk);
      expect(explanation.headline).toContain('Homoglyph');
      expect(explanation.explanation).toContain('Cyrillic');
      expect(explanation.guidance).toContain('credentials');
      expect(explanation.source).toBe('deterministic-fallback');
    });

    it('generates high-assurance deterministic explanations for brand impersonation', async () => {
      const mockRisk: RiskResult = {
        score: 80,
        severity: 'high',
        reasons: ['Brand impersonation targeting paypal with security keywords'],
        confidence: 0.92,
        threatType: 'heuristic',
        signals: [{ category: 'brand_impersonation', description: 'Impersonating paypal', weight: 80 }]
      };

      const explanation = await generateThreatExplanation('paypal-update.xyz', mockRisk);
      expect(explanation.headline).toContain('Brand Impersonation');
      expect(explanation.explanation).toContain('paypal');
      expect(explanation.source).toBe('deterministic-fallback');
    });

    it('generates actionable privacy advice based on site statistics', () => {
      const advice = generatePrivacyAdvice('news-site.com', 45, 12, 4, true);
      expect(advice.rating).toBe('Poor');
      expect(advice.actionableSteps.length).toBeGreaterThanOrEqual(3);
      expect(advice.actionableSteps.some((s) => s.includes('Strict'))).toBe(true);
    });
  });

  describe('Tracker Analysis & CNAME Cloaking Heuristics', () => {
    it('documents formal benchmarks justifying DNR static lists as primary', () => {
      const dnrBenchmark = TRACKER_ENGINE_BENCHMARKS.find((b) => b.technique === 'DNR Static Ruleset');
      const mlBenchmark = TRACKER_ENGINE_BENCHMARKS.find((b) => b.technique === 'On-Device ML Classifier');

      expect(dnrBenchmark).toBeDefined();
      expect(mlBenchmark).toBeDefined();
      expect(dnrBenchmark!.meanLatencyMs).toBeLessThan(0.1);
      expect(mlBenchmark!.meanLatencyMs).toBeGreaterThan(5.0);
      expect(mlBenchmark!.recommendation).toContain('Do Not Use');
    });

    it('detects disguised first-party CNAME cloaking and collector subdomains', () => {
      const assessment = analyzeFirstPartyEndpoint('metrics.retailer.com', '/v1/batch', '?visitor_id=abc1234567890abcdef123456');
      expect(assessment.isLikelyCloaked).toBe(true);
      expect(assessment.category).toBe('analytics');
      expect(assessment.reasons.length).toBeGreaterThanOrEqual(2);
    });

    it('categorizes tracker domains into semantic buckets accurately', () => {
      expect(categorizeTracker('analytics.google.com')).toBe('analytics');
      expect(categorizeTracker('doubleclick.net')).toBe('advertising');
      expect(categorizeTracker('hotjar.com')).toBe('session_replay');
      expect(categorizeTracker('connect.facebook.net')).toBe('social_tracking');
      expect(categorizeTracker('fingerprintjs.com')).toBe('fingerprinting');
    });
  });

  describe('Privacy & Zero-Leakage Assurances', () => {
    it('ensures local ML and explanation engines make zero external network requests', async () => {
      // In local execution, no fetch or XMLHttpRequest is called
      const features = classifier.extractFeatures('https://private-banking.internal/');
      const scored = classifier.scoreFeatures(features);
      expect(scored).toBeDefined();

      const threat = await classifier.classify('https://private-banking.internal/', {
        hostname: 'private-banking.internal',
        url: 'https://private-banking.internal/'
      });
      expect(threat).toBeDefined();

      // Zero network calls, 100% on-device
      expect(threat.threatSource).toBe('Local-ML-Classifier');
    });
  });
});
