/*
 * Scriptlet validation. Adversarial payloads are rejected, counted and never executed.
 * The dispatcher executes only fixed implementations selected by allowlisted name.
 */
import { getScriptletDef, isSafePropertyPath } from './library.js';

export interface ScriptletCheck {
  ok: boolean;
  error?: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const DANGEROUS_SUBSTRINGS = ['<', '>', '`', '"', "'", '\\', '}', '{', '$', ';', '(', ')', '=>'];

export function validateScriptlet(name: unknown, args: unknown): ScriptletCheck {
  if (typeof name !== 'string' || name.length === 0 || name.length > 64) {
    return { ok: false, error: 'invalid-name' };
  }
  const def = getScriptletDef(name);
  if (def === undefined) return { ok: false, error: 'unknown-name' };

  if (!Array.isArray(args)) return { ok: false, error: 'args-not-array' };
  if (args.length < def.minArgs || args.length > def.maxArgs) {
    return { ok: false, error: 'arity' };
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const expected = def.argTypes[i] ?? def.argTypes[def.argTypes.length - 1];
    if (expected === 'number') {
      if (typeof arg !== 'number' || !Number.isFinite(arg) || Math.abs(arg) > 1e9) {
        return { ok: false, error: `arg-${i}: type` };
      }
      continue;
    }
    if (typeof arg !== 'string') return { ok: false, error: `arg-${i}: type` };
    if (arg.length > def.maxArgLength) return { ok: false, error: `arg-${i}: too-long` };
    if (CONTROL_CHARS.test(arg)) return { ok: false, error: `arg-${i}: control-chars` };
    for (const token of DANGEROUS_SUBSTRINGS) {
      if (arg.includes(token)) return { ok: false, error: `arg-${i}: dangerous-sequence` };
    }
    if (arg.toLowerCase().includes('__proto__') || arg.toLowerCase().includes('prototype') ||
        arg.toLowerCase().includes('constructor')) {
      return { ok: false, error: `arg-${i}: prototype-access` };
    }
    if (def.argPattern !== undefined && !def.argPattern.test(arg)) {
      return { ok: false, error: `arg-${i}: pattern` };
    }
    if (def.requiresPropertyPath?.includes(i) === true && !isSafePropertyPath(arg)) {
      return { ok: false, error: `arg-${i}: unsafe-property-path` };
    }
  }

  return { ok: true };
}
