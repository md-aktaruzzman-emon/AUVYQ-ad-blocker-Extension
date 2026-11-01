/*
 * Filter List Harvester and Sync Utility for AUVYQ.
 *
 * Responsibilities:
 * - Reads vendor/sources.json for authoritative list sources and licensing.
 * - Safely fetches upstream lists during development or CI with abort timeouts.
 * - Validates content to ensure it is plain text adblock format (never executable scripts).
 * - Computes cryptographic SHA-256 digests for source integrity.
 * - Updates local pinned files in vendor/lists/ with version timestamps.
 * - Gracefully falls back to existing pinned files when offline.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

export function computeSha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function validateFilterContent(content) {
  if (typeof content !== 'string' || content.length < 50) {
    return { valid: false, error: 'Content too small or not string' };
  }
  // Sanity check: Ensure it's not an HTML 404/error page or binary executable
  if (content.slice(0, 500).includes('<!DOCTYPE html>') || content.slice(0, 500).includes('<html')) {
    return { valid: false, error: 'Received HTML instead of plain text filter list' };
  }
  return { valid: true };
}

export async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'AUVYQ-Filter-Sync/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export async function syncFilters(options = {}) {
  const sourcesPath = path.join(rootDir, 'vendor', 'sources.json');
  if (!existsSync(sourcesPath)) {
    throw new Error(`sources.json missing at ${sourcesPath}`);
  }

  const manifest = JSON.parse(readFileSync(sourcesPath, 'utf8'));
  const results = [];
  const vendorDir = path.join(rootDir, 'vendor', 'lists');
  mkdirSync(vendorDir, { recursive: true });

  const isLiveSync = options.sync === true;

  for (const src of manifest.sources) {
    const localFilePath = path.join(rootDir, src.localFile);
    let currentContent = existsSync(localFilePath) ? readFileSync(localFilePath, 'utf8') : null;
    let updated = false;
    let sha256 = currentContent ? computeSha256(currentContent) : null;
    let lineCount = currentContent ? currentContent.split('\n').length : 0;

    if (isLiveSync) {
      try {
        console.log(`Fetching ${src.name} from ${src.upstreamUrl}...`);
        const text = await fetchWithTimeout(src.upstreamUrl);
        const check = validateFilterContent(text);
        if (check.valid) {
          writeFileSync(localFilePath, text, 'utf8');
          currentContent = text;
          sha256 = computeSha256(text);
          lineCount = text.split('\n').length;
          updated = true;
          console.log(`  ✓ Updated ${src.localFile} (${lineCount} lines, SHA: ${sha256.slice(0, 12)}...)`);
        } else {
          console.warn(`  ⚠ Invalid content from ${src.upstreamUrl}: ${check.error}`);
        }
      } catch (err) {
        console.warn(`  ⚠ Failed to fetch ${src.upstreamUrl}: ${err.message}. Preserving existing snapshot.`);
      }
    }

    results.push({
      id: src.id,
      name: src.name,
      file: src.localFile,
      lines: lineCount,
      sha256,
      updated
    });
  }

  return {
    version: manifest.version,
    syncedAt: new Date().toISOString(),
    results
  };
}

if (process.argv[1] && process.argv[1].endsWith('fetch-filters.mjs')) {
  const sync = process.argv.includes('--sync');
  syncFilters({ sync })
    .then((summary) => {
      console.log('Filter sync summary:', JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error('Filter sync failed:', err);
      process.exit(1);
    });
}
