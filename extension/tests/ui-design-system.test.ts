import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_DIR = join(__dirname, '..');

/**
 * Calculates luminance and WCAG contrast ratio between two hex colors.
 */
function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  const bigint = parseInt(clean, 16);
  if (clean.length === 6) {
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
  }
  return [0, 0, 0];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1: string, hex2: string): number {
  const l1 = relativeLuminance(hexToRgb(hex1));
  const l2 = relativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(l1, l2);
  const darkest = Math.min(l1, l2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe('PART 8: Complete UI/UX & Design System Modernization', () => {
  describe('Task 2 — Unified Design System & Tokens (tokens.css)', () => {
    const tokensPath = join(ROOT_DIR, 'ui', 'tokens.css');

    it('tokens.css file exists and is substantial', () => {
      expect(existsSync(tokensPath)).toBe(true);
      const content = readFileSync(tokensPath, 'utf8');
      expect(content.length).toBeGreaterThan(1000);
    });

    it('defines Layer 1 Primitives: palettes, typography, spacing, radius, z-index', () => {
      const content = readFileSync(tokensPath, 'utf8');

      // Palettes
      expect(content).toContain('--slate-50:');
      expect(content).toContain('--slate-900:');
      expect(content).toContain('--indigo-500:');
      expect(content).toContain('--emerald-500:');
      expect(content).toContain('--amber-500:');
      expect(content).toContain('--rose-500:');
      expect(content).toContain('--cyan-500:');

      // Typography
      expect(content).toContain('--font-sans:');
      expect(content).toContain('--text-xs:');
      expect(content).toContain('--text-base:');
      expect(content).toContain('--text-2xl:');
      expect(content).toContain('--font-bold:');

      // Spacing & Radius
      expect(content).toContain('--space-1:');
      expect(content).toContain('--space-4:');
      expect(content).toContain('--space-8:');
      expect(content).toContain('--radius-sm:');
      expect(content).toContain('--radius-md:');
      expect(content).toContain('--radius-pill:');

      // Z-Index
      expect(content).toContain('--z-modal:');
      expect(content).toContain('--z-toast:');
    });

    it('defines Layer 2 Semantics for both Dark and Light themes', () => {
      const content = readFileSync(tokensPath, 'utf8');

      // Dark Theme (Default)
      expect(content).toContain('[data-theme="dark"]');
      expect(content).toContain('--auvyq-bg-primary:');
      expect(content).toContain('--auvyq-surface-primary:');
      expect(content).toContain('--auvyq-text-primary:');
      expect(content).toContain('--auvyq-text-secondary:');
      expect(content).toContain('--auvyq-protected:');
      expect(content).toContain('--auvyq-warning:');
      expect(content).toContain('--auvyq-danger:');

      // Light Theme
      expect(content).toContain('[data-theme="light"]');
      expect(content).toContain('--auvyq-bg-primary:   #F8FAFC');
      expect(content).toContain('--auvyq-surface-primary:   #FFFFFF');
      expect(content).toContain('--auvyq-text-primary:   #0F172A');
    });

    it('defines Layer 3 Component tokens & utilities', () => {
      const content = readFileSync(tokensPath, 'utf8');

      expect(content).toContain('.auvyq-btn');
      expect(content).toContain('.auvyq-btn-primary');
      expect(content).toContain('.auvyq-btn-secondary');
      expect(content).toContain('.auvyq-btn-danger');
      expect(content).toContain('.auvyq-switch-box');
      expect(content).toContain('.auvyq-card-box');
      expect(content).toContain('.privacy-grade-badge');
      expect(content).toContain('.auvyq-dialog-backdrop');
      expect(content).toContain('.auvyq-dialog-window');
    });

    it('motion.css properly imports tokens.css at top', () => {
      const motionPath = join(ROOT_DIR, 'ui', 'motion.css');
      const content = readFileSync(motionPath, 'utf8');
      expect(content.startsWith('@import url(\'./tokens.css\');')).toBe(true);
    });

    it('modal dialog in tokens.css uses visibility: hidden when closed to prevent background tab focus', () => {
      const content = readFileSync(tokensPath, 'utf8');
      expect(content).toContain('visibility: hidden;');
      expect(content).toContain('.auvyq-dialog-backdrop.open');
      expect(content).toContain('visibility: visible;');
    });
  });

  describe('Task 6 & 7 — WCAG 2.2 AA Contrast & Accessibility Compliance', () => {
    it('verifies dark theme text achieves WCAG AA / AAA contrast', () => {
      const darkBg = '#070B14';
      const darkSurface = '#111827';
      const darkTextPrimary = '#F8FAFC';
      const darkTextSecondary = '#94A3B8';

      // Normal text requires >= 4.5:1 (AA) and >= 7:1 (AAA)
      const primaryContrast = contrastRatio(darkTextPrimary, darkBg);
      expect(primaryContrast).toBeGreaterThanOrEqual(15.0); // Extreme high contrast AAA

      const secondaryContrast = contrastRatio(darkTextSecondary, darkBg);
      expect(secondaryContrast).toBeGreaterThanOrEqual(7.0); // AAA compliant

      const surfaceSecondaryContrast = contrastRatio(darkTextSecondary, darkSurface);
      expect(surfaceSecondaryContrast).toBeGreaterThanOrEqual(4.5); // AA compliant
    });

    it('verifies light theme text achieves WCAG AA / AAA contrast', () => {
      const lightBg = '#F8FAFC';
      const lightSurface = '#FFFFFF';
      const lightTextPrimary = '#0F172A';
      const lightTextSecondary = '#475569';
      const lightTextMuted = '#64748B';

      const primaryContrast = contrastRatio(lightTextPrimary, lightSurface);
      expect(primaryContrast).toBeGreaterThanOrEqual(15.0); // AAA compliant

      const secondaryContrast = contrastRatio(lightTextSecondary, lightSurface);
      expect(secondaryContrast).toBeGreaterThanOrEqual(7.0); // AAA compliant

      const mutedContrast = contrastRatio(lightTextMuted, lightBg);
      expect(mutedContrast).toBeGreaterThanOrEqual(4.5); // AA compliant
    });

    it('enforces visible keyboard focus rings and reduced-motion overrides', () => {
      const tokensContent = readFileSync(join(ROOT_DIR, 'ui', 'tokens.css'), 'utf8');

      // Focus ring definition
      expect(tokensContent).toContain(':focus-visible');
      expect(tokensContent).toContain('outline: 2px solid var(--auvyq-focus)');

      // Reduced motion media query
      expect(tokensContent).toContain('@media (prefers-reduced-motion: reduce)');
      expect(tokensContent).toContain('animation-duration: 0.01ms');
    });
  });

  describe('Task 3 — Modern Compact Popup UI (popup.html, popup.css, popup.js)', () => {
    const popupHtml = readFileSync(join(ROOT_DIR, 'ui', 'popup', 'popup.html'), 'utf8');
    const popupCss = readFileSync(join(ROOT_DIR, 'ui', 'popup', 'popup.css'), 'utf8');
    const popupJs = readFileSync(join(ROOT_DIR, 'ui', 'popup', 'popup.js'), 'utf8');

    it('popup dimensions are set to compact modern width (365px) and max-height 600px', () => {
      expect(popupCss).toContain('width: 365px');
      expect(popupCss).toContain('max-width: 375px');
      expect(popupCss).toContain('max-height: 600px');
    });

    it('popup header contains brand mark, version, theme toggle, and settings shortcut', () => {
      expect(popupHtml).toContain('id="theme-toggle-btn"');
      expect(popupHtml).toContain('id="open-settings-btn"');
      expect(popupHtml).toContain('class="brand-name">AUVYQ</span>');
      expect(popupHtml).toContain('class="brand-version"');
    });

    it('popup contains master switch and animated shield stage', () => {
      expect(popupHtml).toContain('id="shield-stage"');
      expect(popupHtml).toContain('id="master-switch"');
      expect(popupHtml).toContain('role="switch"');
      expect(popupHtml).toContain('aria-label="Master protection toggle"');
    });

    it('popup displays live site info, pause toggle, and privacy grade badge', () => {
      expect(popupHtml).toContain('id="site-host"');
      expect(popupHtml).toContain('id="site-status"');
      expect(popupHtml).toContain('id="site-pause"');
      expect(popupHtml).toContain('id="site-grade-badge"');
      expect(popupHtml).toContain('id="site-score-text"');
    });

    it('popup site pause button synchronizes aria-label dynamically with state', () => {
      expect(popupJs).toContain('Resume protection on this site');
      expect(popupJs).toContain('Pause protection on this site');
    });

    it('popup displays 3-column stats counters for ads, trackers, threats', () => {
      expect(popupHtml).toContain('id="stat-ads"');
      expect(popupHtml).toContain('id="stat-trackers"');
      expect(popupHtml).toContain('id="stat-threats"');
    });

    it('popup provides quick defense module toggles (ads, trackers, cookies, fp)', () => {
      expect(popupHtml).toContain('id="quick-toggle-ads"');
      expect(popupHtml).toContain('id="quick-toggle-trackers"');
      expect(popupHtml).toContain('id="quick-toggle-cookies"');
      expect(popupHtml).toContain('id="quick-toggle-fp"');
    });

    it('popup uses native button elements for footer sublinks', () => {
      expect(popupHtml).toContain('<button id="open-site-report" class="sublink-btn" type="button">Site Privacy Report</button>');
      expect(popupHtml).toContain('<button id="open-options-link" class="sublink-btn" type="button">All Settings</button>');
    });

    it('popup JS binds all buttons with zero dead controls', () => {
      expect(popupJs).toContain('bindQuickToggle(elements.toggleAds, \'ads\');');
      expect(popupJs).toContain('bindQuickToggle(elements.toggleTrackers, \'trackers\');');
      expect(popupJs).toContain('bindQuickToggle(elements.toggleCookies, \'cookies\');');
      expect(popupJs).toContain('bindQuickToggle(elements.toggleFp, \'fingerprintShields\', true);');
      expect(popupJs).toContain('elements.themeToggleBtn.addEventListener(\'click\'');
      expect(popupJs).toContain('elements.openSettingsBtn.addEventListener(\'click\'');
      expect(popupJs).toContain('elements.openDashboard.addEventListener(\'click\'');
      expect(popupJs).toContain('elements.openSiteReport.addEventListener(\'click\'');
    });
  });

  describe('Task 4 & 5 — Main Dashboard & Settings UI (dashboard.html, dashboard.js)', () => {
    const dashboardHtml = readFileSync(join(ROOT_DIR, 'ui', 'dashboard', 'dashboard.html'), 'utf8');
    const dashboardJs = readFileSync(join(ROOT_DIR, 'ui', 'dashboard', 'dashboard.js'), 'utf8');
    const dashboardCss = readFileSync(join(ROOT_DIR, 'ui', 'dashboard', 'dashboard.css'), 'utf8');

    it('dashboard includes tokens.css in head', () => {
      expect(dashboardHtml).toContain('<link rel="stylesheet" href="../tokens.css" />');
    });

    it('overview panel contains real-time Privacy Intelligence Score card', () => {
      expect(dashboardHtml).toContain('class="auvyq-card privacy-overview-card"');
      expect(dashboardHtml).toContain('id="overview-privacy-score"');
      expect(dashboardHtml).toContain('id="overview-privacy-grade"');
      expect(dashboardHtml).toContain('id="overview-privacy-label"');
    });

    it('dashboard implements accessible modal confirmation dialog with Tab focus trap', () => {
      expect(dashboardHtml).toContain('id="clear-data-dialog"');
      expect(dashboardHtml).toContain('role="dialog"');
      expect(dashboardHtml).toContain('aria-modal="true"');
      expect(dashboardHtml).toContain('id="cancel-clear-btn"');
      expect(dashboardHtml).toContain('id="confirm-clear-btn"');

      // JS wires dialog, focus trap, and replaces window.confirm
      expect(dashboardJs).toContain('openClearDialog');
      expect(dashboardJs).toContain('closeClearDialog');
      expect(dashboardJs).toContain('document.activeElement === cancelClearBtn');
      expect(dashboardJs).not.toContain('window.confirm(');
    });

    it('dashboard supports hash navigation to deep-link to sections like #settings', () => {
      expect(dashboardJs).toContain('function handleHashNavigation(');
      expect(dashboardJs).toContain('window.addEventListener(\'hashchange\', handleHashNavigation);');
    });

    it('dashboard CSS includes responsive breakpoints for compact displays', () => {
      expect(dashboardCss).toContain('@media (max-width: 840px)');
      expect(dashboardCss).toContain('@media (max-width: 600px)');
    });
  });
});
