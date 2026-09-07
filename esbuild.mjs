/*
 * AUVYQ build pipeline:
 *   clean dist -> generate brand assets (icons, gif) -> bundle TS entries -> copy static assets -> validate
 * Output: dist/ (load as an unpacked extension in Chrome).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, cp, rm, access } from 'node:fs/promises';
import * as esbuild from 'esbuild';
import { generateIcons } from './tools/gen-icons.mjs';
import { writeNoopGif } from './tools/gen-gif.mjs';
import { compileFilters } from './tools/compile-filters.mjs';
import { validateManifest } from './tools/validate-manifest.mjs';
import { validateResources } from './tools/validate-resources.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(rootDir, 'dist');

const STATIC_ASSETS = [
  'manifest.json',
  'assets',
  'content',
  'ui',
  'resources',
  'rules',
  'data',
  'licenses',
  'vendor',
  '_locales',
  'fixtures'
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyStatic() {
  for (const entry of STATIC_ASSETS) {
    const src = path.join(rootDir, entry);
    if (!(await exists(src))) throw new Error(`Required static asset missing: ${entry}`);
    await cp(src, path.join(distDir, entry), { recursive: true });
  }
}

async function buildOnce() {
  await rm(distDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });

  // 1. Build-time filter compiler: compile EasyList, EasyPrivacy, annoyances & scriptlets
  compileFilters(rootDir);

  // 2. Brand assets are generated from the authoritative geometry before copying.
  await generateIcons(rootDir);
  await writeNoopGif(path.join(rootDir, 'resources'));

  await esbuild.build({
    entryPoints: [path.join(rootDir, 'sw.ts'), path.join(rootDir, 'offscreen.ts')],
    outdir: distDir,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info'
  });

  await copyStatic();
  validateManifest(distDir);
  validateResources(distDir);
  console.log('AUVYQ build complete: dist/');
}

const watch = process.argv.includes('--watch');
if (watch) {
  const ctx = await esbuild.context({});
  void ctx;
  // Rebuild loop: run buildOnce on change of any source tree.
  const { watch: fsWatch } = await import('node:fs');
  const dirs = ['core', 'platform-chrome', 'ui', 'content', 'assets', 'rules', 'data', '_locales'];
  for (const dir of dirs) fsWatch(path.join(rootDir, dir), { recursive: true }, () => {
    buildOnce().catch((err) => console.error('rebuild failed:', err.message));
  });
  await buildOnce();
  console.log('watching for changes...');
} else {
  await buildOnce();
}
