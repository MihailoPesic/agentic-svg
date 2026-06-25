// Property tests for the gradient fitter on synthetic gradients. For each
// generated linear/radial gradient we assert the fit is tight, the in-memory
// reconstruction tracks the source, and the emitted SVG re-renders close to it.
// Run with: node --test test/gradient.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import { Resvg } from '@resvg/resvg-js';
import { fitGradient, renderGradient, gradientSvg } from '../src/core/gradient.js';
import { dssim, rmse } from '../src/core/metrics.js';

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v) | 0;

function makeImage(W, H, colorAt) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = colorAt(x, y);
      const o = (y * W + x) * 4;
      data[o] = clamp(r); data[o + 1] = clamp(g); data[o + 2] = clamp(b); data[o + 3] = 255;
    }
  }
  return { data, width: W, height: H };
}

// lerp three RGB stops over t in [0,1]
function lerp3(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const seg = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(seg));
  const f = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function linearImage(W, H, angleDeg, stops) {
  const ang = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(ang), uy = Math.sin(ang);
  let lo = Infinity, hi = -Infinity;
  for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) {
    const p = cx * ux + cy * uy; if (p < lo) lo = p; if (p > hi) hi = p;
  }
  const span = hi - lo || 1;
  return makeImage(W, H, (x, y) => lerp3(stops, ((x * ux + y * uy) - lo) / span));
}

function radialImage(W, H, cx, cy, stops) {
  const maxD = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy)) || 1;
  return makeImage(W, H, (x, y) => lerp3(stops, Math.hypot(x - cx, y - cy) / maxD));
}

