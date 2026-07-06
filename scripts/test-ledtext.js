// Evaluate the RELAXED (LED/billboard) second pass in detectTextRegions.
//
//   node scripts/test-ledtext.js [--detect-only]
//
// 1. photo-signage @768: strict-only vs strict+relaxed boxes, two panels in
//    out/exp_led_boxes.png (strict = red, relaxed = blue).
// 2. Canary: box count on photo-landscape (should stay small).
// 3. Full pipeline (quality high) on photo-signage: replicate the pipeline's
//    per-patch render gate on the SAME base SVG with strict-only regions
//    ("before") vs strict+relaxed ("after"); report gate keep counts, overall
//    dssim, bytes. Side-by-side out/exp_led_result.png (original|before|after).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { convertImage, finalizeSvg } from '../src/core/pipeline.js';
import { detectTextRegions, buildTextPatches } from '../src/core/textregions.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DETECT_ONLY = process.argv.includes('--detect-only');

function hstack(imgs, gap = 4) {
  const H = Math.max(...imgs.map((i) => i.height));
  const W = imgs.reduce((s, i) => s + i.width, 0) + gap * (imgs.length - 1);
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  let xoff = 0;
  for (const im of imgs) {
    for (let y = 0; y < im.height; y++) {
      for (let x = 0; x < im.width; x++) {
        const si = (y * im.width + x) * 4, di = (y * W + (x + xoff)) * 4;
        out[di] = im.data[si]; out[di + 1] = im.data[si + 1]; out[di + 2] = im.data[si + 2]; out[di + 3] = 255;
      }
    }
    xoff += im.width + gap;
  }
  return { width: W, height: H, data: out };
}

function drawBoxes(img, boxes, thick = 3) {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const put = (x, y, rgb) => {
    if (x < 0 || y < 0 || x >= out.width || y >= out.height) return;
    const o = (y * out.width + x) * 4;
    out.data[o] = rgb[0]; out.data[o + 1] = rgb[1]; out.data[o + 2] = rgb[2]; out.data[o + 3] = 255;
  };
  for (const b of boxes) {
    const rgb = b.relaxed ? [0, 90, 255] : [255, 0, 40];
    for (let t = 0; t < thick; t++) {
      for (let x = b.x - t; x <= b.x + b.w - 1 + t; x++) { put(x, b.y - t, rgb); put(x, b.y + b.h - 1 + t, rgb); }
      for (let y = b.y - t; y <= b.y + b.h - 1 + t; y++) { put(b.x - t, y, rgb); put(b.x + b.w - 1 + t, y, rgb); }
    }
  }
  return out;
}

/** Pipeline-identical per-patch render gate (512px, 0.97 improvement bar). */
async function gatePatches(input, baseSvg, regions, detW, vbW) {
  const { patches } = await buildTextPatches(input, regions, { regionSpaceWidth: detW, targetW: vbW });
  const src = await loadImage(input, { maxSize: 512 });
  const scale = src.width / vbW;
  const baseR = renderSvgToRgba(baseSvg, src.width, src.height);
  const boxDssim = (data, b) => {
    const x0 = Math.max(0, Math.floor(b.x * scale)), y0 = Math.max(0, Math.floor(b.y * scale));
    const x1 = Math.min(src.width, Math.ceil((b.x + b.w) * scale)), y1 = Math.min(src.height, Math.ceil((b.y + b.h) * scale));
    const w = x1 - x0, h = y1 - y0;
    if (w < 12 || h < 12) return null;
    const crop = (d) => {
      const o = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = ((y + y0) * src.width + (x + x0)) * 4, di = (y * w + x) * 4;
          o[di] = d[si]; o[di + 1] = d[si + 1]; o[di + 2] = d[si + 2]; o[di + 3] = 255;
        }
      }
      return o;
    };
    return dssim(crop(src.data), crop(data), w, h);
  };
  const kept = [];
  let candidates = 0;
  for (const p of patches) {
    const before = boxDssim(baseR.data, p.box);
    if (before == null) continue;
    candidates++;
    const candR = renderSvgToRgba(baseSvg.replace('</svg>', p.svg + '</svg>'), src.width, src.height);
    const after = boxDssim(candR.data, p.box);
    if (after != null && after < before * 0.97) kept.push(p.svg);
  }
  const svg = kept.length
    ? baseSvg.replace('</svg>', `<g id="textpatches">${kept.join('')}</g></svg>`)
    : baseSvg;
  return { svg, kept: kept.length, candidates };
}

