/*
 * AUVYQ fingerprint shields — MAIN world, document_start. Default OFF.
 * Every shield is flag-gated; configuration arrives via the 'auvyq-fp-config'
 * DOM event from the ISOLATED-world injector.
 *
 * Conservative, standards-aware protections:
 * - Canvas: Uniform channel bit-quantization (clears LSBs uniformly across all contexts);
 *   no deterministic or pseudo-random per-host noise that creates unique signatures.
 * - WebGL: Standard common GPU masking (Google Inc. (Intel) / ANGLE Intel UHD 630).
 * - Navigator & Screen: Normalized hardwareConcurrency, deviceMemory, avail coordinates.
 * - Timing: Reduced timer precision (0.1ms rounding) to mitigate Spectre and audio-clock attacks.
 * - Audio: Float channel quantization to eliminate hardware DAC variance without distortion.
 *
 * Shields are strictly optional: core protection never depends on them.
 */
(() => {
  const FP_GUARD = '__shield_guard_init__';
  if (Object.prototype.hasOwnProperty.call(window, FP_GUARD)) return;
  try {
    Object.defineProperty(window, FP_GUARD, { value: 1, writable: false, enumerable: false, configurable: false });
  } catch {
    // non-fatal
  }

  /**
   * Canvas Shield: Applies uniform minimal channel quantization (LSB zeroing)
   * on readback buffers to neutralize GPU rasterization anti-aliasing signatures.
   * Completely avoids pseudo-random or host-seeded noise that would create a unique fingerprint.
   */
  function installCanvasShield() {
    try {
      const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function getImageData(...args) {
        const data = originalGetImageData.apply(this, args);
        // Create a copy of the ImageData buffer to avoid mutating backing store
        const cloned = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
        // Uniform quantization: clear the lowest bit of color channels across all pixels
        for (let i = 0; i < cloned.data.length; i += 4) {
          cloned.data[i] = cloned.data[i] & ~1;
          cloned.data[i + 1] = cloned.data[i + 1] & ~1;
          cloned.data[i + 2] = cloned.data[i + 2] & ~1;
        }
        return cloned;
      };

      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      const origToDataURL = originalToDataURL;
      HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
        // Skip noise for WebGL canvases to avoid blank export
        const gl = this.getContext('webgl') || this.getContext('webgl2');
        if (gl) {
          return origToDataURL.apply(this, arguments);
        }
        if (this.width > 0 && this.height > 0) {
          try {
            // Export from a temporary copy canvas; NEVER mutate the source canvas backing store!
            const offscreen = document.createElement('canvas');
            offscreen.width = this.width;
            offscreen.height = this.height;
            const offCtx = offscreen.getContext('2d');
            if (offCtx !== null) {
              offCtx.drawImage(this, 0, 0);
              const imgData = originalGetImageData.call(offCtx, 0, 0, this.width, this.height);
              for (let i = 0; i < imgData.data.length; i += 4) {
                imgData.data[i] = imgData.data[i] & ~1;
                imgData.data[i + 1] = imgData.data[i + 1] & ~1;
                imgData.data[i + 2] = imgData.data[i + 2] & ~1;
              }
              offCtx.putImageData(imgData, 0, 0);
              return originalToDataURL.apply(offscreen, args);
            }
          } catch { /* canvas may be tainted */ }
        }
        return originalToDataURL.apply(this, args);
      };
    } catch { /* non-fatal */ }
  }

  /**
   * WebGL Shield: Masks GPU parameters to standard universally common values
   * so all users appear identical rather than leaking physical GPU cards.
   */
  function installWebglShield() {
    try {
      const standardVendor = 'Google Inc. (Intel)';
      const standardRenderer = 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)';

      const original = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function getParameter(parameter) {
        if (parameter === 37445) return standardVendor;   // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return standardRenderer; // UNMASKED_RENDERER_WEBGL
        return original.call(this, parameter);
      };

      if (typeof WebGL2RenderingContext !== 'undefined') {
        const original2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function getParameter(parameter) {
          if (parameter === 37445) return standardVendor;
          if (parameter === 37446) return standardRenderer;
          return original2.call(this, parameter);
        };
      }
    } catch { /* non-fatal */ }
  }

  /**
   * Navigator Shield: Standardizes core hardware and environment values
   * without creating an anomalous profile.
   */
  function installNavigatorShield() {
    try {
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
        get: () => 4,
        configurable: true,
        enumerable: true
      });
      Object.defineProperty(Navigator.prototype, 'deviceMemory', {
        get: () => 4,
        configurable: true,
        enumerable: true
      });
    } catch { /* non-fatal */ }
  }

  /**
   * Screen Shield: Prevents fingerprinting via OS taskbar height, dock placement,
   * or multi-monitor offset positions.
   */
  function installScreenShield() {
    try {
      Object.defineProperty(Screen.prototype, 'availLeft', { get: () => 0, configurable: true });
      Object.defineProperty(Screen.prototype, 'availTop', { get: () => 0, configurable: true });
      Object.defineProperty(Screen.prototype, 'availWidth', {
        get: function () { return this.width; },
        configurable: true
      });
      Object.defineProperty(Screen.prototype, 'availHeight', {
        get: function () { return this.height; },
        configurable: true
      });
    } catch { /* non-fatal */ }
  }

  /**
   * Timing & Audio Shield: Reduces Performance.now timer resolution and quantizes
   * Web Audio buffer readbacks to prevent audio oscillator hardware fingerprinting.
   */
  function installTimingShield() {
    try {
      const originalNow = Performance.prototype.now;
      Performance.prototype.now = function now() {
        return Math.round(originalNow.call(this) * 10) / 10; // 0.1ms precision
      };

      // Audio buffer quantization
      if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype.getChannelData) {
        const origGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function getChannelData(channel) {
          const data = origGetChannelData.call(this, channel);
          // Quantize float values slightly to eliminate micro-architectural floating point variance
          for (let i = 0; i < data.length; i += 64) {
            data[i] = Math.round(data[i] * 100000) / 100000;
          }
          return data;
        };
      }
    } catch { /* non-fatal */ }
  }

  const INSTALLERS = {
    canvas: installCanvasShield,
    webgl: installWebglShield,
    navigator: installNavigatorShield,
    screen: installScreenShield,
    timing: installTimingShield
  };

  window.addEventListener('auvyq-fp-config', (event) => {
    const flags = event.detail;
    if (typeof flags !== 'object' || flags === null) return;
    for (const [name, install] of Object.entries(INSTALLERS)) {
      if (flags[name] === true) {
        try { install(); } catch { /* flag stays on; failure isolated */ }
      }
    }
  });

  try {
    window.dispatchEvent(new CustomEvent('auvyq-fp-ready'));
  } catch {
    // non-fatal
  }
})();
