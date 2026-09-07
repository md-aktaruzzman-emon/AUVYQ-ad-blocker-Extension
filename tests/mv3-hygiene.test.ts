import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git' || entry === 'fixtures') continue;
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findFiles(full, exts));
    } else if (exts.some((ext) => entry.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

describe('Manifest V3 Security & Hygiene Scan', () => {
  const rootDir = path.join(__dirname, '..');
  const codeFiles = findFiles(rootDir, ['.js', '.ts', '.mjs']);
  const htmlFiles = findFiles(rootDir, ['.html']);

  it('contains zero eval usages across the entire codebase', () => {
    for (const file of codeFiles) {
      // Skip test itself and test assertions
      if (file.includes('tests') || file.includes('re2-validate')) continue;
      const content = readFileSync(file, 'utf8');
      // Look for standalone eval( or window.eval
      const matches = content.match(/\beval\s*\(/g);
      expect(matches, `eval() found in ${file}`).toBeNull();
    }
  });

  it('contains zero new Function or Function constructor calls', () => {
    for (const file of codeFiles) {
      if (file.includes('tests') || file.includes('eslint.config.js')) continue;
      const content = readFileSync(file, 'utf8');
      const newFunc = content.match(/new\s+Function\s*\(/g);
      expect(newFunc, `new Function found in ${file}`).toBeNull();
    }
  });

  it('contains zero localStorage usage (must use chrome.storage/idb)', () => {
    for (const file of codeFiles) {
      if (file.includes('tests') || file.includes('eslint.config.js')) continue;
      const content = readFileSync(file, 'utf8');
      const matches = content.match(/\blocalStorage\b/g);
      expect(matches, `localStorage found in ${file}`).toBeNull();
    }
  });

  it('contains zero inline script tags or inline event handlers in HTML files', () => {
    for (const file of htmlFiles) {
      const content = readFileSync(file, 'utf8');
      // Check for inline onclick, onload, etc.
      const inlineHandler = content.match(/\son[a-z]+\s*=/i);
      expect(inlineHandler, `inline event handler found in ${file}`).toBeNull();

      // Check for script tags with inline body
      const inlineScript = content.match(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]+?)<\/script>/gi);
      expect(inlineScript, `inline script tag found in ${file}`).toBeNull();
    }
  });

  it('contains zero remote script URLs (http/https script references)', () => {
    for (const file of htmlFiles) {
      const content = readFileSync(file, 'utf8');
      const remoteSrc = content.match(/<script[^>]+src=["'](https?:|\/\/)[^"']+["']/gi);
      expect(remoteSrc, `remote script reference found in ${file}`).toBeNull();
    }
  });

  it('registers all background service worker listeners at synchronous top level in sw.ts and modules', () => {
    const swPath = path.join(rootDir, 'sw.ts');
    const content = readFileSync(swPath, 'utf8');

    expect(content).toContain('chrome.runtime.onInstalled.addListener');
    expect(content).toContain('chrome.runtime.onStartup.addListener');
    expect(content).toContain('registerRpcListener(router)');
    expect(content).toContain('chrome.tabs.onRemoved.addListener');
    expect(content).toContain('chrome.alarms.onAlarm.addListener');
    expect(content).toContain('chrome.webNavigation.onCommitted.addListener');

    const rpcPath = path.join(rootDir, 'platform-chrome/rpc/rpc.ts');
    const rpcContent = readFileSync(rpcPath, 'utf8');
    expect(rpcContent).toContain('chrome.runtime.onMessage.addListener');
  });
});
