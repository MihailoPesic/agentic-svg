// Sweep VTracer params + trace resolution to find the config that vectorizes
// PHOTOS with minimal posterization/banding while staying a reasonable size.
//
// Usage: node scripts/photo-trace-tune.js
// Calls @neplex/vectorizer directly on fixtures/photo.png + fixtures/orb.png,
// measures dssim (render.js + metrics.js) and SVG bytes per config, prints a
// table, and writes out/exp_photo-trace-tune.png (original | current poster | best).

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';
import { loadImage } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { TRACE_PRESETS } from '../src/core/trace.js';

const root = path.resolve(fileURLToPath(import.meta.url), '../..');
const fx = (n) => path.join(root, 'fixtures', n);
const outDir = path.join(root, 'out');

// Compare images at a fixed eval size so dssim is consistent across trace res.
const EVAL = 800;

// Trace a PNG buffer (optionally pre-scaled to traceW) and score it against the
// reference RGBA (at EVAL size).
async function scoreConfig(srcBuf, ref, cfg, traceScale) {
  let buf = srcBuf;
  let meta = await sharp(srcBuf).metadata();
  if (traceScale !== 1) {
    const w = Math.round(meta.width * traceScale);
    buf = await sharp(srcBuf).resize(w, null, { kernel: 'cubic' }).png().toBuffer();
  }
  const t0 = Date.now();
  const svg = await vectorize(buf, cfg);
  const traceMs = Date.now() - t0;
  const bytes = Buffer.byteLength(svg, 'utf8');
  const r = renderSvgToRgba(svg, ref.width, ref.height);
  const d = dssim(ref.data, r.data, ref.width, ref.height);
  return { svg, bytes, dssim: d, traceMs };
}

// Build a reference RGBA at EVAL size for scoring.
async function refAt(name) {
  return loadImage(fx(name), { maxSize: EVAL });
}

const base = {
  colorMode: ColorMode.Color,
  cornerThreshold: 60,
  lengthThreshold: 4,
  maxIterations: 10,
  spliceThreshold: 45,
  pathPrecision: 2,
};

// Parameter grid. Kept focused so the run finishes in a couple minutes.
function buildGrid() {
  const grid = [];
  const colorPrec = [6, 7, 8];
  const layerDiff = [4, 8, 12, 16];
  const speckle = [2, 4, 8, 12];
  const modes = [
    ['spline', PathSimplifyMode.Spline],
    ['polygon', PathSimplifyMode.Polygon],
  ];
  const hier = [
    ['stacked', Hierarchical.Stacked],
    ['cutout', Hierarchical.Cutout],
  ];
  const scales = [1, 0.75, 0.5];
  for (const cp of colorPrec)
    for (const ld of layerDiff)
      for (const fs of speckle)
        for (const [mn, mv] of modes)
          for (const [hn, hv] of hier)
            for (const sc of scales) {
              grid.push({
                label: `cp${cp}_ld${ld}_fs${fs}_${mn}_${hn}_s${sc}`,
                scale: sc,
                cfg: { ...base, colorPrecision: cp, layerDifference: ld, filterSpeckle: fs, mode: mv, hierarchical: hv },
              });
            }
  return grid;
}

// Full grid is large (3*4*4*2*2*3 = 1152 per image). That's too slow. Use a
// two-phase sweep: a coarse grid on key axes, then refine the best.
function coarseGrid() {
  const grid = [];
  const variants = [
    // colorPrecision sweep (fixed others)
    { cp: 6, ld: 8, fs: 8, mode: 'spline', hier: 'stacked' },
    { cp: 7, ld: 8, fs: 8, mode: 'spline', hier: 'stacked' },
    { cp: 8, ld: 8, fs: 8, mode: 'spline', hier: 'stacked' },
    // layerDifference sweep (lower = finer gradient steps = less banding)
    { cp: 8, ld: 4, fs: 8, mode: 'spline', hier: 'stacked' },
    { cp: 8, ld: 6, fs: 8, mode: 'spline', hier: 'stacked' },
    { cp: 8, ld: 12, fs: 8, mode: 'spline', hier: 'stacked' },
    { cp: 8, ld: 16, fs: 8, mode: 'spline', hier: 'stacked' },
    // filterSpeckle sweep
    { cp: 8, ld: 4, fs: 2, mode: 'spline', hier: 'stacked' },
    { cp: 8, ld: 4, fs: 4, mode: 'spline', hier: 'stacked' },
    { cp: 8, ld: 4, fs: 12, mode: 'spline', hier: 'stacked' },
    // mode + hierarchical
    { cp: 8, ld: 4, fs: 4, mode: 'polygon', hier: 'stacked' },
    { cp: 8, ld: 4, fs: 4, mode: 'spline', hier: 'cutout' },
    { cp: 8, ld: 4, fs: 4, mode: 'polygon', hier: 'cutout' },
    // best-guess low-band + finer detail
    { cp: 8, ld: 4, fs: 2, mode: 'spline', hier: 'stacked' },
    { cp: 7, ld: 4, fs: 4, mode: 'spline', hier: 'stacked' },
  ];
  const scales = [1, 0.75, 0.5];
  for (const v of variants) {
    for (const sc of scales) {
      const mv = v.mode === 'spline' ? PathSimplifyMode.Spline : PathSimplifyMode.Polygon;
      const hv = v.hier === 'stacked' ? Hierarchical.Stacked : Hierarchical.Cutout;
      grid.push({
        label: `cp${v.cp}_ld${v.ld}_fs${v.fs}_${v.mode[0]}_${v.hier[0]}_s${sc}`,
        scale: sc,
        cfg: { ...base, colorPrecision: v.cp, layerDifference: v.ld, filterSpeckle: v.fs, mode: mv, hierarchical: hv },
      });
    }
  }
  return grid;
}

