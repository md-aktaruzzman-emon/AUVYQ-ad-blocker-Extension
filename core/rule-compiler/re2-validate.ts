/*
 * Explicit RE2 compatibility validation. DNR regexFilter runs on RE2, which forbids
 * lookarounds and backreferences. Invalid or pathological patterns must be rejected
 * (or downgraded by the compiler) and must never crash compilation.
 */

export interface Re2Check {
  valid: boolean;
  reason?: string;
}

export const MAX_REGEX_LENGTH = 1024;
export const MAX_GROUPS = 32;

export function validateRe2(pattern: string): Re2Check {
  if (typeof pattern !== 'string' || pattern.length === 0) return { valid: false, reason: 'empty' };
  if (pattern.length > MAX_REGEX_LENGTH) return { valid: false, reason: 'too-long' };

  // Constructs RE2 does not support.
  if (/\(\?<[=!]/.test(pattern)) return { valid: false, reason: 'lookbehind' };
  if (/\(\?[:=!]/.test(pattern) && /\(\?[=!]/.test(pattern)) return { valid: false, reason: 'lookahead' };
  if (/\(\?[=!]/.test(pattern)) return { valid: false, reason: 'lookahead' };
  if (/\\[1-9]/.test(pattern)) return { valid: false, reason: 'backreference' };
  if (/[*+?}]\+/.test(pattern) || /\{\d+,?\d*\}\+/.test(pattern)) return { valid: false, reason: 'possessive-quantifier' };
  if (/\\u[0-9a-fA-F]{4}/.test(pattern)) return { valid: false, reason: 'unsupported-escape-u' };
  if (/\\c/.test(pattern)) return { valid: false, reason: 'unsupported-escape-c' };
  if (/\(\?P=/.test(pattern)) return { valid: false, reason: 'named-backreference' };

  // Pathological nested quantifiers such as (a+)+ or (a*)*
  if (/\((?:[^()\\]|\\.)*[+*]\)[+*{]/.test(pattern)) return { valid: false, reason: 'nested-quantifier' };

  // Structural balance, respecting escapes and character classes.
  let inClass = false;
  let escaped = false;
  let groups = 0;
  for (const ch of pattern) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (ch === ']') inClass = false;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      continue;
    }
    if (ch === '(') groups += 1;
    else if (ch === ')') groups -= 1;
    if (groups < 0) return { valid: false, reason: 'unbalanced-parens' };
  }
  if (escaped) return { valid: false, reason: 'dangling-escape' };
  if (inClass) return { valid: false, reason: 'unterminated-class' };
  if (groups !== 0) return { valid: false, reason: 'unbalanced-parens' };
  if (groups > MAX_GROUPS || countChar(pattern, '(') > MAX_GROUPS) return { valid: false, reason: 'too-many-groups' };

  return { valid: true };
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (const c of text) if (c === ch) n += 1;
  return n;
}

/** Cheap JS-side smoke test that the pattern compiles at all (RE2 is stricter; validateRe2 already ran). */
export function compilesAsJsRegex(pattern: string): boolean {
  try {
    void new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}
