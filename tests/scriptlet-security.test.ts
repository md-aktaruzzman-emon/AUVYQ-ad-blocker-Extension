import { describe, it, expect } from 'vitest';
import { validateScriptlet } from '../core/scriptlet-engine/validate.js';
import { isSafePropertyPath, SCRIPTLET_LIBRARY } from '../core/scriptlet-engine/library.js';

describe('Scriptlet Security & Validation', () => {
  it('contains exactly the 15 required scriptlets in the fixed library', () => {
    expect(SCRIPTLET_LIBRARY.length).toBe(15);
    const names = SCRIPTLET_LIBRARY.map((d) => d.name);
    const expected = [
      'noop-callback',
      'json-prune-lite',
      'set-constant',
      'prevent-addEventListener',
      'prevent-setTimeout',
      'noop-fetch',
      'close-window',
      'no-fetch-if',
      'no-xhr-if',
      'abort-on-property-read',
      'hide-in-shadow',
      'remove-class',
      'remove-attr',
      'prevent-eval-if',
      'trusted-suppress-console'
    ];
    for (const exp of expected) {
      expect(names).toContain(exp);
    }
  });

  it('rejects unknown or arbitrary scriptlet names', () => {
    expect(validateScriptlet('eval-code', []).ok).toBe(false);
    expect(validateScriptlet('run-js', ['alert(1)']).ok).toBe(false);
    expect(validateScriptlet('', []).ok).toBe(false);
  });

  it('rejects code-injection strings and dangerous characters', () => {
    const dangerousArgs = [
      '});evil()',
      '<script>alert(1)</script>',
      'var x = 1; window.hack()',
      'eval("bad")',
      '`test`',
      '${7*7}',
      '() => alert(1)'
    ];

    for (const bad of dangerousArgs) {
      const res = validateScriptlet('noop-callback', [bad]);
      expect(res.ok).toBe(false);
    }
  });

  it('rejects prototype pollution attempts like __proto__, constructor, prototype', () => {
    expect(validateScriptlet('set-constant', ['__proto__.polluted', 'true']).ok).toBe(false);
    expect(validateScriptlet('set-constant', ['constructor.prototype.bad', '1']).ok).toBe(false);
    expect(validateScriptlet('abort-on-property-read', ['window.__proto__']).ok).toBe(false);
    expect(isSafePropertyPath('__proto__.evil')).toBe(false);
    expect(isSafePropertyPath('Object.prototype.isAdmin')).toBe(false);
  });

  it('validates safe property paths correctly', () => {
    expect(isSafePropertyPath('gaOptout')).toBe(true);
    expect(isSafePropertyPath('app.config.debug')).toBe(true);
    expect(isSafePropertyPath('window.myApp')).toBe(false); // root window forbidden
    expect(isSafePropertyPath('document.cookie')).toBe(false); // document forbidden
  });

  it('rejects oversized arguments and control characters', () => {
    const hugeArg = 'a'.repeat(500);
    expect(validateScriptlet('noop-callback', [hugeArg]).ok).toBe(false);
    expect(validateScriptlet('noop-callback', ['test\u0000null']).ok).toBe(false);
    expect(validateScriptlet('noop-callback', ['test\nnewline']).ok).toBe(false);
  });

  it('accepts valid, safe scriptlet invocations', () => {
    expect(validateScriptlet('noop-callback', ['onAdLoaded']).ok).toBe(true);
    expect(validateScriptlet('set-constant', ['appConfig.adsEnabled', 'false']).ok).toBe(true);
    expect(validateScriptlet('prevent-addEventListener', ['visibilitychange']).ok).toBe(true);
    expect(validateScriptlet('remove-class', ['ad-banner', 'body']).ok).toBe(true);
  });
});