// Re-render the emitted gradient SVG to RGBA at WxH for comparison.
function renderGradientSvg(fit, W, H, stops) {
  const { defs, rect } = gradientSvg(fit, W, H, stops);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${rect}</svg>`;
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: W }, font: { loadSystemFonts: false } });
  const img = r.render();
  const px = img.pixels;
  return new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength);
}

const W = 80, H = 64;

const LINEAR_CASES = [
  { name: 'horizontal 2-stop', angle: 0, stops: [[20, 60, 200], [220, 60, 20]] },
  { name: 'vertical 2-stop', angle: 90, stops: [[10, 10, 10], [240, 240, 240]] },
  { name: 'diagonal 3-stop', angle: 45, stops: [[255, 209, 102], [239, 71, 111], [7, 59, 76]] },
];

for (const { name, angle, stops } of LINEAR_CASES) {
  test(`fitGradient: linear ${name}`, () => {
    const img = linearImage(W, H, angle, stops);
    const fit = fitGradient(img);
    assert.ok(fit, 'expected a fit');
    assert.ok(['linear', 'radial'].includes(fit.kind), `unexpected kind ${fit.kind}`);
    // A genuine linear gradient should fit very tightly.
    assert.ok(fit.rmse < 0.03, `rmse should be small, got ${fit.rmse.toFixed(4)}`);
    assert.equal(fit.kind, 'linear', 'a clean linear gradient should be fit as linear');

    // In-memory reconstruction tracks the source closely.
    const recon = renderGradient(fit, W, H);
    assert.equal(recon.length, img.data.length);
    for (let i = 3; i < recon.length; i += 4) assert.equal(recon[i], 255, 'reconstruction must be opaque');
    assert.ok(rmse(img.data, recon, W, H) < 0.03, 'reconstruction rmse small');
    assert.ok(dssim(img.data, recon, W, H) < 0.01, 'reconstruction dssim small');

    // Emitted SVG re-renders to something close to the source.
    const svgPixels = renderGradientSvg(fit, W, H, 12);
    assert.ok(dssim(img.data, svgPixels, W, H) < 0.02, 'svg-rendered dssim small');
  });
}

// The fitter seeds centers from a coarse 5x5 grid + luma centroids, so an
// off-center, multi-stop radial leaves more residual than a centered one. The
// meaningful properties (correct kind, perceptually faithful reconstruction)
// still hold; the rmse ceiling is per-case to reflect that discretization.
const RADIAL_CASES = [
  { name: 'centered', cx: W / 2, cy: H / 2, stops: [[255, 255, 255], [10, 10, 60]], maxRmse: 0.02, maxDssim: 0.02 },
  { name: 'off-center', cx: W * 0.35, cy: H * 0.4, stops: [[255, 209, 102], [239, 71, 111], [7, 59, 76]], maxRmse: 0.06, maxDssim: 0.03 },
];

for (const { name, cx, cy, stops, maxRmse, maxDssim } of RADIAL_CASES) {
  test(`fitGradient: radial ${name}`, () => {
    const img = radialImage(W, H, cx, cy, stops);
    const fit = fitGradient(img);
    assert.ok(fit, 'expected a fit');
    assert.equal(fit.kind, 'radial', 'a clean radial gradient should be fit as radial');
    assert.ok(fit.rmse < maxRmse, `radial rmse should be small, got ${fit.rmse.toFixed(4)}`);

    const recon = renderGradient(fit, W, H);
    assert.ok(dssim(img.data, recon, W, H) < maxDssim, 'radial reconstruction dssim small');

    const svgPixels = renderGradientSvg(fit, W, H, 14);
    assert.ok(dssim(img.data, svgPixels, W, H) < maxDssim + 0.01, 'radial svg-rendered dssim small');
  });
}

test('gradientSvg emits well-formed defs + rect with monotonic stop offsets', () => {
  const img = linearImage(W, H, 0, [[0, 0, 0], [255, 255, 255]]);
  const fit = fitGradient(img);
  const stops = 10;
  const { defs, rect } = gradientSvg(fit, W, H, stops);

  assert.match(defs, /<(linear|radial)Gradient id="g"/);
  assert.match(defs, /gradientUnits="userSpaceOnUse"/);
  assert.match(rect, new RegExp(`width="${W}"`));
  assert.match(rect, new RegExp(`height="${H}"`));
  assert.match(rect, /fill="url\(#g\)"/);

  // exactly `stops` stop elements, each a valid #rrggbb at a 0..100% offset
  const stopMatches = [...defs.matchAll(/<stop offset="([\d.]+)%" stop-color="(#[0-9a-f]{6})"\/>/g)];
  assert.equal(stopMatches.length, stops, `expected ${stops} stops`);
  const offsets = stopMatches.map((m) => parseFloat(m[1]));
  assert.equal(offsets[0], 0);
  assert.ok(Math.abs(offsets[offsets.length - 1] - 100) < 1e-6, 'last offset is 100%');
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1], 'offsets strictly increasing');
});

test('fitGradient handles a degenerate solid image without throwing', () => {
  const img = makeImage(W, H, () => [128, 64, 200]);
  const fit = fitGradient(img);
  assert.ok(fit, 'should still return a fit for a flat field');
  assert.ok(fit.rmse < 1e-3, `solid field rmse near zero, got ${fit.rmse}`);
  const recon = renderGradient(fit, W, H);
  // every reconstructed pixel should be ~the constant color
  for (let i = 0; i < recon.length; i += 4) {
    assert.ok(Math.abs(recon[i] - 128) <= 2 && Math.abs(recon[i + 1] - 64) <= 2 && Math.abs(recon[i + 2] - 200) <= 2);
  }
});

test('fitGradient picks the dominant axis for a near-horizontal gradient', () => {
  const img = linearImage(W, H, 8, [[30, 30, 30], [200, 200, 200]]);
  const fit = fitGradient(img);
  assert.equal(fit.kind, 'linear');
  // axis direction should be roughly horizontal (|ux| dominates |uy|)
  const { ux, uy } = fit.params;
  assert.ok(Math.abs(ux) > Math.abs(uy), `expected near-horizontal axis, ux=${ux} uy=${uy}`);
});
