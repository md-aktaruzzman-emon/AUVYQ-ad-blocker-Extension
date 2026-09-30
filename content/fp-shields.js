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

  function installCanvasShield() {
    const noise = () => (Math.random() - 0.5) * 2; // subtle per-readback variation
    try {
      const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
      CanvasRenderingContext2D.prototype.getImageData = function getImageData(...args) {
        const data = originalGetImageData.apply(this, args);
        for (let i = 0; i < data.data.length; i += 4) {
          data.data[i] = Math.max(0, Math.min(255, data.data[i] + noise()));
        }
        return data;
      };
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function toDataURL(...args) {
        const context = this.getContext('2d');
        if (context !== null && this.width > 0 && this.height > 0) {
          try {
            const image = originalGetImageData.call(context, 0, 0, this.width, this.height);
            for (let i = 0; i < image.data.length; i += 4) {
              image.data[i] = Math.max(0, Math.min(255, image.data[i] + noise()));
            }
            context.putImageData(image, 0, 0);
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
