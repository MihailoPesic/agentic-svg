// Proof harness for src/core/tonematch.js (audit S4: global haze / tone drift).
//
// For each washy test image: convert at quality=high, apply matchTone against
// the full-res source, report dssim before/after + fitted gain/bias, and save
// out/exp_tone_<name>.png as a side-by-side (original | before | after).
// Control images (logo, gradient) must pass through untouched or near-untouched.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { convertImage } from '../src/core/pipeline.js';
import { matchTone } from '../src/core/tonematch.js';
import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

const CASES = [
  { file: 'testdata/meme.png', name: 'meme' },
  { file: 'testdata/photo-signage.jpg', name: 'signage' },
  { file: 'testdata/sign-gradient.png', name: 'signgrad' },
  { file: 'fixtures/logo.png', name: 'logo', control: true },
  { file: 'fixtures/gradient.png', name: 'gradient', control: true },
];

function sideBySide(a, b, c, W, H) {
  const out = new Uint8ClampedArray(W * 3 * H * 4);
  const panes = [a, b, c];
  for (let y = 0; y < H; y++) {
    for (let p = 0; p < 3; p++) {
      const src = panes[p];
      for (let x = 0; x < W; x++) {
        const si = (y * W + x) * 4, di = (y * W * 3 + p * W + x) * 4;
        out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = 255;
      }
    }
  }
  return { width: W * 3, height: H, data: out };
}

await mkdir(OUT, { recursive: true });

for (const { file, name, control } of CASES) {
  const inputPath = path.join(ROOT, file);
  const t0 = Date.now();
  const result = await convertImage(inputPath, { quality: 'high' });

  // Full-res source, capped so dssim/render stay tractable on huge photos.
  const meta = await sharp(inputPath).metadata();
  const cap = Math.min(Math.max(meta.width, meta.height), 1024);
  const target = await loadImage(inputPath, { maxSize: cap });

  const tone = matchTone(result.svg, target);

  const W = target.width, H = target.height;
  const beforeR = renderSvgToRgba(result.svg, W, H);
  const afterR = tone.applied ? renderSvgToRgba(tone.svg, W, H) : beforeR;
  const png = await toPng(sideBySide(target.data, beforeR.data, afterR.data, W, H));
  const outPng = path.join(OUT, `exp_tone_${name}.png`);
  await writeFile(outPng, png);

  const fmt = (n) => Number.isFinite(n) ? n.toFixed(6) : String(n);
  console.log(
    `${name}${control ? ' [control]' : ''}: applied=${tone.applied} method=${tone.method || '-'}` +
    ` dssim ${fmt(tone.dssimBefore)} -> ${fmt(tone.dssimAfter)}` +
    ` (${((1 - tone.dssimAfter / tone.dssimBefore) * 100).toFixed(2)}% better)` +
    ` gain=[${tone.gain.join(', ')}] bias=[${tone.bias.join(', ')}]` +
    ` ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outPng}`
  );
}
