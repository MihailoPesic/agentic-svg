// Evaluate region-level gradient fitting vs the current pipeline.
//
//   node scripts/test-regiongradient.js
//
// For photo/orb/scene: render (a) original, (b) current convertImage output,
// (c) the region-gradient SVG; measure dssim + byte size for (b) and (c); and
// write a side-by-side strip to out/exp_region-gradient.png for visual review.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { convertImage } from '../src/core/pipeline.js';
import { fitRegionGradients } from '../src/core/regiongradient.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = ['photo', 'orb', 'scene'];
const WORK = 320; // match default workRes used by the pipeline

function fmtBytes(n) { return (n / 1024).toFixed(1) + 'KB'; }

// stack rgba images horizontally into one rgba buffer
function hstack(imgs) {
  const H = Math.max(...imgs.map(i => i.height));
  const W = imgs.reduce((s, i) => s + i.width, 0);
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  let xoff = 0;
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const si = (y * im.width + x) * 4, di = (y * W + (x + xoff)) * 4;
        out[di] = im.data[si]; out[di + 1] = im.data[si + 1]; out[di + 2] = im.data[si + 2]; out[di + 3] = 255;
      }
    }
    xoff += im.width;
  }
  return { width: W, height: H, data: out };
}

async function run() {
  const strips = [];
  console.log('fixture   | current dssim / bytes        | region-grad dssim / bytes   | regions(g/f) | verdict');
  console.log('----------|------------------------------|-----------------------------|--------------|--------');

  for (const name of FIXTURES) {
    const file = path.join(root, 'fixtures', `${name}.png`);
    const buf = readFileSync(file);

    // work-resolution target (what both approaches are scored against)
    const work = await loadImage(buf, { maxSize: WORK });
    const W = work.width, H = work.height;

    // (b) current pipeline
    const cur = await convertImage(buf, { quality: 'balanced' });
    const curRender = renderSvgToRgba(cur.svg, W, H);
    const curDssim = dssim(work.data, curRender.data, W, H);
    const curBytes = cur.metrics.finalBytes;

    // (c) region-gradient. levels=4 is the general tradeoff (clean on photo &
    // scene); the caller would gate adoption on the `fragmented` flag below.
    const t0 = Date.now();
    const rg = fitRegionGradients(work, { levels: 4, minAreaFrac: 0.004, gradGainFrac: 0.6, stops: 10 });
    const rgMs = Date.now() - t0;
    const rgRender = renderSvgToRgba(rg.svg, W, H);
    const rgDssim = dssim(work.data, rgRender.data, W, H);
    const rgBytes = Buffer.byteLength(rg.svg);

    // Decision the pipeline would make: only adopt region-grad if it isn't
    // fragmented (noise guard) AND it beats the current base on dssim.
    const adopt = !rg.coverage.fragmented && rgDssim < curDssim;
    const verdict = rg.coverage.fragmented ? 'REJECT(frag)' : (adopt ? 'ADOPT' : 'keep-current');
    console.log(
      `${name.padEnd(9)} | ${curDssim.toFixed(4)} / ${fmtBytes(curBytes).padEnd(8)}        ` +
      `| ${rgDssim.toFixed(4)} / ${fmtBytes(rgBytes).padEnd(8)}      ` +
      `| ${rg.coverage.gradients}/${rg.coverage.flats} of ${rg.coverage.regions} `.padEnd(13) +
      `| ${verdict} cov=${rg.coverage.topCoverage.toFixed(2)} (${rgMs}ms)`);

    strips.push(hstack([work, curRender, rgRender]));
  }

  // vertical stack of the three strips
  const W = Math.max(...strips.map(s => s.width));
  const H = strips.reduce((s, i) => s + i.height, 0);
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  let yoff = 0;
  for (const s of strips) {
    for (let y = 0; y < s.height; y++)
      for (let x = 0; x < s.width; x++) {
        const si = (y * s.width + x) * 4, di = ((y + yoff) * W + x) * 4;
        out[di] = s.data[si]; out[di + 1] = s.data[si + 1]; out[di + 2] = s.data[si + 2]; out[di + 3] = 255;
      }
    yoff += s.height;
  }
  const png = await toPng({ width: W, height: H, data: out });
  const outPath = path.join(root, 'out', 'exp_region-gradient.png');
  await sharp(png).toFile(outPath);
  console.log('\nwrote', outPath, '(rows: photo/orb/scene; cols: original | current | region-grad)');
}

run().catch(e => { console.error(e); process.exit(1); });
