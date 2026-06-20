// Core engine correctness tests. Run with: npm test  (node --test)
import test from 'node:test';
import assert from 'node:assert/strict';

import { solidImage } from '../src/core/image.js';
import {
  polygonScanlines, ellipseScanlines, scanlineArea, computeColor,
  differenceFull, differencePartial, drawLines,
} from '../src/core/raster.js';
import { Triangle, Ellipse, randomShapeIn } from '../src/core/shapes.js';
import { rmse, dssim, errorMap, topErrorCells } from '../src/core/metrics.js';
import { computeSaliency } from '../src/core/saliency.js';
import { fitGradient, renderGradient, gradientSvg } from '../src/core/gradient.js';
import { Model } from '../src/core/optimizer.js';

test('polygonScanlines fills a square exactly', () => {
  const pts = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
  const lines = polygonScanlines(pts, 16, 16);
  const area = scanlineArea(lines);
  // 6x6 box of pixel centers (x in [2..7], y in [2..7]) => 36 ± edge rounding
  assert.ok(area >= 30 && area <= 42, `square area ~36, got ${area}`);
  for (const l of lines) { assert.ok(l.x1 >= 0 && l.x2 < 16 && l.y >= 0 && l.y < 16); }
});

test('ellipseScanlines area approximates pi*rx*ry', () => {
  const lines = ellipseScanlines(50, 50, 30, 20, 100, 100);
  const area = scanlineArea(lines);
  const expected = Math.PI * 30 * 20;
  assert.ok(Math.abs(area - expected) / expected < 0.08, `ellipse area ~${expected|0}, got ${area}`);
});

test('scanlines clip to image bounds', () => {
  const lines = polygonScanlines([{ x: -50, y: -50 }, { x: 200, y: -50 }, { x: 200, y: 200 }, { x: -50, y: 200 }], 32, 32);
  for (const l of lines) assert.ok(l.x1 >= 0 && l.x2 <= 31 && l.y >= 0 && l.y <= 31);
});

test('computeColor recovers the exact color at alpha=1 over a flat canvas', () => {
  const W = 20, H = 20;
  const target = solidImage(W, H, { r: 17, g: 200, b: 99 }).data;
  const current = solidImage(W, H, { r: 0, g: 0, b: 0 }).data;
  const lines = ellipseScanlines(10, 10, 6, 6, W, H);
  const [r, g, b] = computeColor(target, current, lines, 1, W);
  assert.deepEqual([r, g, b], [17, 200, 99]);
});

test('differencePartial equals a full recompute after drawing the shape', () => {
  const W = 40, H = 40;
  const target = solidImage(W, H, { r: 220, g: 30, b: 40 }).data;
  // Float canvas (as the Model uses) makes incremental scoring exact.
  const current = Float32Array.from(solidImage(W, H, { r: 30, g: 30, b: 30 }).data);
  const score0 = differenceFull(target, current, W, H);
  const tri = new Triangle([{ x: 5, y: 5 }, { x: 35, y: 8 }, { x: 12, y: 33 }]);
  const lines = tri.rasterize(W, H);
  const alpha = 0.7;
  const color = computeColor(target, current, lines, alpha, W);
  const predicted = differencePartial(target, current, lines, color, alpha, score0, W, H);
  drawLines(current, lines, color, alpha, W);
  const actual = differenceFull(target, current, W, H);
  assert.ok(Math.abs(predicted - actual) < 1e-9, `partial ${predicted} vs full ${actual}`);
});

test('adding an optimal shape never increases error', () => {
  const W = 48, H = 48;
  const target = solidImage(W, H, { r: 10, g: 120, b: 240 }).data;
  // paint a contrasting block into the target
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) { const o = (y * W + x) * 4; target[o] = 240; target[o + 1] = 80; target[o + 2] = 10; }
  const model = new Model({ width: W, height: H, data: target });
  const before = model.score;
  for (let i = 0; i < 8; i++) {
    const s = model.step('rect', 1, { candidates: 2, randomTries: 12, maxAge: 30 });
    assert.ok(s <= before + 1e-9, 'score should be monotonically non-increasing');
  }
  assert.ok(model.score < before, 'error should drop after refinement');
});

