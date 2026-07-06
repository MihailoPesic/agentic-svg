// Evaluate per-region text patching vs the current pipeline.
//
//   node scripts/test-textregions.js [--fast]
//
// For photo-signage / meme / ui: detect text regions on a ~768px load, draw
// the boxes (out/exp_textreg_<name>_boxes.png), then composite traced text
// patches over the current convertImage output and compare overall dssim and
// dssim inside the text boxes. Side-by-sides land in out/exp_textreg_<name>.png
// (original | current | current+patches). Also runs detection-only on the
// landscape photo as a false-positive canary.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { convertImage } from '../src/core/pipeline.js';
import { detectTextRegions, buildTextPatches } from '../src/core/textregions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAST = process.argv.includes('--fast');
const QUALITY = FAST ? 'balanced' : 'high';

const CASES = [
  { name: 'photo-signage', file: 'testdata/photo-signage.jpg' },
  { name: 'meme', file: 'testdata/meme.png' },
  { name: 'ui', file: 'fixtures/ui.png' },
];

function hstack(imgs) {
  const H = Math.max(...imgs.map((i) => i.height));
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

function drawBoxes(img, boxes, thick = 3) {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const put = (x, y) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const o = (y * out.width + x) * 4;
    out.data[o] = 255; out.data[o + 1] = 0; out.data[o + 2] = 40; out.data[o + 3] = 255;
  };
  for (const b of boxes) {
    for (let t = 0; t < thick; t++) {
      for (let x = b.x - t; x <= b.x + b.w - 1 + t; x++) { put(x, b.y - t); put(x, b.y + b.h - 1 + t); }
      for (let y = b.y - t; y <= b.y + b.h - 1 + t; y++) { put(b.x - t, y); put(b.x + b.w - 1 + t, y); }
    }
  }
  return out;
}

function cropRgba(img, x, y, w, h) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const src = ((y + yy) * img.width + x) * 4;
    out.set(img.data.subarray(src, src + w * 4), yy * w * 4);
  }
  return { width: w, height: h, data: out };
}

/** Area-weighted mean dssim over the given boxes (detection space). */
function boxDssim(a, b, boxes, W, H) {
  let sum = 0, area = 0;
  for (const r of boxes) {
    const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
    const w = Math.min(W - x, Math.round(r.w)), h = Math.min(H - y, Math.round(r.h));
    if (w < 8 || h < 8) continue;
    const d = dssim(cropRgba(a, x, y, w, h).data, cropRgba(b, x, y, w, h).data, w, h);
    sum += d * w * h;
    area += w * h;
  }
  return area ? sum / area : 0;
}

function viewBoxWidth(svg) {
  let m = svg.match(/viewBox="[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+[\d.eE+-]+"/);
  if (m) return parseFloat(m[1]);
  m = svg.match(/<svg[^>]*\bwidth="([\d.]+)/);
  if (m) return parseFloat(m[1]);
  throw new Error('cannot determine svg width');
}

async function run() {
  // False-positive canary: a text-free landscape should yield ~zero regions.
  {
    const img = await loadImage(path.join(root, 'testdata', 'photo-landscape.jpg'), { maxSize: 768 });
    const t0 = Date.now();
    const regions = detectTextRegions(img);
    console.log(`canary photo-landscape: ${regions.length} region(s) in ${Date.now() - t0}ms` +
      (regions.length ? ' ' + JSON.stringify(regions) : ''));
  }

  console.log(`\nquality=${QUALITY}`);
  console.log('image         | regions | overall dssim cur->patched | textbox dssim cur->patched | +bytes');
  console.log('--------------|---------|----------------------------|----------------------------|-------');

  for (const { name, file } of CASES) {
    const buf = readFileSync(path.join(root, file));
    const img = await loadImage(buf, { maxSize: 768 });
    const W = img.width, H = img.height;

    const t0 = Date.now();
    const regions = detectTextRegions(img);
    const detectMs = Date.now() - t0;

    const boxed = drawBoxes(img, regions);
    const boxesPath = path.join(root, 'out', `exp_textreg_${name}_boxes.png`);
    await sharp(await toPng(boxed)).toFile(boxesPath);
    console.log(`# ${name}: ${regions.length} region(s) in ${detectMs}ms -> ${boxesPath}`);
    for (const r of regions) console.log(`#   box x=${r.x} y=${r.y} w=${r.w} h=${r.h} glyphs=${r.glyphs}`);

    // Current pipeline output.
    const cur = await convertImage(buf, { quality: QUALITY });
    const targetW = viewBoxWidth(cur.svg);

    // Patches composited on top — each gated on actually improving the
    // render inside its own box (this is what converge would do too).
    const t1 = Date.now();
    const { patches } = await buildTextPatches(buf, regions, {
      regionSpaceWidth: W,
      targetW,
    });
    const curR = renderSvgToRgba(cur.svg, W, H);
    const toDet = W / targetW; // target space -> detection/render space
    let kept = '';
    const keptBoxes = [];
    for (const p of patches) {
      const cand = cur.svg.replace(/<\/svg>\s*$/, `<g id="textpatches">${p.svg}</g></svg>`);
      const candR = renderSvgToRgba(cand, W, H);
      const bx = { x: p.box.x * toDet, y: p.box.y * toDet, w: p.box.w * toDet, h: p.box.h * toDet };
      const before = boxDssim(img, curR, [bx], W, H);
      const after = boxDssim(img, candR, [bx], W, H);
      if (after < before * 0.97) { kept += p.svg; keptBoxes.push(p.box); }
      else console.log(`#   gate: drop patch at x=${Math.round(bx.x)} y=${Math.round(bx.y)} (${before.toFixed(4)} -> ${after.toFixed(4)})`);
    }
    const boxes = keptBoxes;
    const patchMs = Date.now() - t1;
    const patched = kept
      ? cur.svg.replace(/<\/svg>\s*$/, `<g id="textpatches">${kept}</g></svg>`)
      : cur.svg;

    const patR = renderSvgToRgba(patched, W, H);
    const dCur = dssim(img.data, curR.data, W, H);
    const dPat = dssim(img.data, patR.data, W, H);
    const dCurBox = boxDssim(img, curR, regions, W, H);
    const dPatBox = boxDssim(img, patR, regions, W, H);
    const addBytes = Buffer.byteLength(patched) - Buffer.byteLength(cur.svg);

    console.log(
      `${name.padEnd(13)} | ${String(regions.length).padEnd(7)} ` +
      `| ${dCur.toFixed(4)} -> ${dPat.toFixed(4)}           ` +
      `| ${dCurBox.toFixed(4)} -> ${dPatBox.toFixed(4)}           ` +
      `| +${(addBytes / 1024).toFixed(1)}KB (${boxes.length} patches, ${patchMs}ms)`);

    const strip = hstack([img, curR, patR]);
    const outPath = path.join(root, 'out', `exp_textreg_${name}.png`);
    await sharp(await toPng(strip)).toFile(outPath);
    console.log(`# wrote ${outPath} (original | current | current+patches)\n`);
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
