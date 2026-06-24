// Demo + guard for src/core/postprocess.js. Picks a few SVGs (out/*.svg if present,
// otherwise converts fixtures/logo.png on the fly), runs postprocess(), and prints
// before/after byte sizes alongside the rendered DSSIM delta to prove fidelity is
// preserved. Fails loudly if any file's appearance drifts past the threshold.
//
//   node scripts/postprocess-demo.js [dssimThreshold] [precision]

import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dssim } from '../src/core/metrics.js';
import { postprocess } from '../src/core/postprocess.js';
import { convertImage } from '../src/core/pipeline.js';

const DSSIM_THRESHOLD = parseFloat(process.argv[2] || '0.002');
const PRECISION = parseInt(process.argv[3] || '2', 10);
const RENDER_W = 512; // fixed render width so both versions rasterize identically

/** Render an SVG string to a flat RGBA buffer at a fixed width via resvg. */
async function renderRGBA(svg, width = RENDER_W) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
  const { data, info } = await sharp(png)
    .flatten({ background: '#ffffff' }).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}

/** Compare two SVGs at identical raster size; returns DSSIM (0 = identical). */
async function renderedDelta(a, b) {
  const ra = await renderRGBA(a);
  let rb = await renderRGBA(b);
  if (rb.width !== ra.width || rb.height !== ra.height) {
    // round-tripping can drop width/height attrs; force-match the grid before SSIM
    const png = new Resvg(b, { fitTo: { mode: 'width', value: ra.width } }).render().asPng();
    const { data } = await sharp(png).resize(ra.width, ra.height, { fit: 'fill' })
      .flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    rb = { width: ra.width, height: ra.height, data: new Uint8ClampedArray(data) };
  }
  return dssim(ra.data, rb.data, ra.width, ra.height);
}

/** Gather sample SVGs. Prefer real outputs in out/; fall back to a fresh convert. */
async function gatherSamples() {
  const outDir = 'out';
  const samples = [];
  if (existsSync(outDir)) {
    const files = readdirSync(outDir)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => join(outDir, f))
      .map((p) => ({ name: p, bytes: Buffer.byteLength(readFileSync(p)) }))
      .sort((a, b) => b.bytes - a.bytes) // biggest first: most interesting savings
      .slice(0, 5);
    for (const f of files) samples.push({ name: f.name, svg: readFileSync(f.name, 'utf8') });
  }
  if (samples.length === 0) {
    process.stdout.write('no out/*.svg found; converting fixtures/logo.png...\n');
    const { svg } = await convertImage('fixtures/logo.png', { quality: 'balanced' });
    samples.push({ name: 'fixtures/logo.png (converted)', svg });
  }
  return samples;
}

const samples = await gatherSamples();

let worstDelta = 0;
let totalBefore = 0;
let totalAfter = 0;

const pad = (s, n) => String(s).padEnd(n);
process.stdout.write(
  `${pad('file', 40)}${pad('before', 10)}${pad('after', 10)}${pad('saved', 14)}${pad('dssim', 10)}status\n`,
);
process.stdout.write('-'.repeat(94) + '\n');

for (const { name, svg } of samples) {
  const { svg: out, before, after, saved, ratio } = postprocess(svg, { precision: PRECISION });
  const delta = await renderedDelta(svg, out);
  worstDelta = Math.max(worstDelta, delta);
  totalBefore += before;
  totalAfter += after;
  const ok = delta < DSSIM_THRESHOLD;
  const savedPct = (100 * (1 - ratio)).toFixed(1);
  const short = name.length > 38 ? '...' + name.slice(-35) : name;
  process.stdout.write(
    `${pad(short, 40)}${pad(before, 10)}${pad(after, 10)}` +
      `${pad(`${saved} (${savedPct}%)`, 14)}${pad(delta.toFixed(5), 10)}${ok ? 'ok' : 'DRIFT!'}\n`,
  );
}

process.stdout.write('-'.repeat(94) + '\n');
const totalPct = totalBefore ? (100 * (1 - totalAfter / totalBefore)).toFixed(1) : '0.0';
process.stdout.write(
  `${pad('TOTAL', 40)}${pad(totalBefore, 10)}${pad(totalAfter, 10)}` +
    `${pad(`${totalBefore - totalAfter} (${totalPct}%)`, 14)}${pad(worstDelta.toFixed(5), 10)}\n`,
);

if (worstDelta >= DSSIM_THRESHOLD) {
  process.stderr.write(`\nFIDELITY CHECK FAILED: worst DSSIM ${worstDelta.toFixed(5)} >= ${DSSIM_THRESHOLD}\n`);
  process.exit(1);
}
process.stdout.write(`\nfidelity preserved: worst DSSIM ${worstDelta.toFixed(5)} < ${DSSIM_THRESHOLD}\n`);
