// Proof harness for the layered-quantization tracer (src/core/layertrace.js).
// K-sweep on ui / world-map / comic-char, compared against the current
// pipeline and the imagetracer hq64 baselines from out/benchmark.md.
//
//   node scripts/test-layertrace.js            # full sweep + comparison PNGs
//   node scripts/test-layertrace.js --probe    # binary-mode semantics probe only

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vectorizeRaw, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';
import sharp from 'sharp';
import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { convertImage, finalizeSvg } from '../src/core/pipeline.js';
import { layerTrace, nearestUpscale } from '../src/core/layertrace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');

// ---------------------------------------------------------------------------
// Binary-mode semantics probe: what does VTracer Binary treat as foreground?
async function probeBinarySemantics() {
  const W = 32, H = 32;
  const img = (bg, sq) => {
    const d = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { d[i * 4] = bg[0]; d[i * 4 + 1] = bg[1]; d[i * 4 + 2] = bg[2]; d[i * 4 + 3] = bg[3]; }
    for (let y = 8; y < 24; y++) for (let x = 8; x < 24; x++) {
      const i = (y * W + x) * 4;
      d[i] = sq[0]; d[i + 1] = sq[1]; d[i + 2] = sq[2]; d[i + 3] = sq[3];
    }
    return d;
  };
  const cfg = {
    colorMode: ColorMode.Binary, hierarchical: Hierarchical.Stacked, mode: PathSimplifyMode.Spline,
    filterSpeckle: 2, colorPrecision: 6, layerDifference: 16, cornerThreshold: 60,
    lengthThreshold: 4, maxIterations: 10, spliceThreshold: 45, pathPrecision: 1,
  };
  const cases = {
    'black sq / white bg (opaque)': img([255, 255, 255, 255], [0, 0, 0, 255]),
    'white sq / black bg (opaque)': img([0, 0, 0, 255], [255, 255, 255, 255]),
    'black sq / transparent bg': img([0, 0, 0, 0], [0, 0, 0, 255]),
    'mid-gray sq (128) / white bg': img([255, 255, 255, 255], [128, 128, 128, 255]),
    'gray 100 sq / white bg': img([255, 255, 255, 255], [100, 100, 100, 255]),
    'gray 160 sq / white bg': img([255, 255, 255, 255], [160, 160, 160, 255]),
  };
  for (const [name, d] of Object.entries(cases)) {
    const svg = await vectorizeRaw(d, { width: W, height: H }, cfg);
    const paths = (svg.match(/<path/g) || []).length;
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map((m) => m[1]);
    console.log(`  ${name}: paths=${paths} fills=[${fills.join(',')}]`);
    if (paths) console.log(`    first path d=${(svg.match(/d="([^"]{0,60})/) || [])[1]}...`);
  }
}

// ---------------------------------------------------------------------------
const BASELINES = { // imagetracer hq64 numbers from out/benchmark.md
  ui: { dssim: 0.0126, kb: 78.8 },
  'world-map': { dssim: 0.0069, kb: 25.6 },
};

async function run() {
  await mkdir(OUT, { recursive: true });
  console.log('== binary-mode semantics probe ==');
  await probeBinarySemantics();
  if (process.argv.includes('--probe')) return;

  const fixtures = ['ui', 'world-map', 'comic-char'];
  const Ks = [32, 48, 64];
  const rows = [];
  const best = {};

  for (const name of fixtures) {
    const file = path.join(ROOT, 'fixtures', `${name}.png`);
    const src = await loadImage(file); // source resolution reference
    const meta = { w: src.width, h: src.height };
    // 2x upscaled trace input: text needs pixels. NEAREST, not cubic — a
    // smooth resample invents blended colors that wash the palette out
    // (ui: 0.022 cubic vs 0.0013 nearest).
    const traceImg = nearestUpscale(src, 2);
    console.log(`\n== ${name} (${meta.w}x${meta.h}, traced at ${traceImg.width}x${traceImg.height}) ==`);

    let bestK = null;
    for (const K of Ks) {
      const t0 = Date.now();
      const svg = await layerTrace(traceImg, { colors: K });
      const secs = (Date.now() - t0) / 1000;
      const fin = finalizeSvg(svg);
      const r = renderSvgToRgba(fin, meta.w, meta.h);
      const d = dssim(src.data, r.data, meta.w, meta.h);
      const kb = Buffer.byteLength(fin) / 1024;
      rows.push({ name, K, dssim: d, kb, secs });
      console.log(`  K=${K}: dssim=${d.toFixed(4)} bytes=${kb.toFixed(1)}KB time=${secs.toFixed(1)}s`);
      if (!bestK || d < bestK.dssim) bestK = { K, svg: fin, dssim: d, kb };
    }
    best[name] = bestK;

    // current pipeline at quality high
    const t0 = Date.now();
    const cur = await convertImage(file, { quality: 'high' });
    const curSecs = (Date.now() - t0) / 1000;
    const curR = renderSvgToRgba(cur.svg, meta.w, meta.h);
    const curD = dssim(src.data, curR.data, meta.w, meta.h);
    console.log(`  pipeline-high: dssim=${curD.toFixed(4)} bytes=${(Buffer.byteLength(cur.svg) / 1024).toFixed(1)}KB time=${curSecs.toFixed(1)}s`);
    const bl = BASELINES[name];
    if (bl) console.log(`  imagetracer-hq64 baseline: dssim=${bl.dssim} bytes=${bl.kb}KB`);

    // side-by-side: original | pipeline | layerTrace best-K
    const lay = renderSvgToRgba(bestK.svg, meta.w, meta.h);
    const strip = await compose([src, curR, lay], meta.w, meta.h);
    const outPng = path.join(OUT, `exp_layertrace_${name}.png`);
    await writeFile(outPng, strip);
    await writeFile(path.join(OUT, `exp_layertrace_${name}.svg`), bestK.svg);
    console.log(`  saved ${outPng} (original | pipeline-high | layerTrace K=${bestK.K})`);
  }

  console.log('\n== K-sweep table ==');
  console.log('| fixture | K | dssim | bytes | seconds |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.name} | ${r.K} | ${r.dssim.toFixed(4)} | ${r.kb.toFixed(1)}KB | ${r.secs.toFixed(1)} |`);

  // perf check at a big input: photo.png is 1280x800 -> 2560x1600 traced
  const pf = path.join(ROOT, 'fixtures', 'photo.png');
  const psrc = await loadImage(pf);
  const pimg = nearestUpscale(psrc, 2);
  const t0 = Date.now();
  const psvg = await layerTrace(pimg, { colors: 48 });
  const secs = (Date.now() - t0) / 1000;
  const pr = renderSvgToRgba(psvg, psrc.width, psrc.height);
  const pd = dssim(psrc.data, pr.data, psrc.width, psrc.height);
  console.log(`\nperf: photo.png ${psrc.width}x${psrc.height} traced at ${pimg.width}x${pimg.height}, K=48: `
    + `${secs.toFixed(1)}s, dssim=${pd.toFixed(4)}, raw=${(Buffer.byteLength(psvg) / 1024).toFixed(0)}KB`);
}

async function compose(imgs, w, h) {
  const pngs = await Promise.all(imgs.map((i) => toPng(i)));
  return sharp({ create: { width: w * imgs.length + 8 * (imgs.length - 1), height: h, channels: 4, background: { r: 34, g: 34, b: 34, alpha: 1 } } })
    .composite(pngs.map((p, i) => ({ input: p, left: i * (w + 8), top: 0 })))
    .png().toBuffer();
}

run().catch((e) => { console.error(e); process.exit(1); });
