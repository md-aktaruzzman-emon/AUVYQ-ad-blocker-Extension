/*
 * Resource validator for AUVYQ.
 * Verifies all bundled static assets, brand SVG/PNG files, rules, and scripts exist.
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

const REQUIRED_FILES = [
  'manifest.json',
  'sw.js',
  'offscreen.js',
  'assets/logo.svg',
  'assets/logo-light.svg',
  'assets/logo-dark.svg',
  'assets/logo-mono.svg',
  'assets/wordmark.svg',
  'assets/icon16.png',
  'assets/icon32.png',
  'assets/icon48.png',
  'assets/icon128.png',
  'content/cosmetic-injector.js',
  'content/scriptlet-dispatch.js',
  'content/fp-shields.js',
  'content/warning-banner.js',
  'ui/motion.css',
  'ui/motion.js',
  'ui/popup/popup.html',
  'ui/popup/popup.js',
  'ui/popup/popup.css',
  'ui/dashboard/dashboard.html',
  'ui/dashboard/dashboard.js',
  'ui/dashboard/dashboard.css',
  'ui/site-report/report.html',
  'ui/site-report/report.js',
  'ui/site-report/report.css',
  'ui/onboarding/onboarding.html',
  'ui/onboarding/onboarding.js',
  'ui/onboarding/onboarding.css',
  'resources/1x1.gif',
  'resources/noop.js',
  'rules/main.json',
  'rules/annoyances.json',
  'rules/ads-trackers.json',
  'rules/easylist.json',
  'rules/easyprivacy.json',
  'data/cosmetic/generic.css',
  'data/cosmetic/specific.json',
  'data/scriptlets/dispatch.json',
  'licenses/EASYLIST-LICENSE.txt',
  'licenses/EASYPRIVACY-LICENSE.txt',
  'licenses/UBLOCK-LICENSE.txt',
  'data/tracking-params.json',
  'data/default-filters.txt',
  'data/scriptlet-map.json',
  'data/top-domains.json',
  'data/cookie-classification.json',
  '_locales/en/messages.json'
];

export function validateResources(targetDir) {
  for (const relPath of REQUIRED_FILES) {
    const fullPath = path.join(targetDir, relPath);
    if (!existsSync(fullPath)) {
      throw new Error(`Required file missing: ${relPath} (expected at ${fullPath})`);
    }
    const stat = statSync(fullPath);
    if (stat.size === 0 && !relPath.endsWith('noop.js')) {
      throw new Error(`Required file is empty: ${relPath}`);
    }
  }
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('validate-resources.mjs')) {
  const dir = process.argv[2] || (existsSync(path.join(process.cwd(), 'dist', 'manifest.json')) ? path.join(process.cwd(), 'dist') : process.cwd());
  validateResources(dir);
  console.log('Resource validation passed.');
}
