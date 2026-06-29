// Evaluate Strategy C (smooth-blob radial overlay) on top of the poster trace.
//
//   node scripts/test_gradoverlay.js
//
// For each fixture: build base = poster trace; build composite = trace + the
// gradient overlay; render both at work res; measure dssim vs the work image;
// and write a side-by-side (original | trace | trace+overlay) row per fixture
// to out/exp_gradoverlay.png.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { traceImage, TRACE_PRESETS } from '../src/core/trace.js';
import { fitGradientOverlay } from '../src/core/gradoverlay.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = ['orb', 'sticker', 'soft-face', 'photo', 'scene'];
const WORK = 320;

// Strip the trace's outer <svg ...> wrapper (and any xml/comment preamble) so we
// can re-wrap with our overlay. Returns { inner, w, h } in the trace's native
// coordinate space.
function innerOf(svg) {
  const m = svg.match(/<svg[^>]*\bwidth="(\d+)"[^>]*\bheight="(\d+)"[^>]*>/);
  const tag = svg.match(/<svg[^>]*>/);
  const open = svg.indexOf(tag[0]) + tag[0].length;
  const close = svg.lastIndexOf('</svg>');
  return { inner: svg.slice(open, close), w: m ? +m[1] : 0, h: m ? +m[2] : 0 };
}

function hstack(imgs) {
  const H = Math.max(...imgs.map(i => i.height));
  const W = imgs.reduce((s, i) => s + i.width, 0);
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  let xoff = 0;
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
      const si = (y * im.width + x) * 4, di = (y * W + (x + xoff)) * 4;
      out[di] = im.data[si]; out[di + 1] = im.data[si + 1]; out[di + 2] = im.data[si + 2]; out[di + 3] = 255;
    }
    xoff += im.width;
  }
  return { width: W, height: H, data: out };
}

async function run() {
  const strips = [];
  console.log('fixture   | trace dssim | +overlay dssim | delta    | blobs | verdict');
  console.log('----------|-------------|----------------|----------|-------|--------');

  for (const name of FIXTURES) {
    const file = path.join(root, 'fixtures', `${name}.png`);
    const buf = readFileSync(file);
    const work = await loadImage(buf, { maxSize: WORK });
    const W = work.width, H = work.height;

    // Base: poster trace, in its native coordinate space (e.g. 512). We give the
    // outer svg that native viewBox and let resvg fit to work width for scoring.
    const traceSvg = await traceImage(buf, TRACE_PRESETS.poster);
    const { inner: baseInner, w: NW, h: NH } = innerOf(traceSvg);
    const baseSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${NW}" height="${NH}" viewBox="0 0 ${NW} ${NH}">${baseInner}</svg>`;
    const baseRender = renderSvgToRgba(baseSvg, W, H);
    const baseDssim = dssim(work.data, baseRender.data, W, H);

    // Overlay computed on the work (320) image; scale it up into native space so
    // it sits over the trace correctly.
    const t0 = Date.now();
    const ov = fitGradientOverlay(work, {});
    const ms = Date.now() - t0;
    const sc = NW / W;
    const scaledOverlay = ov.count ? `<g transform="scale(${sc.toFixed(5)})">${ov.body}</g>` : '';
    const compSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${NW}" height="${NH}" viewBox="0 0 ${NW} ${NH}">${baseInner}${ov.defs}${scaledOverlay}</svg>`;
    const compRender = renderSvgToRgba(compSvg, W, H);
    const compDssim = dssim(work.data, compRender.data, W, H);

    const delta = compDssim - baseDssim;
    const verdict = ov.count === 0 ? 'no-op' : (delta < -0.0005 ? 'BETTER' : (delta > 0.0005 ? 'WORSE' : 'flat'));
    console.log(
      `${name.padEnd(9)} | ${baseDssim.toFixed(4)}      | ${compDssim.toFixed(4)}         ` +
      `| ${(delta >= 0 ? '+' : '') + delta.toFixed(4)} | ${String(ov.count).padEnd(5)} | ${verdict} (${ms}ms)`);
    for (const r of ov.regions) {
      console.log(`           - ${r.kind} area=${r.area} fill=${r.fill.toFixed(2)} gradRmse=${r.gradRmse.toFixed(3)} flatRmse=${r.flatRmse.toFixed(3)}`);
    }

    strips.push(hstack([work, baseRender, compRender]));
  }

  const W = Math.max(...strips.map(s => s.width));
  const H = strips.reduce((s, i) => s + i.height, 0);
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  let yoff = 0;
  for (const s of strips) {
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
      const si = (y * s.width + x) * 4, di = ((y + yoff) * W + x) * 4;
      out[di] = s.data[si]; out[di + 1] = s.data[si + 1]; out[di + 2] = s.data[si + 2]; out[di + 3] = 255;
    }
    yoff += s.height;
  }
  const png = await toPng({ width: W, height: H, data: out });
  const outPath = path.join(root, 'out', 'exp_gradoverlay.png');
  await sharp(png).toFile(outPath);
  console.log('\nwrote', outPath, '(rows: orb/sticker/soft-face/photo/scene; cols: original | trace | trace+overlay)');
}

run().catch(e => { console.error(e); process.exit(1); });
