/*
 * AUVYQ Custom Filter & User Rule Manager.
 *
 * Provides high-priority user-defined cosmetic selectors and network DNR rules.
 * Enforces strict validation, quota safety, non-destructive import/export,
 * and deterministic persistence.
 */
import { LIMITS } from '../validation/schemas.js';
import { STORAGE_KEYS } from '../storage/schema.js';
import { compileUserRule, USER_RULE_ID_MIN, USER_RULE_ID_MAX } from './rule-manager.js';

export type CustomRuleType = 'cosmetic' | 'network';

export interface CustomRule {
  id: string;
  type: CustomRuleType;
  rawText: string;
  domain?: string;
  enabled: boolean;
  createdAt: number;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  normalized?: string;
}

const FORBIDDEN_ROOT_SELECTORS = new Set([
  'html', 'body', ':root', 'head', 'main', '*',
  'html > body', 'body > *', 'body *', ':empty'
]);

/**
 * Validates a CSS selector to ensure it is structurally safe and will not
 * hide critical page root containers or break document rendering.
 */
export function validateCosmeticSelector(selector: string): ValidationResult {
  const trimmed = selector.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Selector cannot be empty' };
  }
  if (trimmed.length > LIMITS.selectorChars) {
    return { valid: false, error: `Selector exceeds maximum length of ${LIMITS.selectorChars} characters` };
  }

  const lower = trimmed.toLowerCase();
  if (FORBIDDEN_ROOT_SELECTORS.has(lower)) {
    return { valid: false, error: `Selecting root layout element "${trimmed}" is forbidden to prevent blanking websites` };
  }

  // Reject unclosed brackets or quotes
  const openBrackets = (trimmed.match(/\[/g) || []).length;
  const closeBrackets = (trimmed.match(/\]/g) || []).length;
  if (openBrackets !== closeBrackets) {
    return { valid: false, error: 'Unbalanced attribute brackets in selector' };
  }

  const openParens = (trimmed.match(/\(/g) || []).length;
  const closeParens = (trimmed.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    return { valid: false, error: 'Unbalanced parentheses in selector' };
  }

  // Reject control characters or script injection attempts
  if (/[\x00-\x1f\x7f<{};]/.test(trimmed)) {
    return { valid: false, error: 'Selector contains forbidden control characters or braces' };
  }

  // If DOM is available (e.g. browser context or test jsdom), test querySelector
  if (typeof document !== 'undefined' && typeof document.createDocumentFragment === 'function') {
    try {
      const fragment = document.createDocumentFragment();
      fragment.querySelector(trimmed);
    } catch (err) {
      return { valid: false, error: `Invalid CSS selector syntax: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return { valid: true, normalized: trimmed };
}

/**
 * Validates a custom network rule (domain, Adblock-style ||domain^, or @@allow).
 */
export function validateNetworkRule(rawText: string): ValidationResult {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Rule pattern cannot be empty' };
  }
  if (trimmed.length > 512) {
    return { valid: false, error: 'Rule pattern exceeds maximum length of 512 characters' };
  }

  // Reject comments
  if (trimmed.startsWith('!') || trimmed.startsWith('#')) {
    return { valid: false, error: 'Comments cannot be registered as active rules' };
  }

  // Check for dangerous wildcards that would block everything
  if (trimmed === '*' || trimmed === '||*' || trimmed === 'http*' || trimmed === 'https*') {
    return { valid: false, error: 'Broad universal wildcard rules are not permitted' };
  }

  // Validate regex syntax if enclosed in slashes
  if (trimmed.startsWith('/') && trimmed.endsWith('/') && trimmed.length > 2) {
    try {
      new RegExp(trimmed.slice(1, -1));
    } catch (err) {
      return { valid: false, error: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // Test compilation to DNR Rule
  const compiled = compileUserRule(trimmed, USER_RULE_ID_MIN);
  if (!compiled) {
    return { valid: false, error: 'Unable to compile pattern into DeclarativeNetRequest rule' };
  }

  return { valid: true, normalized: trimmed };
}

/**
 * Validates any CustomRule object against structural and type-specific constraints.
 */
export function validateCustomRuleInput(
  rawText: string,
  type: CustomRuleType,
  domain?: string
): ValidationResult {
  if (type === 'cosmetic') {
    const selectorResult = validateCosmeticSelector(rawText);
    if (!selectorResult.valid) return selectorResult;

    if (domain !== undefined && domain.trim().length > 0) {
      const cleanDomain = domain.trim().toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').replace(/\/.*$/, '');
      if (cleanDomain.length > 253 || !/^[a-z0-9.-]+$/i.test(cleanDomain)) {
        return { valid: false, error: 'Invalid domain name for domain-specific cosmetic rule' };
      }
      return { valid: true, normalized: selectorResult.normalized };
    }
    return selectorResult;
  }

  if (type === 'network') {
    return validateNetworkRule(rawText);
  }

  return { valid: false, error: `Unknown rule type "${type as string}"` };
}

/**
 * Generates an isolated, collision-resistant rule ID.
 */
export function generateRuleId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `cr_${timePart}_${randomPart}`;
}

/**
 * Exports custom rules to plain text (Adblock Plus / uBlock Origin compatible format) or JSON.
 */
export function exportCustomRules(rules: CustomRule[], format: 'text' | 'json' = 'text'): string {
  if (format === 'json') {
    return JSON.stringify(rules, null, 2);
  }

  const lines: string[] = [
    '! --------------------------------------------------',
    '! AUVYQ User Custom Filter Rules Export',
    `! Export Date: ${new Date().toISOString()}`,
    `! Total Rules: ${rules.length}`,
    '! --------------------------------------------------',
    ''
  ];

  for (const rule of rules) {
    if (!rule.enabled) lines.push(`! [DISABLED]`);
    if (rule.type === 'cosmetic') {
      const prefix = rule.domain ? `${rule.domain}##` : '##';
      lines.push(`${prefix}${rule.rawText}`);
    } else {
      lines.push(rule.rawText);
    }
  }

  return lines.join('\n');
}

/**
 * Imports custom rules from text or JSON, validating each entry.
 */
export function importCustomRules(payload: string): { imported: CustomRule[]; errors: string[] } {
  const imported: CustomRule[] = [];
  const errors: string[] = [];
  const trimmed = payload.trim();
  if (trimmed.length === 0) return { imported, errors: ['Payload is empty'] };

  // Attempt JSON format
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (let i = 0; i < parsed.length; i++) {
          const item = parsed[i];
          if (typeof item === 'object' && item !== null) {
            const rawText = String(item.rawText || '');
            const type = item.type === 'network' ? 'network' : 'cosmetic';
            const domain = typeof item.domain === 'string' ? item.domain : undefined;
            const validation = validateCustomRuleInput(rawText, type, domain);
            if (validation.valid) {
              imported.push({
                id: generateRuleId(),
                type,
                rawText: validation.normalized || rawText,
                domain,
                enabled: item.enabled !== false,
                createdAt: typeof item.createdAt === 'number' ? item.createdAt : Date.now()
              });
            } else {
              errors.push(`Rule #${i + 1} (${rawText}): ${validation.error}`);
            }
          }
        }
        return { imported, errors };
      }
    } catch {
      // Fallback to text parsing
    }
  }

  // Plain text format line-by-line
  const lines = trimmed.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.length === 0 || line.startsWith('!') || line.startsWith('[')) continue;

    if (line.includes('##')) {
      const [domainPart, selectorPart] = line.split('##', 2);
      const domain = domainPart.trim().length > 0 ? domainPart.trim().toLowerCase() : undefined;
      const selector = selectorPart.trim();
      const val = validateCustomRuleInput(selector, 'cosmetic', domain);
      if (val.valid) {
        imported.push({
          id: generateRuleId(),
          type: 'cosmetic',
          rawText: val.normalized || selector,
          domain,
          enabled: true,
          createdAt: Date.now()
        });
      } else {
        errors.push(`Line ${i + 1} (${line}): ${val.error}`);
      }
    } else {
      const val = validateCustomRuleInput(line, 'network');
      if (val.valid) {
        imported.push({
          id: generateRuleId(),
          type: 'network',
          rawText: val.normalized || line,
          enabled: true,
          createdAt: Date.now()
        });
      } else {
        errors.push(`Line ${i + 1} (${line}): ${val.error}`);
      }
    }
  }

  return { imported, errors };
}

