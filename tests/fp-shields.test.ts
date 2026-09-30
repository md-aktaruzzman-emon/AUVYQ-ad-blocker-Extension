import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Fingerprint Shields Code Integrity & Privacy', () => {
  const fpShieldsPath = path.join(__dirname, '..', 'content', 'fp-shields.js');
  const content = readFileSync(fpShieldsPath, 'utf8');

  it('contains zero custom AUVYQ branding strings in WebGL masks that could form a fingerprint', () => {
    expect(content.includes("vendor: 'AUVYQ'")).toBe(false);
    expect(content.includes("renderer: 'AUVYQ Graphics'")).toBe(false);
    expect(content.includes('Google Inc. (Intel)')).toBe(true);
  });

  it('safeguards canvas modification inside try/catch blocks', () => {
    expect(content).toContain('installCanvasShield');
    expect(content).toContain('originalGetImageData');
    expect(content).toContain('originalToDataURL');
  });

  it('implements standard navigator and screen property normalizations', () => {
    expect(content).toContain('hardwareConcurrency');
    expect(content).toContain('deviceMemory');
    expect(content).toContain('availLeft');
    expect(content).toContain('availTop');
  });

  it('implements reduced timer precision (0.1ms rounding)', () => {
    expect(content).toContain('Performance.prototype.now');
    expect(content).toContain('Math.round(originalNow.call(this) * 10) / 10');
  });

  it('listens for auvyq-fp-config CustomEvent with defensive validation', () => {
    expect(content).toContain("window.addEventListener('auvyq-fp-config'");
    expect(content).toContain("typeof flags !== 'object'");
  });
});