function fidPerByte(r) {
  // lower dssim is better; normalize against bytes (KB). Score = improvement / KB.
  return (1 - r.dssim) / (r.bytes / 1024);
}

async function run() {
  const images = ['photo.png', 'orb.png'];
  const refs = {};
  const srcBufs = {};
  for (const n of images) {
    refs[n] = await refAt(n);
    srcBufs[n] = await readFile(fx(n));
  }

  // Current poster preset baseline (scale 1).
  const posterCfg = TRACE_PRESETS.poster;

  const grid = coarseGrid();
  const rows = [];
  console.log(`Sweeping ${grid.length} configs x ${images.length} images...\n`);

  // Baseline row per image.
  const baseline = {};
  for (const n of images) {
    const r = await scoreConfig(srcBufs[n], refs[n], posterCfg, 1);
    baseline[n] = r;
    console.log(`[baseline poster] ${n}: dssim=${r.dssim.toFixed(4)} bytes=${(r.bytes / 1024).toFixed(1)}KB`);
  }
  console.log('');

  for (const g of grid) {
    const per = {};
    for (const n of images) {
      try {
        per[n] = await scoreConfig(srcBufs[n], refs[n], g.cfg, g.scale);
      } catch (e) {
        per[n] = { bytes: Infinity, dssim: 1, traceMs: 0, err: e.message };
      }
    }
    const avgD = (per['photo.png'].dssim + per['orb.png'].dssim) / 2;
    const avgKB = (per['photo.png'].bytes + per['orb.png'].bytes) / 2048;
    const fpb = (per['photo.png'].bytes === Infinity) ? 0
      : ((fidPerByte(per['photo.png']) + fidPerByte(per['orb.png'])) / 2);
    rows.push({ label: g.label, scale: g.scale, cfg: g.cfg, per, avgD, avgKB, fpb });
    console.log(
      `${g.label.padEnd(28)} photo d=${per['photo.png'].dssim.toFixed(4)} ${(per['photo.png'].bytes / 1024).toFixed(0)}KB | ` +
      `orb d=${per['orb.png'].dssim.toFixed(4)} ${(per['orb.png'].bytes / 1024).toFixed(0)}KB | avgD=${avgD.toFixed(4)} fpb=${fpb.toFixed(4)}`
    );
  }

  // Best pure fidelity (min avg dssim) and best fidelity-per-byte.
  const byFid = [...rows].sort((a, b) => a.avgD - b.avgD);
  const byFpb = [...rows].sort((a, b) => b.fpb - a.fpb);
  const bestFid = byFid[0];
  const bestFpb = byFpb[0];

  console.log('\n=== TOP 8 BY PURE FIDELITY (avg dssim) ===');
  for (const r of byFid.slice(0, 8))
    console.log(`${r.label.padEnd(28)} avgD=${r.avgD.toFixed(4)} avgKB=${r.avgKB.toFixed(1)} fpb=${r.fpb.toFixed(4)}`);

  console.log('\n=== TOP 8 BY FIDELITY-PER-BYTE ===');
  for (const r of byFpb.slice(0, 8))
    console.log(`${r.label.padEnd(28)} fpb=${r.fpb.toFixed(4)} avgD=${r.avgD.toFixed(4)} avgKB=${r.avgKB.toFixed(1)}`);

  console.log('\n=== BASELINE (current poster preset, scale 1) ===');
  for (const n of images)
    console.log(`${n}: dssim=${baseline[n].dssim.toFixed(4)} bytes=${(baseline[n].bytes / 1024).toFixed(1)}KB`);

  // Build the comparison strip for photo.png: original | current poster | best fidelity.
  await buildCompare(srcBufs['photo.png'], refs['photo.png'], baseline['photo.png'], bestFid);

  console.log('\nBEST_FIDELITY', JSON.stringify({ label: bestFid.label, scale: bestFid.scale, cfg: bestFid.cfg }));
  console.log('BEST_FPB', JSON.stringify({ label: bestFpb.label, scale: bestFpb.scale, cfg: bestFpb.cfg }));
}

async function buildCompare(srcBuf, ref, baseRow, bestRow) {
  const W = ref.width, H = ref.height;
  // Re-render best at eval size.
  const best = await scoreConfig(srcBuf, ref, bestRow.cfg, bestRow.scale);
  const toPngBuf = (rgba) =>
    sharp(Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength), {
      raw: { width: W, height: H, channels: 4 },
    }).png().toBuffer();

  const origPng = await sharp(srcBuf).resize(W, H, { fit: 'fill' }).png().toBuffer();
  const baseR = renderSvgToRgba(baseRow.svg, W, H);
  const bestR = renderSvgToRgba(best.svg, W, H);
  const basePng = await toPngBuf(baseR);
  const bestPng = await toPngBuf(bestR);

  const gap = 8;
  const stripW = W * 3 + gap * 2;
  const out = await sharp({
    create: { width: stripW, height: H, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 1 } },
  })
    .composite([
      { input: origPng, left: 0, top: 0 },
      { input: basePng, left: W + gap, top: 0 },
      { input: bestPng, left: (W + gap) * 2, top: 0 },
    ])
    .png()
    .toBuffer();
  const outPath = path.join(outDir, 'exp_photo-trace-tune.png');
  await writeFile(outPath, out);
  console.log(`\nWrote ${outPath} (original | current poster | best: ${bestRow.label})`);
}

run().catch((e) => { console.error(e); process.exit(1); });
