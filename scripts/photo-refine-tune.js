// photo-refine-tune.js — sweep converge() refinement options on photos to find
// settings that reduce perceptual blockiness (not just RMSE).
//
// Runs converge() directly on fixtures/photo.png and fixtures/orb.png with a
// grid of refineOpts (shape, alpha, budget, block, topK, expand, maxAreaFrac).
// Scores each by DSSIM (work-res) against the source, and renders the best
// combo into a side-by-side original | current-default | best PNG so the
// blockiness can be judged by eye.
//
//   node scripts/photo-refine-tune.js
//
// Output: out/exp_photo-refine-tune.png + a printed table.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { converge } from '../src/core/converge.js';
import { TRACE_PRESETS } from '../src/core/trace.js';
import { loadImage } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = (n) => path.join(ROOT, 'fixtures', n);
const OUT = (n) => path.join(ROOT, 'out', n);

// Compare resolution: high enough that banding/blockiness is visible.
const CMP = 512;

// One converge run + DSSIM measured at a fixed compare resolution against the
// original (independent of converge's internal workRes).
async function score(input, opts, cmpImg) {
  const t0 = Date.now();
  const res = await converge(input, opts);
  const rendered = renderSvgToRgba(res.svg, cmpImg.width, cmpImg.height);
  const d = dssim(cmpImg.data, rendered.data, cmpImg.width, cmpImg.height);
  return {
    dssim: d,
    workDssim: res.metrics.finalDssim,
    shapes: res.metrics.shapesTotal,
    bytes: Buffer.byteLength(res.svg),
    base: res.metrics.base,
    reverted: res.metrics.reverted,
    ms: Date.now() - t0,
    svg: res.svg,
  };
}

// Base options shared by every combo (mirror the photo path in classify.js).
function baseOpts(extra = {}) {
  return {
    workRes: 320,
    traceRes: 1000,
    strategy: 'trace-refine',
    tracePreset: TRACE_PRESETS.poster,
    saliency: true,
    targetDssim: 0.006,
    plateauRelGain: 0.012,
    ...extra,
  };
}

async function main() {
  const fixtures = [
    { name: 'photo', file: FIX('photo.png') },
    { name: 'orb', file: FIX('orb.png') },
  ];

  // The combos. "current" reproduces today's photo defaults (shape any, alpha
  // 0.8, budget 160, default refineOpts). The rest probe the blockiness levers:
  //   - softer alpha => translucent shapes blend instead of stamping flat slabs
  //   - ellipse/rotatedellipse => round falloff vs hard polygon edges (banding)
  //   - smaller maxAreaFrac => no large flat slabs over smooth gradients
  //   - finer block / higher topK => spread shapes, don't pile on one region
  const combos = [
    { label: 'current', shape: 'any', alpha: 0.8, budget: 160, refineOpts: {} },
    { label: 'ell-a55', shape: 'ellipse', alpha: 0.55, budget: 200, refineOpts: {} },
    { label: 'rell-a60', shape: 'rotatedellipse', alpha: 0.6, budget: 200, refineOpts: {} },
    { label: 'tri-a60-small', shape: 'triangle', alpha: 0.6, budget: 200,
      refineOpts: { maxAreaFrac: 0.02, block: 12, topK: 10, expand: 1.2 } },
    // The recommended setting: rotated ellipses, soft alpha, finer/smaller cells
    // so shapes spread out and blend instead of stamping flat slabs.
    { label: 'rell-fine', shape: 'rotatedellipse', alpha: 0.55, budget: 280,
      refineOpts: { maxAreaFrac: 0.04, block: 12, topK: 12, expand: 1.3 } },
    { label: 'rell-a45-fine', shape: 'rotatedellipse', alpha: 0.45, budget: 350,
      refineOpts: { maxAreaFrac: 0.05, block: 14, topK: 10, expand: 1.4 } },
  ];

  const results = {};
  for (const fx of fixtures) {
    const cmpImg = await loadImage(fx.file, { maxSize: CMP });
    results[fx.name] = [];
    console.log(`\n=== ${fx.name} (cmp ${cmpImg.width}x${cmpImg.height}) ===`);
    console.log('label            dssim     workDssim shapes  bytes   base          ms');
    for (const combo of combos) {
      const opts = baseOpts({
        shape: combo.shape, alpha: combo.alpha, budget: combo.budget,
        refineOpts: combo.refineOpts,
      });
      const s = await score(fx.file, opts, cmpImg);
      results[fx.name].push({ ...combo, ...s });
      console.log(
        `${combo.label.padEnd(16)} ${s.dssim.toFixed(5)}  ${s.workDssim.toFixed(5)}   ` +
        `${String(s.shapes).padStart(4)}  ${String(s.bytes).padStart(6)}  ${(s.base || '').padEnd(13)} ${s.ms}`,
      );
    }
  }

  // Build the triptych for the photo: original | current | best (lowest dssim).
  await buildTriptych(fixtures[0].file, results.photo);

  // Print the winners.
  for (const fx of fixtures) {
    const rows = results[fx.name];
    const cur = rows.find((r) => r.label === 'current');
    const best = rows.reduce((a, b) => (b.dssim < a.dssim ? b : a));
    console.log(`\n${fx.name}: current dssim=${cur.dssim.toFixed(5)} -> best '${best.label}' dssim=${best.dssim.toFixed(5)} ` +
      `(${(((cur.dssim - best.dssim) / cur.dssim) * 100).toFixed(1)}% better, ${best.shapes} shapes, ${best.bytes}B)`);
  }
}

async function buildTriptych(file, rows) {
  const cur = rows.find((r) => r.label === 'current');
  const best = rows.reduce((a, b) => (b.dssim < a.dssim ? b : a));
  const H = 420;
  const orig = await sharp(file).resize({ height: H }).toBuffer();
  const om = await sharp(orig).metadata();
  const w = om.width;
  const panels = [];
  for (const [label, svg] of [['current', cur.svg], [`best:${best.label}`, best.svg]]) {
    const png = renderSvgToRgba(svg, w, H);
    const buf = await sharp(Buffer.from(png.data.buffer, png.data.byteOffset, png.data.byteLength), {
      raw: { width: w, height: H, channels: 4 },
    }).png().toBuffer();
    panels.push(buf);
  }
  const gap = 8;
  const totalW = w * 3 + gap * 2;
  const canvas = sharp({ create: { width: totalW, height: H, channels: 4, background: { r: 30, g: 30, b: 30, alpha: 1 } } });
  await canvas
    .composite([
      { input: orig, left: 0, top: 0 },
      { input: panels[0], left: w + gap, top: 0 },
      { input: panels[1], left: (w + gap) * 2, top: 0 },
    ])
    .png()
    .toFile(OUT('exp_photo-refine-tune.png'));
  console.log(`\nwrote ${OUT('exp_photo-refine-tune.png')} (original | current | best:${best.label})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