/**
 * Compiles all enabled custom network rules into DNR Rule objects with User Custom Rule IDs.
 */
export function compileCustomNetworkRules(rules: CustomRule[]): chrome.declarativeNetRequest.Rule[] {
  const dnrRules: chrome.declarativeNetRequest.Rule[] = [];
  let nextId = USER_RULE_ID_MIN;
  for (const rule of rules) {
    if (rule.type === 'network' && rule.enabled) {
      if (nextId > USER_RULE_ID_MAX) break;
      const compiled = compileUserRule(rule.rawText, nextId);
      if (compiled) {
        dnrRules.push(compiled);
        nextId++;
      }
    }
  }
  return dnrRules;
}

/**
 * Loads custom rules from chrome.storage.local.
 */
export async function loadStoredCustomRules(): Promise<CustomRule[]> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return [];
  const res = await chrome.storage.local.get(STORAGE_KEYS.customRules);
  const raw = res[STORAGE_KEYS.customRules];
  if (!Array.isArray(raw)) return [];
  return raw as CustomRule[];
}

/**
 * Saves custom rules to chrome.storage.local.
 */
export async function saveStoredCustomRules(rules: CustomRule[]): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  await chrome.storage.local.set({ [STORAGE_KEYS.customRules]: rules });
}

/**
 * Synchronizes custom network rules to DeclarativeNetRequest dynamic rules.
 */
export async function syncCustomNetworkRules(rules: CustomRule[]): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) return;
  const targetRules = compileCustomNetworkRules(rules);
  const currentRules = await chrome.declarativeNetRequest.getDynamicRules().catch(() => []);
  const removeRuleIds = currentRules
    .filter((r) => r.id >= USER_RULE_ID_MIN && r.id <= USER_RULE_ID_MAX)
    .map((r) => r.id);

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules: targetRules
  }).catch(() => undefined);
}

