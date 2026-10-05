/*
 * AUVYQ fingerprint shields — MAIN world, document_start. Default OFF.
 * Every shield is flag-gated; configuration arrives via the 'auvyq-fp-config'
 * DOM event from the ISOLATED-world injector. Compatibility risks are documented
 * in README (canvas readback noise, WebGL parameter masking, navigator metadata,
 * screen rounding, timing precision can each break fingerprinting-heavy sites).
 * Shields are strictly optional: core protection never depends on them.
 */
(() => {
  if (window.__auvyqFpActive === true) return;
  window.__auvyqFpActive = true;

  function createHostPrng() {
    const host = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'localhost';
    let seed = 0x811c9dc5;
    for (let i = 0; i < host.length; i++) {
      seed = (Math.imul(seed ^ host.charCodeAt(i), 0x01000193)) >>> 0;
    }
    return function nextNoise(idx) {
      let t = (seed + Math.imul(idx, 0x6D2B79F5)) | 0;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t >>> 14) % 3) - 1; // subtle deterministic delta: -1, 0, or +1
    };
  }

  function installCanvasShield() {
    const getNoise = createHostPrng();
    try {
      const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function getImageData(...args) {
        const data = originalGetImageData.apply(this, args);
        // Create a copy of the ImageData buffer to avoid mutating backing store
        const cloned = new ImageData(new Uint8ClampedArray(data.data), data.width, data.height);
        for (let i = 0; i < cloned.data.length; i += 4) {
          cloned.data[i] = Math.max(0, Math.min(255, cloned.data[i] + getNoise(i)));
        }
        return cloned;
      };
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
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
                imgData.data[i] = Math.max(0, Math.min(255, imgData.data[i] + getNoise(i)));
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

  function installWebglShield() {
    try {
      const masked = {
        vendor: 'Google Inc. (Intel)',
        renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0)'
      };
      const original = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function getParameter(parameter) {
        if (parameter === 37445) return masked.vendor;  // UNMASKED_VENDOR_WEBGL
        if (parameter === 37446) return masked.renderer; // UNMASKED_RENDERER_WEBGL
        return original.call(this, parameter);
      };
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const original2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function getParameter(parameter) {
          if (parameter === 37445) return masked.vendor;
          if (parameter === 37446) return masked.renderer;
          return original2.call(this, parameter);
        };
      }
    } catch { /* non-fatal */ }
  }

  function installNavigatorShield() {
    try {
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
        get: () => 4,
        configurable: true
      });
      Object.defineProperty(Navigator.prototype, 'deviceMemory', {
        get: () => 4,
        configurable: true
      });
    } catch { /* non-fatal */ }
  }

  function installScreenShield() {
    try {
      Object.defineProperty(Screen.prototype, 'availLeft', { get: () => 0, configurable: true });
      Object.defineProperty(Screen.prototype, 'availTop', { get: () => 0, configurable: true });
    } catch { /* non-fatal */ }
  }

  function installTimingShield() {
    try {
      const originalNow = Performance.prototype.now;
      Performance.prototype.now = function now() {
        return Math.round(originalNow.call(this) * 10) / 10; // 0.1ms precision
      };
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
})();
