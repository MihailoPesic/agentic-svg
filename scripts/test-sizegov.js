// Size-governor experiment: bytes-vs-dssim curve across the trace ladder.
//
// For each test image: trace every ladder rung at the photo route's trace
// resolution (high quality: 1400px), render at work res (384), measure DSSIM
// vs the work image plus raw and post-svgo bytes. Prints the curve, marks the
// first rung under 600KB final, and saves original|rung0|chosen side-by-sides.
//
// Run: node scripts/test-sizegov.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { vectorizeRaw } from '@neplex/vectorizer';
import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { fitPrimitives } from '../src/core/pathfit.js';
import { finalizeSvg } from '../src/core/pipeline.js';
import { TRACE_PRESETS } from '../src/core/trace.js';
import { chooseTraceLadder, estimateBytes, SVGO_FACTOR } from '../src/core/sizegov.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK_RES = 384;   // 'high' quality workRes
const TRACE_RES = 1400; // 'high' quality photo-route traceRes
const CAP = 600 * 1024;

const IMAGES = [
  { name: 'painting', file: 'testdata/painting.jpg', save: true },
  { name: 'landscape', file: 'testdata/photo-landscape.jpg', save: true },
  { name: 'signage', file: 'testdata/photo-signage.jpg', save: false },
  { name: 'orb', file: 'fixtures/orb.png', save: false }, // control: already small
];

function kb(n) { return (n / 1024).toFixed(1) + 'KB'; }

async function traceRung(traceImg, preset) {
  const buf = Buffer.from(traceImg.data.buffer, traceImg.data.byteOffset, traceImg.data.byteLength);
  const svg = await vectorizeRaw(buf, { width: traceImg.width, height: traceImg.height }, preset);
  return fitPrimitives(svg);
}

async function sideBySide(outPath, work, rows) {
  // rows: array of {width,height,data} all at work res
  const W = work.width, H = work.height;
  const panels = [work, ...rows];
  const pngs = await Promise.all(panels.map((p) => toPng(p)));
  const gap = 4;
  const totalW = panels.length * W + (panels.length - 1) * gap;
  const composite = pngs.map((png, i) => ({ input: png, left: i * (W + gap), top: 0 }));
  await sharp({ create: { width: totalW, height: H, channels: 3, background: { r: 24, g: 24, b: 24 } } })
    .composite(composite).png().toFile(outPath);
}

const factorSamples = [];

for (const img of IMAGES) {
  const input = path.join(ROOT, img.file);
  const work = await loadImage(input, { maxSize: WORK_RES });
  const traceImg = await loadImage(input, { maxSize: TRACE_RES });
  const W = work.width, H = work.height;
  const ladder = chooseTraceLadder(TRACE_PRESETS.poster);

  console.log(`\n=== ${img.name} (${img.file})  trace@${traceImg.width}x${traceImg.height}, work@${W}x${H} ===`);
  console.log('rung | filterSpeckle/layerDiff/colorPrec | rawBytes | svgoBytes | factor | est(final) | dssim');

  const results = [];
  for (let r = 0; r < ladder.length; r++) {
    const p = ladder[r];
    const t0 = Date.now();
    const svg = await traceRung(traceImg, p);
    const raw = Buffer.byteLength(svg);
    const final = Buffer.byteLength(finalizeSvg(svg));
    const rendered = renderSvgToRgba(svg, W, H);
    const d = dssim(work.data, rendered.data, W, H);
    const est = estimateBytes(svg).estimatedFinal;
    factorSamples.push({ img: img.name, rung: r, factor: final / raw });
    results.push({ rung: r, raw, final, est, dssim: d, rendered });
    console.log(
      `${r}    | ${p.filterSpeckle}/${p.layerDifference}/${p.colorPrecision}`.padEnd(38) +
      `| ${kb(raw).padEnd(9)}| ${kb(final).padEnd(10)}| ${(final / raw).toFixed(3)}  | ${kb(est).padEnd(9)} | ${d.toFixed(5)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`
    );
  }

  const r0 = results[0];
  const chosen = results.find((r) => r.final <= CAP);
  if (chosen) {
    const dCost = r0.dssim > 0 ? ((chosen.dssim - r0.dssim) / r0.dssim) * 100 : 0;
    console.log(`first rung <= ${kb(CAP)}: rung ${chosen.rung}  (${kb(chosen.final)}, dssim ${chosen.dssim.toFixed(5)} vs rung0 ${r0.dssim.toFixed(5)}, ${dCost >= 0 ? '+' : ''}${dCost.toFixed(1)}% dssim, ${(100 - (chosen.final / r0.final) * 100).toFixed(0)}% smaller)`);
  } else {
    console.log(`NO rung got under ${kb(CAP)} — deepest rung: ${kb(results.at(-1).final)}`);
  }

  if (img.save) {
    const outPath = path.join(ROOT, 'out', `exp_sizegov_${img.name}.png`);
    const pick = chosen && chosen.rung !== 0 ? chosen : results.at(-1);
    await sideBySide(outPath, work, [r0.rendered, pick.rendered]);
    console.log(`saved ${outPath}  (original | rung0 | rung${pick.rung})`);
  }
}

const avg = factorSamples.reduce((s, f) => s + f.factor, 0) / factorSamples.length;
const max = Math.max(...factorSamples.map((f) => f.factor));
console.log(`\nsvgo factor samples: avg ${avg.toFixed(3)}, worst ${max.toFixed(3)} (SVGO_FACTOR in sizegov.js: ${SVGO_FACTOR})`);
