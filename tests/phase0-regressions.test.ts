import { describe, it, expect } from 'vitest';
import { typosquatCheck, assessThreat, detectForeignLogin } from '../core/heuristic/tier1.js';
import { isKnownTrackingCookie } from '../platform-chrome/cookie-guard/guard.js';
import { parseFilterList } from '../core/rule-parser/parser.js';
import { compileRulesDetailed } from '../core/rule-compiler/compiler.js';

describe('Phase 0 Quality & Safety Regressions', () => {
  describe('0.1 & 0.6: DNR Exception Priority Stratification', () => {
    it('guarantees allow rules (@@) strictly override block rules with differing patterns', () => {
      const filler = Array.from({ length: 300 }, (_, i) => `||filler${String(i).padStart(3, '0')}.example^`).join('\n');
      const list = `${filler}\n||zcdn.example^\n@@||zcdn.example/player.js`;
      const res = compileRulesDetailed(parseFilterList(list, 'priority-regression'));

      const blockRules = res.rules.filter((r) => r.rule.action.type === 'block');
      const allowRules = res.rules.filter((r) => r.rule.action.type === 'allow');

      expect(blockRules.length).toBeGreaterThan(0);
      expect(allowRules.length).toBe(1);

      const maxBlockPriority = Math.max(...blockRules.map((r) => r.rule.priority ?? 0));
      const minAllowPriority = Math.min(...allowRules.map((r) => r.rule.priority ?? 0));

      expect(maxBlockPriority).toBeLessThanOrEqual(6999);
      expect(minAllowPriority).toBeGreaterThanOrEqual(7000);
      expect(minAllowPriority).toBeGreaterThan(maxBlockPriority);
    });
  });

  describe('0.2: Cookie Guard Authentication & Security Protection', () => {
    it('never removes Google sign-in cookies or Cloudflare bot management tokens', () => {
      const protectedCookies = [
        { name: 'SAPISID', domain: '.google.com' },
        { name: 'APISID', domain: '.google.com' },
        { name: '__Secure-3PAPISID', domain: '.google.com' },
        { name: '__cf_bm', domain: '.example.com' },
        { name: '__cfuvid', domain: '.cloudflare.com' },
        { name: 'cf_clearance', domain: '.mysite.org' }
      ];

      for (const cookie of protectedCookies) {
        expect(isKnownTrackingCookie(cookie), `Cookie ${cookie.name} on ${cookie.domain} must be protected`).toBe(false);
      }
    });
  });

  describe('0.3 & 0.4: Heuristic Threat False Positives & SSO Preservation', () => {
    it('does not flag popular legitimate short domains as typosquats', () => {
      const domains = [
        'fox.com',
        'ubs.com',
        'ring.com',
        'king.com',
        'mac.com',
        'y.com',
        'email.com',
        'redfin.com',
        'okta.com',
        'github.io',
        'paypal.me'
      ];

      for (const domain of domains) {
        const check = typosquatCheck(domain);
        expect(check.suspicious, `Domain ${domain} was falsely flagged as typosquat of ${check.target}`).toBe(false);

        const threat = assessThreat({ hostname: domain, url: `https://${domain}/` });
        expect(threat.severity, `Domain ${domain} should have 'none' severity`).toBe('none');
      }
    });

    it('does not classify legitimate enterprise SSO login forms as threats', () => {
      const pageOrigin = 'https://portal.company.com';
      const ssoForms = [
        { actionOrigin: 'https://company.okta.com/login', hasPasswordField: true },
        { actionOrigin: 'https://login.microsoftonline.com/auth', hasPasswordField: true },
        { actionOrigin: 'https://auth.company.auth0.com/u/login', hasPasswordField: true }
      ];

      const assessment = detectForeignLogin(pageOrigin, ssoForms);
      expect(assessment.score).toBe(0);
      expect(assessment.reasons.length).toBe(0);
    });

    it('retains high severity for actual phishing harvest forms', () => {
      const pageOrigin = 'https://mybank.com';
      const maliciousForm = [
        { actionOrigin: 'https://evil-credential-harvest.xyz/collect', hasPasswordField: true }
      ];

      const assessment = detectForeignLogin(pageOrigin, maliciousForm);
      expect(assessment.score).toBe(70);
      expect(assessment.reasons.length).toBeGreaterThan(0);
    });
  });
});
