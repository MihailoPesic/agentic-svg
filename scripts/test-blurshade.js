// Proof harness for the blur-shading base (src/core/blurshade.js).
// For each fixture: build the blurred base at work res 384, score it against
// the plain (unblurred) shading trace, verify svgo keeps the filter, and save
// original | unblurred | blurred side-by-sides to out/.
//
//   node scripts/test-blurshade.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadImage } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { buildBlurShade } from '../src/core/blurshade.js';
import { finalizeSvg } from '../src/core/pipeline.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = ['sticker', 'soft-face', 'photo', 'scene', 'orb'];
// convertImage(high) reference points, from out/benchmark.md + task notes.
const PIPELINE_REF = {
  sticker: '0.0060 / 102.8KB (splats)',
  'soft-face': '0.0090 / 113.3KB',
  photo: '0.0163 / 79.8KB',
  scene: '0.0039 / 9.4KB',
  orb: '0.0079 / 79.5KB',
};

const kb = (n) => `${(n / 1024).toFixed(1)}KB`;

async function stripPng(img) {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  }).png().toBuffer();
}

async function sideBySide(images, outPath) {
  const W = images[0].width, H = images[0].height, gap = 4;
  const bufs = await Promise.all(images.map(stripPng));
  await sharp({
    create: { width: (W + gap) * images.length - gap, height: H, channels: 4, background: { r: 24, g: 24, b: 24, alpha: 1 } },
  }).composite(bufs.map((input, i) => ({ input, left: i * (W + gap), top: 0 }))).png().toFile(outPath);
}

// Mean edge alpha/luma drop check: compare border-band pixels of blurred
// render against the work image to catch the letterbox thin-out failure mode.
function edgeError(a, b, W, H, band = 3) {
  let sum = 0, n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x >= band && x < W - band && y >= band && y < H - band) continue;
      const i = (y * W + x) * 4;
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      n += 3;
    }
  }
  return sum / n / 255;
}

const rows = [];
for (const name of FIXTURES) {
  const fixture = path.join(root, 'fixtures', `${name}.png`);
  const work = await loadImage(fixture, { maxSize: 384 });
  const { width: W, height: H } = work;

  const t0 = Date.now();
  const bs = await buildBlurShade(work);
  const ms = Date.now() - t0;

  const blurR = renderSvgToRgba(bs.svg, W, H);
  const blurD = dssim(work.data, blurR.data, W, H);
  const blurBytes = Buffer.byteLength(bs.svg);

  // Plain shading trace, no blur (same paths, same canvas).
  const plainR = renderSvgToRgba(bs.traceSvg, W, H);
  const plainD = dssim(work.data, plainR.data, W, H);
  const plainBytes = Buffer.byteLength(bs.traceSvg);

  // svgo survival: same config as pipeline finalizeSvg.
  const opt = finalizeSvg(bs.svg);
  const optBytes = Buffer.byteLength(opt);
  const filterKept = opt.includes('<filter') && (opt.includes('feGaussianBlur') || opt.includes('stdDeviation'));
  let optD = NaN;
  try {
    const optR = renderSvgToRgba(opt, W, H);
    optD = dssim(work.data, optR.data, W, H);
  } catch { /* unrenderable after svgo -> reported below */ }

  const edge = edgeError(work.data, blurR.data, W, H);

  await sideBySide([work, plainR, blurR], path.join(root, 'out', `exp_blurshade_${name}.png`));

  rows.push({
    name, W, H, ms,
    stdDev: bs.stdDev, sweep: bs.sweep,
    blurD, blurBytes, plainD, plainBytes,
    optD, optBytes, filterKept, edge,
  });
}

console.log('\nfixture      | work    | stdDev | blur dssim | blur bytes | plain dssim | plain bytes | svgo dssim | svgo bytes | filter | edge err | pipeline high');
console.log('-------------|---------|--------|------------|------------|-------------|-------------|------------|------------|--------|----------|--------------');
for (const r of rows) {
  console.log([
    r.name.padEnd(12),
    `${r.W}x${r.H}`.padEnd(7),
    String(r.stdDev).padEnd(6),
    r.blurD.toFixed(4).padEnd(10),
    kb(r.blurBytes).padEnd(10),
    r.plainD.toFixed(4).padEnd(11),
    kb(r.plainBytes).padEnd(11),
    (Number.isNaN(r.optD) ? 'RENDER FAIL' : r.optD.toFixed(4)).padEnd(10),
    kb(r.optBytes).padEnd(10),
    (r.filterKept ? 'kept' : 'LOST').padEnd(6),
    r.edge.toFixed(4).padEnd(8),
    PIPELINE_REF[r.name],
  ].join(' | '));
}
console.log('\nstdDev sweeps (dssim per S):');
for (const r of rows) {
  console.log(`  ${r.name.padEnd(12)} ${r.sweep.map((s) => `${s.stdDev}=>${s.dssim.toFixed(4)}`).join('  ')}`);
}
