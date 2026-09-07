/*
 * Icon generator: rasterizes the authoritative AUVYQ mark geometry (identical to
 * assets/logo.svg) into icon16/32/48/128 PNGs. Zero dependencies: hand-rolled PNG
 * encoder on top of node:zlib.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// PNG encoding
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------------------
// Mark geometry — must stay identical to assets/logo.svg (512 viewBox, /512 = unit).
// Visibility follows the same evenodd parity: disc XOR triangle XOR innerRegion XOR hole.
// ---------------------------------------------------------------------------

const BIG = { x: 256 / 512, y: 240.6 / 512, r: 197.1 / 512 };
const HOLE = { x: 255 / 512, y: 377 / 512, r: 24 / 512 };
const TRIANGLE = [
  { x: 266.3 / 512, y: 84.1 / 512 },
  { x: 384 / 512, y: 323 / 512 },
  { x: 152 / 512, y: 295 / 512 }
];
// innerRegion boundary: cubic from L to R, then the disc's top arc back to L.
const CUBIC_L = { x: 73.9 / 512, y: 205.1 / 512 };
const CUBIC_C1 = { x: 195.7 / 512, y: 353.7 / 512 };
const CUBIC_C2 = { x: 275.7 / 512, y: 378.6 / 512 };
const CUBIC_R = { x: 401.9 / 512, y: 311.6 / 512 };
const ARC = { x: BIG.x, y: BIG.y, r: 200 / 512, half: 3.5 / 512, aStart: -85, aEnd: -10 };
const GOLD = { x: 255 / 512, y: 419 / 512, r: 8.5 / 512 };

const COLOR_A = [0x43, 0x38, 0xca]; // #4338CA
const COLOR_B = [0x5b, 0x4b, 0xff]; // #5B4BFF
const COLOR_CYAN = [0x22, 0xd3, 0xee];
const COLOR_GOLD = [0xc9, 0xa4, 0x68];

// Sample the innerRegion boundary into a polygon (cubic + top arc).
const INNER_POLYGON = (() => {
  const points = [];
  const N = 72;
  const bez = (t) => {
    const u = 1 - t;
    return {
      x: u * u * u * CUBIC_L.x + 3 * u * u * t * CUBIC_C1.x + 3 * u * t * t * CUBIC_C2.x + t * t * t * CUBIC_R.x,
      y: u * u * u * CUBIC_L.y + 3 * u * u * t * CUBIC_C1.y + 3 * u * t * t * CUBIC_C2.y + t * t * t * CUBIC_R.y
    };
  };
  for (let i = 0; i <= N; i++) points.push(bez(i / N));
  // Arc from R back to L through the top (counterclockwise on screen).
  const aStart = Math.atan2(CUBIC_R.y - BIG.y, CUBIC_R.x - BIG.x);
  let aEnd = Math.atan2(CUBIC_L.y - BIG.y, CUBIC_L.x - BIG.x);
  while (aEnd > aStart) aEnd -= 2 * Math.PI; // go counterclockwise (decreasing angle)
  for (let i = 1; i <= N; i++) {
    const a = aStart + (aEnd - aStart) * (i / N);
    points.push({ x: BIG.x + BIG.r * Math.cos(a), y: BIG.y + BIG.r * Math.sin(a) });
  }
  return points;
})();

function dist(px, py, cx, cy) {
  return Math.hypot(px - cx, py - cy);
}

function angleDeg(px, py, cx, cy) {
  let a = (Math.atan2(py - cy, px - cx) * 180) / Math.PI;
  if (a < 0) a += 360;
  return a;
}

function inSector(a, start, end) {
  const s = (start + 360) % 360;
  const e = (end + 360) % 360;
  return s <= e ? a >= s && a <= e : a >= s || a <= e;
}

function pointInTriangle(px, py, tri) {
  const [p0, p1, p2] = tri;
  const d1 = sign(px, py, p0, p1);
  const d2 = sign(px, py, p1, p2);
  const d3 = sign(px, py, p2, p0);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sign(px, py, a, b) {
  return (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
}

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersects = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function inMark(px, py) {
  const inDisc = dist(px, py, BIG.x, BIG.y) <= BIG.r;
  if (!inDisc) return false;
  const inTri = pointInTriangle(px, py, TRIANGLE);
  const inInner = pointInPolygon(px, py, INNER_POLYGON);
  const inHole = dist(px, py, HOLE.x, HOLE.y) <= HOLE.r;
  // evenodd parity across the four subpaths
  return inDisc !== inTri !== inInner !== inHole;
}

function sampleColor(px, py) {
  const arcR = dist(px, py, ARC.x, ARC.y);
  const arcA = angleDeg(px, py, ARC.x, ARC.y);
  if (Math.abs(arcR - ARC.r) <= ARC.half && inSector(arcA, ARC.aStart, ARC.aEnd)) {
    return [...COLOR_CYAN, 255];
  }
  if (dist(px, py, GOLD.x, GOLD.y) <= GOLD.r) {
    return [...COLOR_GOLD, 255];
  }
  if (!inMark(px, py)) return [0, 0, 0, 0];
  // Brand gradient along (0.2,0.85) -> (0.8,0.15)
  const ax = 0.2, ay = 0.85, bx = 0.8, by = 0.15;
  const t = Math.min(1, Math.max(0, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return [
    Math.round(COLOR_A[0] + (COLOR_B[0] - COLOR_A[0]) * t),
    Math.round(COLOR_A[1] + (COLOR_B[1] - COLOR_A[1]) * t),
    Math.round(COLOR_A[2] + (COLOR_B[2] - COLOR_A[2]) * t),
    255
  ];
}

function rasterize(size) {
  const rgba = new Uint8Array(size * size * 4);
  const ss = 3; // 3x3 supersampling
  const scale = 1 - 2 * 0.12; // 12% safe padding
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = ((x + (sx + 0.5) / ss) / size - 0.12) / scale;
          const py = ((y + (sy + 0.5) / ss) / size - 0.12) / scale;
          const [cr, cg, cb, ca] = sampleColor(px, py);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const idx = (y * size + x) * 4;
      if (a > 0) {
        rgba[idx] = Math.round(r / a);
        rgba[idx + 1] = Math.round(g / a);
        rgba[idx + 2] = Math.round(b / a);
        rgba[idx + 3] = Math.round(a / (ss * ss));
      }
    }
  }
  return encodePng(size, size, rgba);
}

import { stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

const BROWSER_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

function findBrowser() {
  return BROWSER_PATHS.find((p) => existsSync(p));
}

function renderWithBrowser(browser, svgContent, size, outPath) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>* { margin: 0; padding: 0; } html, body { width: ${size}px; height: ${size}px; background: transparent !important; overflow: hidden; } svg { width: ${size}px; height: ${size}px; display: block; }</style></head><body>${svgContent}</body></html>`;
  const tmpHtml = path.join(path.dirname(outPath), `.tmp_render_${size}.html`);
  writeFile(tmpHtml, html);
  try {
    execFileSync(browser, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${outPath}`,
      `file:///${tmpHtml.replace(/\\/g, '/')}`
    ]);
  } finally {
    try {
      unlinkSync(tmpHtml);
    } catch {
      // Temporary file cleanup is best-effort
    }
  }
}

export async function generateIcons(rootDir) {
  const assetsDir = path.join(rootDir, 'assets');
  await mkdir(assetsDir, { recursive: true });
  const sizes = [16, 32, 48, 128];
  let allExist = true;

  for (const size of sizes) {
    const p = path.join(assetsDir, `icon${size}.png`);
    try {
      const s = await stat(p);
      if (s.size < 100) allExist = false;
    } catch {
      allExist = false;
    }
  }

  if (allExist && !process.argv.includes('--force-icons')) {
    return true;
  }

  const browser = findBrowser();
  const logoSvgPath = path.join(assetsDir, 'logo.svg');
  if (browser && existsSync(logoSvgPath)) {
    const svgContent = readFileSync(logoSvgPath, 'utf8');
    for (const size of sizes) {
      const outPath = path.join(assetsDir, `icon${size}.png`);
      renderWithBrowser(browser, svgContent, size, outPath);
    }
    return true;
  }

  for (const size of sizes) {
    const png = rasterize(size);
    await writeFile(path.join(assetsDir, `icon${size}.png`), png);
  }
  return true;
}

// CLI: node tools/gen-icons.mjs [previewSize outPath]
const argv = process.argv.slice(2);
if (argv.length === 2) {
  const size = Number(argv[0]);
  const out = argv[1];
  await writeFile(out, rasterize(size));
  console.log(`preview written: ${out}`);
}

