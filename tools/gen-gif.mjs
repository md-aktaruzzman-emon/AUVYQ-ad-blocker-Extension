/*
 * Writes resources/1x1.gif: the standard 43-byte transparent 1x1 GIF89a.
 * Used as the redirect target for advertising pixels (harmless, offline).
 */
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const TRANSPARENT_1X1_GIF = Buffer.from([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
  0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, // 1x1, no global color table
  0x00, 0x00, 0x00, // background color index + aspect
  0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, // graphic control
  0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // image descriptor
  0x02, 0x02, 0x44, 0x01, 0x00, // LZW data
  0x3b // trailer
]);

export async function writeNoopGif(resourcesDir) {
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(path.join(resourcesDir, '1x1.gif'), TRANSPARENT_1X1_GIF);
  return true;
}

// CLI support
if (process.argv[1] !== undefined && process.argv[1].endsWith('gen-gif.mjs') && process.argv[2] !== undefined) {
  await writeNoopGif(process.argv[2]);
  console.log('1x1.gif written');
}