async function run() {
  const sigBuf = readFileSync(path.join(root, 'testdata', 'photo-signage.jpg'));
  const img = await loadImage(sigBuf, { maxSize: 768 });
  const W = img.width, H = img.height;

  const strict = detectTextRegions(img, { relaxed: false });
  const both = detectTextRegions(img);
  console.log(`photo-signage strict: ${strict.length} box(es)`);
  for (const r of strict) console.log(`  strict  x=${r.x} y=${r.y} w=${r.w} h=${r.h} glyphs=${r.glyphs}`);
  console.log(`photo-signage strict+relaxed: ${both.length} box(es)`);
  for (const r of both) console.log(`  ${r.relaxed ? 'relaxed' : 'strict '} x=${r.x} y=${r.y} w=${r.w} h=${r.h} glyphs=${r.glyphs}`);

  const panels = hstack([drawBoxes(img, strict), drawBoxes(img, both)]);
  const boxesPath = path.join(root, 'out', 'exp_led_boxes.png');
  await sharp(await toPng(panels)).toFile(boxesPath);
  console.log(`wrote ${boxesPath} (left: strict only | right: strict red + relaxed blue)`);

  // Canary: text-free landscape.
  {
    const land = await loadImage(path.join(root, 'testdata', 'photo-landscape.jpg'), { maxSize: 768 });
    const ls = detectTextRegions(land, { relaxed: false });
    const lb = detectTextRegions(land);
    console.log(`\ncanary photo-landscape: strict=${ls.length} strict+relaxed=${lb.length}`);
    for (const r of lb) console.log(`  ${r.relaxed ? 'relaxed' : 'strict '} x=${r.x} y=${r.y} w=${r.w} h=${r.h} glyphs=${r.glyphs}`);
  }

  if (DETECT_ONLY) return;

  // Full pipeline. convertImage (quality high) now uses relaxed detection by
  // default; strip its textpatches group to recover the base, then gate the
  // strict-only and strict+relaxed region sets against that SAME base.
  console.log('\nrunning convertImage quality=high on photo-signage...');
  const t0 = Date.now();
  const res = await convertImage(sigBuf, { quality: 'high', optimize: false });
  console.log(`convertImage done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const pipeKept = (res.svg.match(/<g clip-path=/g) || []).length;
  console.log(`pipeline output textpatch groups (<g clip-path): ${pipeKept}`);

  const base = res.svg.replace(/<g id="textpatches">[\s\S]*<\/g><\/svg>\s*$/, '</svg>');
  const vb = base.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
  const vbW = +vb[1];

  const before = await gatePatches(sigBuf, base, strict, W, vbW);
  const after = await gatePatches(sigBuf, base, both, W, vbW);
  console.log(`gate BEFORE (strict only):    kept ${before.kept}/${before.candidates} candidate patch(es)`);
  console.log(`gate AFTER  (strict+relaxed): kept ${after.kept}/${after.candidates} candidate patch(es)`);

  const bR = renderSvgToRgba(before.svg, W, H);
  const aR = renderSvgToRgba(after.svg, W, H);
  const dB = dssim(img.data, bR.data, W, H);
  const dA = dssim(img.data, aR.data, W, H);
  const bytesB = Buffer.byteLength(finalizeSvg(before.svg));
  const bytesA = Buffer.byteLength(finalizeSvg(after.svg));
  console.log(`overall dssim: before=${dB.toFixed(4)} after=${dA.toFixed(4)}`);
  console.log(`bytes (svgo):  before=${(bytesB / 1024).toFixed(1)}KB after=${(bytesA / 1024).toFixed(1)}KB (+${((bytesA - bytesB) / 1024).toFixed(1)}KB)`);

  const strip = hstack([img, bR, aR]);
  const outPath = path.join(root, 'out', 'exp_led_result.png');
  await sharp(await toPng(strip)).toFile(outPath);
  console.log(`wrote ${outPath} (original | before=strict | after=strict+relaxed)`);
}

run().catch((e) => { console.error(e); process.exit(1); });
