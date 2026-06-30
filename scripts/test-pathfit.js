// Experiment: post-trace geometric fitting (pathfit).
// For each fixture: trace flat -> fitPrimitives -> render both at native size,
// measure dssim vs original, count snapped primitives, byte sizes, and save
// out/exp_pathfit_<name>.png as [ original | raw trace | fitted ].
//
//   node scripts/test-pathfit.js

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { loadImage, toPng } from '../src/core/image.js';
import { traceImage, TRACE_PRESETS } from '../src/core/trace.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim, rmse } from '../src/core/metrics.js';
import { fitPrimitives } from '../src/core/pathfit.js';

const FIXTURES = ['logo', 'icon-set', 'comic-char', 'scene', 'bar-chart'];
const OUT = 'out';
fs.mkdirSync(OUT, { recursive: true });

function count(svg, re) { return (svg.match(re) || []).length; }

async function sideBySide(images, file) {
  const H = Math.max(...images.map((i) => i.height));
  const W = images.reduce((s, i) => s + i.width, 0) + (images.length - 1) * 4;
  const parts = [];
  let x = 0;
  for (const img of images) {
    parts.push({ input: await toPng(img), left: x, top: 0 });
    x += img.width + 4;
  }
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 24, g: 24, b: 24 } } })
    .composite(parts).png().toFile(file);
}

const rows = [];
for (const name of FIXTURES) {
  const file = path.join('fixtures', `${name}.png`);
  const buf = fs.readFileSync(file);
  const orig = await loadImage(file);
  const { width: W, height: H } = orig;

  const traced = await traceImage(buf, TRACE_PRESETS.flat);
  const fitted = fitPrimitives(traced);

  const rTrace = renderSvgToRgba(traced, W, H);
  const rFit = renderSvgToRgba(fitted, W, H);

  const dTrace = dssim(orig.data, rTrace.data, W, H);
  const dFit = dssim(orig.data, rFit.data, W, H);
  const row = {
    name, W, H,
    dTrace, dFit, dDelta: dFit - dTrace,
    rmseTrace: rmse(orig.data, rTrace.data, W, H),
    rmseFit: rmse(orig.data, rFit.data, W, H),
    circles: count(fitted, /<circle/g),
    ellipses: count(fitted, /<ellipse/g),
    bytesBefore: traced.length,
    bytesAfter: fitted.length,
    ok: dFit - dTrace <= 0.001,
  };
  rows.push(row);
  await sideBySide([orig, rTrace, rFit], path.join(OUT, `exp_pathfit_${name}.png`));
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('fixture', 11) + pad('dssim trace', 13) + pad('dssim fitted', 14) + pad('delta', 11)
  + pad('circ', 6) + pad('ellip', 7) + pad('bytes', 15) + 'ok');
for (const r of rows) {
  console.log(
    pad(r.name, 11)
    + pad(r.dTrace.toFixed(5), 13)
    + pad(r.dFit.toFixed(5), 14)
    + pad((r.dDelta >= 0 ? '+' : '') + r.dDelta.toFixed(5), 11)
    + pad(r.circles, 6)
    + pad(r.ellipses, 7)
    + pad(`${r.bytesBefore}->${r.bytesAfter}`, 15)
    + (r.ok ? 'PASS' : 'FAIL'),
  );
}
const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  console.error(`\n${bad.length} fixture(s) degraded beyond 0.001 dssim`);
  process.exit(1);
}
console.log('\nall fixtures within tolerance; side-by-sides in out/exp_pathfit_*.png');
