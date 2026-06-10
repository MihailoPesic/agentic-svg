// Real SVG gradient fitting. Stacked shapes can only approximate a smooth
// gradient (visible banding); a single <linearGradient>/<radialGradient>
// reproduces it almost exactly at a few hundred bytes. We fit a NON-PARAMETRIC
// gradient: project pixels onto an axis (linear) or distance-from-center
// (radial), bin them, take each bin's mean color — that profile reproduces any
// monotonic gradient. We search a handful of axes/centers and keep the best.

const BINS = 48;

function profileError(data, W, H, coordFn) {
  // Accumulate mean color per bin, then measure reconstruction SSE.
  const sumR = new Float64Array(BINS), sumG = new Float64Array(BINS), sumB = new Float64Array(BINS), cnt = new Float64Array(BINS);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = coordFn(x, y);
      let b = (t * (BINS - 1)) | 0; if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      const o = (y * W + x) * 4;
      sumR[b] += data[o]; sumG[b] += data[o + 1]; sumB[b] += data[o + 2]; cnt[b]++;
    }
  }
  // Fill empty bins by carrying the nearest filled value.
  const pr = new Float64Array(BINS), pg = new Float64Array(BINS), pb = new Float64Array(BINS);
  let lastR = 0, lastG = 0, lastB = 0, seen = false;
  for (let b = 0; b < BINS; b++) {
    if (cnt[b] > 0) { pr[b] = sumR[b] / cnt[b]; pg[b] = sumG[b] / cnt[b]; pb[b] = sumB[b] / cnt[b]; lastR = pr[b]; lastG = pg[b]; lastB = pb[b]; seen = true; }
    else if (seen) { pr[b] = lastR; pg[b] = lastG; pb[b] = lastB; }
  }
  for (let b = BINS - 1; b >= 0; b--) { if (cnt[b] === 0 && !seen) { /* no data at all */ } if (cnt[b] === 0) { pr[b] = pr[b + 1] ?? lastR; pg[b] = pg[b + 1] ?? lastG; pb[b] = pb[b + 1] ?? lastB; } }

  let sse = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = coordFn(x, y);
      let b = (t * (BINS - 1)) | 0; if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
      const o = (y * W + x) * 4;
      const dr = data[o] - pr[b], dg = data[o + 1] - pg[b], db = data[o + 2] - pb[b];
      sse += dr * dr + dg * dg + db * db;
    }
  }
  return { sse, profile: { r: pr, g: pg, b: pb } };
}

/**
 * Fit the best linear/radial gradient to an image.
 * @returns {{kind, rmse, coordFn, profile, params}|null}
 */
export function fitGradient(img) {
  const { data, width: W, height: H } = img;
  const diag = Math.hypot(W, H);
  let best = null;

  // Linear: search angles; t = normalized projection on the unit axis.
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI; // 0..180°, direction sign handled by profile
    const ux = Math.cos(ang), uy = Math.sin(ang);
    // projection range
    let lo = Infinity, hi = -Infinity;
    for (const [cx, cy] of [[0, 0], [W, 0], [0, H], [W, H]]) { const p = cx * ux + cy * uy; if (p < lo) lo = p; if (p > hi) hi = p; }
    const span = hi - lo || 1;
    const coordFn = (x, y) => ((x * ux + y * uy) - lo) / span;
    const { sse, profile } = profileError(data, W, H, coordFn);
    if (!best || sse < best.sse) best = { sse, kind: 'linear', coordFn, profile, params: { ux, uy, lo, span } };
  }

  // Radial: a radial gradient's extreme color sits at its center, so seed
  // candidate centers from the brightest/darkest luma centroids, then refine
  // on a fine grid around the best.
  const centers = [];
  { // luma-extreme centroids
    let bx = 0, by = 0, bw = 0, dx = 0, dy = 0, dw = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4; const l = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      const wb = l * l, wd = (255 - l) * (255 - l);
      bx += x * wb; by += y * wb; bw += wb; dx += x * wd; dy += y * wd; dw += wd;
    }
    if (bw) centers.push([bx / bw, by / bw]); if (dw) centers.push([dx / dw, dy / dw]);
  }
  for (let gy = 0; gy <= 4; gy++) for (let gx = 0; gx <= 4; gx++) centers.push([(gx / 4) * W, (gy / 4) * H]);
  for (const [cx, cy] of centers) {
    const maxD = Math.max(Math.hypot(cx, cy), Math.hypot(W - cx, cy), Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy)) || 1;
    const coordFn = (x, y) => Math.hypot(x - cx, y - cy) / maxD;
    const { sse, profile } = profileError(data, W, H, coordFn);
    if (!best || sse < best.sse) best = { sse, kind: 'radial', coordFn, profile, params: { cx, cy, maxD } };
  }

  if (!best) return null;
  best.rmse = Math.sqrt(best.sse / (W * H * 3)) / 255;
  return best;
}

/** Render a fitted gradient to an RGBA buffer (exact reconstruction for seeding). */
export function renderGradient(fit, W, H) {
  const out = new Uint8ClampedArray(W * H * 4);
  const { r, g, b } = fit.profile;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = fit.coordFn(x, y);
      const f = Math.min(BINS - 1, Math.max(0, t * (BINS - 1)));
      const i0 = f | 0, i1 = Math.min(BINS - 1, i0 + 1), fr = f - i0;
      const o = (y * W + x) * 4;
      out[o] = r[i0] * (1 - fr) + r[i1] * fr;
      out[o + 1] = g[i0] * (1 - fr) + g[i1] * fr;
      out[o + 2] = b[i0] * (1 - fr) + b[i1] * fr;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** Emit the fitted gradient as SVG <defs> + a covering <rect>, with `stops` stops. */
export function gradientSvg(fit, W, H, stops = 10) {
  const { r, g, b } = fit.profile;
  const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const stopEls = [];
  for (let s = 0; s < stops; s++) {
    const t = s / (stops - 1);
    const f = t * (BINS - 1), i0 = f | 0, i1 = Math.min(BINS - 1, i0 + 1), fr = f - i0;
    const cr = r[i0] * (1 - fr) + r[i1] * fr, cg = g[i0] * (1 - fr) + g[i1] * fr, cb = b[i0] * (1 - fr) + b[i1] * fr;
    stopEls.push(`<stop offset="${(t * 100).toFixed(1)}%" stop-color="#${hex(cr)}${hex(cg)}${hex(cb)}"/>`);
  }
  let def;
  if (fit.kind === 'linear') {
    const { ux, uy, lo, span } = fit.params;
    // endpoints of the axis in image space, mapped to t=0 and t=1
    const x1 = ux * lo, y1 = uy * lo, x2 = ux * (lo + span), y2 = uy * (lo + span);
    def = `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}">${stopEls.join('')}</linearGradient>`;
  } else {
    const { cx, cy, maxD } = fit.params;
    def = `<radialGradient id="g" gradientUnits="userSpaceOnUse" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${maxD.toFixed(1)}">${stopEls.join('')}</radialGradient>`;
  }
  return { defs: `<defs>${def}</defs>`, rect: `<rect width="${W}" height="${H}" fill="url(#g)"/>` };
}
