/*
 * Manifest V3 validator for AUVYQ.
 * Ensures strict Manifest V3 hygiene, valid entry points, permissions, CSP, and assets.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function validateManifest(targetDir) {
  const manifestPath = path.join(targetDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${targetDir}`);
  }

  const raw = readFileSync(manifestPath, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err.message}`);
  }

  if (manifest.manifest_version !== 3) {
    throw new Error(`manifest_version must be 3, found ${manifest.manifest_version}`);
  }

  if (typeof manifest.name !== 'string' || manifest.name.length === 0) {
    throw new Error('manifest.name is required and must be a non-empty string');
  }

  if (!/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error(`manifest.version must follow semver, found ${manifest.version}`);
  }

  if (manifest.background?.service_worker !== 'sw.js' || manifest.background?.type !== 'module') {
    throw new Error('manifest.background must specify service_worker: "sw.js" and type: "module"');
  }

  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("script-src 'self'") || csp.includes("'unsafe-eval'") || csp.includes("'wasm-unsafe-eval'")) {
    throw new Error(`manifest CSP must be strict and avoid unsafe-eval: found "${csp}"`);
  }

  // Verify icon references exist in targetDir
  if (manifest.icons) {
    for (const [size, iconRelPath] of Object.entries(manifest.icons)) {
      const fullPath = path.join(targetDir, iconRelPath);
      if (!existsSync(fullPath)) {
        throw new Error(`manifest icon ${size}px not found at ${fullPath}`);
      }
    }
  }

  // Verify DNR rule resources exist
  if (manifest.declarative_net_request?.rule_resources) {
    for (const res of manifest.declarative_net_request.rule_resources) {
      const fullPath = path.join(targetDir, res.path);
      if (!existsSync(fullPath)) {
        throw new Error(`DNR rule resource "${res.id}" not found at ${fullPath}`);
      }
    }
  }

  // Verify action popup and options page
  if (manifest.action?.default_popup) {
    const fullPath = path.join(targetDir, manifest.action.default_popup);
    if (!existsSync(fullPath)) {
      throw new Error(`Action default_popup not found at ${fullPath}`);
    }
  }

  if (manifest.options_page) {
    const fullPath = path.join(targetDir, manifest.options_page);
    if (!existsSync(fullPath)) {
      throw new Error(`Options page not found at ${fullPath}`);
    }
  }

  // Verify content scripts exist in targetDir
  if (Array.isArray(manifest.content_scripts)) {
    for (const cs of manifest.content_scripts) {
      if (Array.isArray(cs.js)) {
        for (const jsFile of cs.js) {
          const fullPath = path.join(targetDir, jsFile);
          if (!existsSync(fullPath)) {
            throw new Error(`Content script "${jsFile}" not found at ${fullPath}`);
          }
        }
      }
    }
  }

  return true;
}

if (process.argv[1] && process.argv[1].endsWith('validate-manifest.mjs')) {
  const dir = process.argv[2] || (existsSync(path.join(process.cwd(), 'dist', 'manifest.json')) ? path.join(process.cwd(), 'dist') : process.cwd());
  validateManifest(dir);
  console.log('Manifest validation passed.');
}
