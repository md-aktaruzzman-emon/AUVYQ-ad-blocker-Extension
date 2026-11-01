import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Fingerprinting Protection & Non-Identifying Normalization', () => {
  const fpShieldsPath = path.join(__dirname, '..', 'content', 'fp-shields.js');
  const content = readFileSync(fpShieldsPath, 'utf8');

  describe('Canvas Shield Anti-Identification Principles', () => {
    it('uses uniform minimal bit quantization instead of unique per-host PRNG noise', () => {
      // Must NOT contain host-seeded PRNG generators that create unique fingerprints per host
      expect(content).not.toContain('createHostPrng');
      expect(content).not.toContain('0x811c9dc5');
      // Uniform quantization: clears bit 0 uniformly (& ~1)
      expect(content).toContain('& ~1');
    });

    it('never mutates the source canvas backing store during toDataURL export', () => {
      expect(content).toContain("document.createElement('canvas')");
      expect(content).toContain('offCtx.drawImage');
      expect(content).toContain('offCtx.putImageData');
    });
  });

  describe('Standardized WebGL & Hardware Normalization', () => {
    it('standardizes WebGL vendor and renderer to universally common Intel UHD values', () => {
      expect(content).toContain('Google Inc. (Intel)');
      expect(content).toContain('ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)');
      // Zero custom extension branding strings in WebGL return values
      expect(content).not.toContain("vendor: 'AUVYQ'");
      expect(content).not.toContain("renderer: 'AUVYQ Graphics'");
    });

    it('standardizes Navigator hardware attributes without anomalous values', () => {
      expect(content).toContain('hardwareConcurrency');
      expect(content).toContain('deviceMemory');
      expect(content).toContain('get: () => 4');
    });

    it('standardizes Screen avail coordinates to eliminate taskbar and dock tracking', () => {
      expect(content).toContain('availLeft');
      expect(content).toContain('availTop');
      expect(content).toContain('get: () => 0');
      expect(content).toContain('get: function () { return this.width; }');
      expect(content).toContain('get: function () { return this.height; }');
    });
  });

  describe('Timing & Audio Hardware Variance Defense', () => {
    it('reduces timer resolution to 0.1ms precision to mitigate micro-architectural side channels', () => {
      expect(content).toContain('Performance.prototype.now');
      expect(content).toContain('Math.round(originalNow.call(this) * 10) / 10');
    });

    it('quantizes Web Audio buffer readbacks to prevent audio oscillator fingerprinting', () => {
      expect(content).toContain('AudioBuffer.prototype.getChannelData');
      expect(content).toContain('Math.round(data[i] * 100000) / 100000');
    });
  });

  describe('Strict Configuration Isolation', () => {
    it('isolates shields behind auvyq-fp-config event listeners with runtime validation', () => {
      expect(content).toContain("window.addEventListener('auvyq-fp-config'");
      expect(content).toContain("typeof flags !== 'object'");
      expect(content).toContain('window.dispatchEvent(new CustomEvent(\'auvyq-fp-ready\'))');
    });
  });
});