test('rmse is 0 for identical images and positive otherwise', () => {
  const W = 8, H = 8;
  const a = solidImage(W, H, { r: 100, g: 100, b: 100 }).data;
  const b = solidImage(W, H, { r: 100, g: 100, b: 100 }).data;
  assert.equal(rmse(a, b, W, H), 0);
  const c = solidImage(W, H, { r: 110, g: 100, b: 100 }).data;
  assert.ok(rmse(a, c, W, H) > 0);
});

test('dssim is ~0 for identical images', () => {
  const W = 32, H = 32;
  const a = solidImage(W, H, { r: 50, g: 80, b: 200 }).data;
  const b = solidImage(W, H, { r: 50, g: 80, b: 200 }).data;
  assert.ok(dssim(a, b, W, H) < 1e-6);
});

test('errorMap localizes a high-error patch', () => {
  const W = 64, H = 64;
  const target = solidImage(W, H, { r: 0, g: 0, b: 0 }).data;
  const current = solidImage(W, H, { r: 0, g: 0, b: 0 }).data;
  // bright patch in target's bottom-right only
  for (let y = 40; y < 56; y++) for (let x = 40; x < 56; x++) { const o = (y * W + x) * 4; target[o] = target[o + 1] = target[o + 2] = 255; }
  const map = errorMap(target, current, W, H, 16);
  const top = topErrorCells(map, 1)[0];
  assert.ok(top.x >= 32 && top.y >= 32, `top error cell should be bottom-right, got (${top.x},${top.y})`);
});

test('saliency map favors a distinct central blob over a flat field', () => {
  const W = 64, H = 64;
  const img = solidImage(W, H, { r: 40, g: 40, b: 40 }).data;
  for (let y = 24; y < 40; y++) for (let x = 24; x < 40; x++) { const o = (y * W + x) * 4; img[o] = 255; img[o + 1] = 200; img[o + 2] = 0; }
  const sal = computeSaliency({ data: img, width: W, height: H });
  const center = sal[32 * W + 32];
  const corner = sal[2 * W + 2];
  assert.ok(center > corner, `center saliency ${center} should exceed corner ${corner}`);
  for (const v of sal) assert.ok(v >= 0 && v <= 1);
});

test('randomShapeIn places shapes near the requested region', () => {
  const region = { x: 100, y: 100, w: 20, h: 20 };
  for (let i = 0; i < 20; i++) {
    const e = randomShapeIn('ellipse', 400, 400, region);
    assert.ok(e instanceof Ellipse);
    assert.ok(e.cx >= 100 && e.cx <= 120 && e.cy >= 100 && e.cy <= 120);
  }
});

test('fitGradient recovers a synthetic linear gradient with low error', () => {
  const W = 64, H = 64;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = x / (W - 1), o = (y * W + x) * 4;
    data[o] = 20 + t * 200; data[o + 1] = 60; data[o + 2] = 200 - t * 180; data[o + 3] = 255;
  }
  const fit = fitGradient({ data, width: W, height: H });
  assert.ok(fit, 'should return a fit');
  assert.ok(fit.rmse < 0.02, `linear gradient should fit tightly, rmse=${fit.rmse}`);
  // reconstruction matches the source closely
  const recon = renderGradient(fit, W, H);
  let err = 0; for (let i = 0; i < data.length; i += 4) err += Math.abs(data[i] - recon[i]);
  assert.ok(err / (W * H) < 8, 'reconstruction red channel close');
});

test('gradientSvg emits a gradient def and a covering rect', () => {
  const W = 32, H = 32;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < data.length; i += 4) { const t = (i / 4 % W) / W; data[i] = 255 * t; data[i + 3] = 255; }
  const fit = fitGradient({ data, width: W, height: H });
  const { defs, rect } = gradientSvg(fit, W, H, 8);
  assert.match(defs, /<(linear|radial)Gradient id="g"/);
  assert.match(defs, /<stop offset=/);
  assert.match(rect, /fill="url\(#g\)"/);
});

test('Model.toSVG emits valid-looking SVG with viewBox', () => {
  const W = 24, H = 24;
  const model = new Model(solidImage(W, H, { r: 10, g: 10, b: 10 }));
  model.step('triangle', 1, { candidates: 1, randomTries: 5, maxAge: 5 });
  const svg = model.toSVG({ width: 48, height: 48 });
  assert.match(svg, /<svg[^>]*viewBox="0 0 24 24"/);
  assert.match(svg, /width="48"/);
  assert.match(svg, /<\/svg>/);
});
