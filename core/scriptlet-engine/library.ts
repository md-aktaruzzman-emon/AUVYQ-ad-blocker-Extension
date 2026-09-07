/*
 * Fixed scriptlet library: exactly these 15 scriptlets exist. Each definition declares
 * argument count, argument types, maximum argument length and validation rules.
 * Definitions are DATA; execution lives in content/scriptlet-dispatch.js (fixed code, no eval).
 */

export type ScriptletArgType = 'string' | 'number';

export interface ScriptletDef {
  name: string;
  minArgs: number;
  maxArgs: number;
  argTypes: ScriptletArgType[];
  maxArgLength: number;
  /** Optional per-argument pattern validation for string args. */
  argPattern?: RegExp;
  /** Argument that must look like a safe dotted property path (set-constant, abort-on-property-read). */
  requiresPropertyPath?: number[];
}

export const SCRIPTLET_LIBRARY: readonly ScriptletDef[] = [
  { name: 'noop-callback', minArgs: 0, maxArgs: 1, argTypes: ['string'], maxArgLength: 128 },
  { name: 'json-prune-lite', minArgs: 1, maxArgs: 3, argTypes: ['string', 'string', 'number'], maxArgLength: 192, argPattern: /^[A-Za-z0-9_.-]+$/ },
  { name: 'set-constant', minArgs: 2, maxArgs: 3, argTypes: ['string', 'string', 'number'], maxArgLength: 192, requiresPropertyPath: [0] },
  { name: 'prevent-addEventListener', minArgs: 1, maxArgs: 2, argTypes: ['string', 'string'], maxArgLength: 96, argPattern: /^[a-z-]+$/i },
  { name: 'prevent-setTimeout', minArgs: 1, maxArgs: 2, argTypes: ['string', 'number'], maxArgLength: 192 },
  { name: 'noop-fetch', minArgs: 0, maxArgs: 1, argTypes: ['string'], maxArgLength: 192 },
  { name: 'close-window', minArgs: 0, maxArgs: 1, argTypes: ['string'], maxArgLength: 96 },
  { name: 'no-fetch-if', minArgs: 1, maxArgs: 1, argTypes: ['string'], maxArgLength: 192 },
  { name: 'no-xhr-if', minArgs: 1, maxArgs: 1, argTypes: ['string'], maxArgLength: 192 },
  { name: 'abort-on-property-read', minArgs: 1, maxArgs: 1, argTypes: ['string'], maxArgLength: 128, requiresPropertyPath: [0] },
  { name: 'hide-in-shadow', minArgs: 1, maxArgs: 1, argTypes: ['string'], maxArgLength: 192 },
  { name: 'remove-class', minArgs: 1, maxArgs: 2, argTypes: ['string', 'string'], maxArgLength: 96, argPattern: /^[A-Za-z0-9_.-]+$/ },
  { name: 'remove-attr', minArgs: 1, maxArgs: 2, argTypes: ['string', 'string'], maxArgLength: 96, argPattern: /^[A-Za-z0-9_-]+$/ },
  { name: 'prevent-eval-if', minArgs: 0, maxArgs: 1, argTypes: ['string'], maxArgLength: 96 },
  { name: 'trusted-suppress-console', minArgs: 0, maxArgs: 1, argTypes: ['string'], maxArgLength: 128, argPattern: /^[a-z,]+$/ }
];

const LIBRARY_BY_NAME = new Map<string, ScriptletDef>(SCRIPTLET_LIBRARY.map((def) => [def.name, def]));

export function getScriptletDef(name: string): ScriptletDef | undefined {
  return LIBRARY_BY_NAME.get(name);
}

/** Safe dotted property path: identifier segments only, no prototype trickery. */
export const PROPERTY_PATH_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,7}$/;

export function isSafePropertyPath(value: string): boolean {
  if (!PROPERTY_PATH_PATTERN.test(value)) return false;
  const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'self', 'window', 'document', 'globalThis']);
  return !value.split('.').some((segment) => forbidden.has(segment.toLowerCase()));
}
