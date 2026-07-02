// Splat experiment harness.
//   1. Fidelity: internal compositing vs resvg render of the emitted SVG.
//   2. Real images: VTracer poster trace + splat residual fit vs the current
//      full pipeline, measured by DSSIM at work res. Saves side-by-side PNGs
//      to out/exp_splat_<name>.png (original | pipeline | trace+splats).
//
// Run: node scripts/test-splat.js

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { rmse, dssim } from '../src/core/metrics.js';
import { traceImage, TRACE_PRESETS } from '../src/core/trace.js';
import { innerSvg } from '../src/core/converge.js';
import { convertImage } from '../src/core/pipeline.js';
import { GaussianSplat, drawWeighted, fitSplats } from '../src/core/splat.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const WORK_RES = 320;

function fidelityCheck() {
  const W = 256, H = 256;
  const canvas = new Float32Array(W * H * 4);
  for (let i = 0; i < W * H * 4; i += 4) {
    canvas[i] = 128; canvas[i + 1] = 128; canvas[i + 2] = 128; canvas[i + 3] = 255;
  }
  const defs = [], els = [];
  for (let n = 0; n < 40; n++) {
    const s = GaussianSplat.random(W, H);
    s.color = [(Math.random() * 256) | 0, (Math.random() * 256) | 0, (Math.random() * 256) | 0];
    drawWeighted(canvas, s.footprint(W, H), s.color, W);
    const { def, el } = s.svg(`sp${n}`);
    defs.push(def);
    els.push(el);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="rgb(128,128,128)"/>` +
    `<defs>${defs.join('')}</defs>${els.join('')}</svg>`;
  const rendered = renderSvgToRgba(svg, W, H);
  return rmse(new Uint8ClampedArray(canvas), rendered.data, W, H);
}

async function sideBySide(images, file) {
  const gap = 8;
  const W = images[0].width, H = images[0].height;
  const composites = [];
  for (let i = 0; i < images.length; i++) {
    composites.push({ input: await toPng(images[i]), left: i * (W + gap), top: 0 });
  }
  await sharp({
    create: { width: W * images.length + gap * (images.length - 1), height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(composites).png().toFile(file);
}

// Coarse "shading" base: high layerDifference so the trace only does geometry
// and the splats own the smooth shading. A fine poster trace already matches
// the smooth areas in the mean, leaving only zero-mean posterization bands —
// a residual no smooth splat can reduce, so the banding survives. Starting
// coarse gives the splats a residual they can actually fix.
const SHADING_PRESET = { ...TRACE_PRESETS.poster, layerDifference: 48, colorPrecision: 4 };

async function traceSplat(work, preset, budget) {
  const W = work.width, H = work.height;
  const t0 = performance.now();
  const traceSvg = await traceImage(await toPng(work), preset);
  const seed = renderSvgToRgba(traceSvg, W, H);
  const baseDssim = dssim(work.data, seed.data, W, H);
  const fit = fitSplats(work, seed.data, { budget });
  const composed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `${innerSvg(traceSvg)}<g><defs>${fit.defs}</defs>${fit.body}</g></svg>`;
  const sec = (performance.now() - t0) / 1000;
  const render = renderSvgToRgba(composed, W, H);
  return {
    baseDssim,
    dssim: dssim(work.data, render.data, W, H),
    rmse: fit.score,
    bytes: Buffer.byteLength(composed),
    sec,
    added: fit.added,
    render,
  };
}

async function runFixture(name, budget = 500) {
  const file = path.join(ROOT, 'fixtures', `${name}.png`);
  const work = await loadImage(file, { maxSize: WORK_RES });
  const W = work.width, H = work.height;

  // Current full pipeline at quality high.
  const t0 = performance.now();
  const cur = await convertImage(file, { quality: 'high' });
  const curSec = (performance.now() - t0) / 1000;
  const curRender = renderSvgToRgba(cur.svg, W, H);
  const curDssim = dssim(work.data, curRender.data, W, H);

  // Splats over the stock poster base and over the coarse shading base.
  // Near-ties go to the shading base: DSSIM under-penalizes the posterization
  // bands a fine trace leaks through the splat layer (see photo's sun), so a
  // small metric edge for the poster base doesn't outweigh visible banding.
  const poster = await traceSplat(work, TRACE_PRESETS.poster, budget);
  const shading = await traceSplat(work, SHADING_PRESET, budget);
  const best = shading.dssim < poster.dssim * 1.15 ? shading : poster;

  await sideBySide(
    [work, { width: W, height: H, data: curRender.data }, { width: W, height: H, data: best.render.data }],
    path.join(OUT, `exp_splat_${name}.png`),
  );

  return {
    name,
    curDssim, curBytes: cur.metrics.finalBytes, curSec,
    poster, shading,
    bestBase: best === shading ? 'shading' : 'poster',
  };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const fid = fidelityCheck();
  console.log(`fidelity rmse (internal vs resvg, 40 splats): ${fid.toFixed(5)}  ${fid < 0.015 ? 'PASS' : 'FAIL'}`);

  const rows = [];
  for (const name of ['orb', 'photo', 'soft-face', 'sticker']) {
    const r = await runFixture(name);
    rows.push(r);
    for (const [base, s] of [['poster', r.poster], ['shading', r.shading]]) {
      console.log(`${name}/${base}: trace-only dssim ${s.baseDssim.toFixed(4)} -> +splats ${s.dssim.toFixed(4)} (rmse ${s.rmse.toFixed(4)}, ${s.added} splats, ${s.sec.toFixed(1)}s)`);
    }
    console.log(`${name}: pipeline dssim ${r.curDssim.toFixed(4)} (${r.curSec.toFixed(1)}s); best splat base: ${r.bestBase}`);
  }

  console.log('\nfixture      pipe-dssim  splat-dssim  base      pipe-bytes  splat-bytes  pipe-s  splat-s  splats');
  for (const r of rows) {
    const s = r.bestBase === 'shading' ? r.shading : r.poster;
    console.log(
      `${r.name.padEnd(12)} ${r.curDssim.toFixed(4).padStart(9)}  ${s.dssim.toFixed(4).padStart(10)}  ${r.bestBase.padEnd(8)}  ${String(r.curBytes).padStart(10)}  ${String(s.bytes).padStart(11)}  ${r.curSec.toFixed(1).padStart(6)}  ${s.sec.toFixed(1).padStart(7)}  ${String(s.added).padStart(6)}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
