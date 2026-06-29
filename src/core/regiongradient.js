// Region-level gradient fitting. The whole-image fitGradient (gradient.js) only
// fits ONE gradient to the ENTIRE frame — great for an orb on a plain field,
// useless for a photo where the sky, the sun and the ground are three different
// gradients. Stacked flat shapes approximate those gradients as concentric
// rings / banded strips (the posterization the pipeline suffers from).
//
// Here we SEGMENT the work image into regions, then fit a native
// <linearGradient>/<radialGradient> to each sizeable region whose pixels are
// well-approximated by one. Each region becomes a single <path> with a
// gradient fill — no bands, a few hundred bytes, and resvg renders it smooth.
//
// Segmentation: coarse color quantization -> connected components (flood fill)
// -> merge tiny components into their dominant neighbor. Region boundary is
// traced as an axis-aligned polygon (marching the mask edge), which renders
// pixel-exact against the original region.

const BINS = 32;

// ---- gradient profile fit, restricted to a pixel mask -----------------------

// Build a bin profile (mean color per bin) for the masked pixels under coordFn,
// then return reconstruction SSE. Mirrors gradient.js but mask-aware.
function maskedProfile(data, W, idx, coordFn) {
  const sumR = new Float64Array(BINS), sumG = new Float64Array(BINS), sumB = new Float64Array(BINS), cnt = new Float64Array(BINS);
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k];
    const x = p % W, y = (p / W) | 0;
    const t = coordFn(x, y);
    let b = (t * (BINS - 1)) | 0; if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    const o = p * 4;
    sumR[b] += data[o]; sumG[b] += data[o + 1]; sumB[b] += data[o + 2]; cnt[b]++;
  }
  const pr = new Float64Array(BINS), pg = new Float64Array(BINS), pb = new Float64Array(BINS);
  // forward-fill empty bins
  let lr = 0, lg = 0, lb = 0, seen = false;
  for (let b = 0; b < BINS; b++) {
    if (cnt[b] > 0) { pr[b] = sumR[b] / cnt[b]; pg[b] = sumG[b] / cnt[b]; pb[b] = sumB[b] / cnt[b]; lr = pr[b]; lg = pg[b]; lb = pb[b]; seen = true; }
    else if (seen) { pr[b] = lr; pg[b] = lg; pb[b] = lb; }
  }
  // back-fill leading empties
  for (let b = BINS - 1; b >= 0; b--) { if (cnt[b] === 0) { pr[b] = pr[b + 1] ?? lr; pg[b] = pg[b + 1] ?? lg; pb[b] = pb[b + 1] ?? lb; } }

  let sse = 0;
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k];
    const x = p % W, y = (p / W) | 0;
    const t = coordFn(x, y);
    let b = (t * (BINS - 1)) | 0; if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    const o = p * 4;
    const dr = data[o] - pr[b], dg = data[o + 1] - pg[b], db = data[o + 2] - pb[b];
    sse += dr * dr + dg * dg + db * db;
  }
  return { sse, profile: { r: pr, g: pg, b: pb } };
}

// Fit the best linear/radial gradient to a masked region. `bbox` is the
// region's pixel bounds so we search angles/centers locally.
function fitRegionGradient(data, W, idx, bbox) {
  const { x0, y0, x1, y1 } = bbox;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  let best = null;

  // Linear: search a handful of angles. Project onto the unit axis, normalize
  // over the region's projection span.
  for (let a = 0; a < 8; a++) {
    const ang = (a / 8) * Math.PI;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let lo = Infinity, hi = -Infinity;
    for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { const p = cx * ux + cy * uy; if (p < lo) lo = p; if (p > hi) hi = p; }
    const span = hi - lo || 1;
    const coordFn = (x, y) => ((x * ux + y * uy) - lo) / span;
    const { sse, profile } = maskedProfile(data, W, idx, coordFn);
    if (!best || sse < best.sse) best = { sse, kind: 'linear', coordFn, profile, params: { ux, uy, lo, span } };
  }

  // Radial: seed centers from luma extremes + a coarse grid over the bbox.
  const centers = [];
  {
    let bx = 0, by = 0, bwsum = 0, dx = 0, dy = 0, dwsum = 0;
    for (let k = 0; k < idx.length; k++) {
      const p = idx[k]; const x = p % W, y = (p / W) | 0; const o = p * 4;
      const l = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
      const wb = l * l, wd = (255 - l) * (255 - l);
      bx += x * wb; by += y * wb; bwsum += wb; dx += x * wd; dy += y * wd; dwsum += wd;
    }
    if (bwsum) centers.push([bx / bwsum, by / bwsum]);
    if (dwsum) centers.push([dx / dwsum, dy / dwsum]);
  }
  for (let gy = 0; gy <= 2; gy++) for (let gx = 0; gx <= 2; gx++) centers.push([x0 + (gx / 2) * bw, y0 + (gy / 2) * bh]);
  for (const [cx, cy] of centers) {
    const maxD = Math.max(
      Math.hypot(x0 - cx, y0 - cy), Math.hypot(x1 - cx, y0 - cy),
      Math.hypot(x0 - cx, y1 - cy), Math.hypot(x1 - cx, y1 - cy)) || 1;
    const coordFn = (x, y) => Math.hypot(x - cx, y - cy) / maxD;
    const { sse, profile } = maskedProfile(data, W, idx, coordFn);
    if (!best || sse < best.sse) best = { sse, kind: 'radial', coordFn, profile, params: { cx, cy, maxD } };
  }

  best.rmse = Math.sqrt(best.sse / (idx.length * 3)) / 255;
  // flat fallback: region mean. If the gradient barely beats a flat fill we'd
  // rather emit a solid color (cheaper, no spurious banding).
  let mr = 0, mg = 0, mb = 0;
  for (let k = 0; k < idx.length; k++) { const o = idx[k] * 4; mr += data[o]; mg += data[o + 1]; mb += data[o + 2]; }
  mr /= idx.length; mg /= idx.length; mb /= idx.length;
  let flatSse = 0;
  for (let k = 0; k < idx.length; k++) { const o = idx[k] * 4; const dr = data[o] - mr, dg = data[o + 1] - mg, db = data[o + 2] - mb; flatSse += dr * dr + dg * dg + db * db; }
  best.flat = { r: mr, g: mg, b: mb, rmse: Math.sqrt(flatSse / (idx.length * 3)) / 255 };
  return best;
}

// ---- segmentation -----------------------------------------------------------

// Quantize each pixel to a coarse RGB lattice -> integer key. `levels` per
// channel; step = 256/levels. Coarse on purpose: we want contiguous regions
// that each hold one smooth gradient, not per-pixel labels.
function quantizeKey(r, g, b, step) {
  const qr = Math.min(255, (((r / step) | 0) * step + step / 2)) | 0;
  const qg = Math.min(255, (((g / step) | 0) * step + step / 2)) | 0;
  const qb = Math.min(255, (((b / step) | 0) * step + step / 2)) | 0;
  return (qr << 16) | (qg << 8) | qb;
}

// Connected components over a per-pixel label array (4-connectivity).
// Returns { comp:Int32Array (component id per pixel), regions:[{id,idx,bbox}] }.
function connectedComponents(labels, W, H) {
  const comp = new Int32Array(W * H).fill(-1);
  const regions = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (comp[start] !== -1) continue;
    const lab = labels[start];
    const id = regions.length;
    let sp = 0; stack[sp++] = start; comp[start] = id;
    const idx = [];
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (sp > 0) {
      const p = stack[--sp];
      idx.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0) { const q = p - 1; if (comp[q] === -1 && labels[q] === lab) { comp[q] = id; stack[sp++] = q; } }
      if (x < W - 1) { const q = p + 1; if (comp[q] === -1 && labels[q] === lab) { comp[q] = id; stack[sp++] = q; } }
      if (y > 0) { const q = p - W; if (comp[q] === -1 && labels[q] === lab) { comp[q] = id; stack[sp++] = q; } }
      if (y < H - 1) { const q = p + W; if (comp[q] === -1 && labels[q] === lab) { comp[q] = id; stack[sp++] = q; } }
    }
    regions.push({ id, idx: Int32Array.from(idx), bbox: { x0, y0, x1, y1 } });
  }
  return { comp, regions };
}

// Reassign every pixel of a small component to the component id that borders it
// most (dominant neighbor). Iterated until all survivors are >= minArea.
function mergeSmall(comp, regions, W, H, minArea) {
  // Build adjacency-by-border-length on demand for small comps.
  const sizeOf = (id) => regions[id].idx.length;
  let changed = true, guard = 0;
  while (changed && guard++ < 20) {
    changed = false;
    // order small comps ascending so the tiniest dissolve first
    const small = regions.filter(r => r.idx.length > 0 && r.idx.length < minArea).sort((a, b) => a.idx.length - b.idx.length);
    if (!small.length) break;
    for (const r of small) {
      if (r.idx.length === 0 || r.idx.length >= minArea) continue;
      const border = new Map(); // neighborId -> count
      for (let k = 0; k < r.idx.length; k++) {
        const p = r.idx[k]; const x = p % W, y = (p / W) | 0;
        const nb = [];
        if (x > 0) nb.push(p - 1); if (x < W - 1) nb.push(p + 1);
        if (y > 0) nb.push(p - W); if (y < H - 1) nb.push(p + W);
        for (const q of nb) { const c = comp[q]; if (c !== r.id) border.set(c, (border.get(c) || 0) + 1); }
      }
      if (!border.size) continue;
      let bestId = -1, bestCount = -1;
      for (const [c, n] of border) {
        // prefer the largest bordering neighbor to avoid chaining into another tiny
        if (n > bestCount || (n === bestCount && sizeOf(c) > sizeOf(bestId))) { bestCount = n; bestId = c; }
      }
      if (bestId < 0) continue;
      const dst = regions[bestId];
      // absorb pixels
      const merged = new Int32Array(dst.idx.length + r.idx.length);
      merged.set(dst.idx, 0); merged.set(r.idx, dst.idx.length);
      dst.idx = merged;
      for (let k = 0; k < r.idx.length; k++) comp[r.idx[k]] = bestId;
      // expand bbox
      dst.bbox.x0 = Math.min(dst.bbox.x0, r.bbox.x0); dst.bbox.y0 = Math.min(dst.bbox.y0, r.bbox.y0);
      dst.bbox.x1 = Math.max(dst.bbox.x1, r.bbox.x1); dst.bbox.y1 = Math.max(dst.bbox.y1, r.bbox.y1);
      r.idx = new Int32Array(0);
      changed = true;
    }
  }
  return regions.filter(r => r.idx.length > 0);
}

// ---- boundary tracing (mask -> SVG path) ------------------------------------

// Trace the outline(s) of a region mask as axis-aligned polygons using a
// boundary-following march over the pixel-grid edges. We walk the set of unit
// edges that separate an in-region pixel from an out-of-region one, chaining
// them into closed loops. Produces an exact (pixelated) outline; resvg fills it
// with the gradient.
function maskToPath(member, W, H, bbox) {
  // member: Uint8Array over full image, 1 if pixel in region.
  // Collect boundary edges as directed segments so interior holes close too.
  // Edge key by (x,y) grid corner. We use the standard "draw edge to the right
  // of each boundary pixel side" approach via a map of corner->corner links.
  const inReg = (x, y) => (x >= 0 && y >= 0 && x < W && y < H && member[y * W + x] === 1);
  // For each pixel in region, add the 4 sides that face outside as directed
  // edges (counter-clockwise so fill is correct). Corner coords are integer
  // grid points 0..W,0..H.
  const links = new Map(); // "x,y" start corner -> [x,y] end corner
  const addEdge = (ax, ay, bx, by) => { links.set(ax + ',' + ay, [bx, by]); };
  for (let y = bbox.y0; y <= bbox.y1; y++) {
    for (let x = bbox.x0; x <= bbox.x1; x++) {
      if (member[y * W + x] !== 1) continue;
      // top side faces out if pixel above is outside -> edge goes left->right?
      // Use CCW winding: outside-up => edge (x,y)->(x+1,y)
      if (!inReg(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!inReg(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!inReg(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!inReg(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }
  // Chain edges into loops.
  const loops = [];
  const used = new Set();
  for (const [startKey] of links) {
    if (used.has(startKey)) continue;
    const loop = [];
    let key = startKey;
    let guard = 0;
    const maxLen = links.size + 4;
    while (key && !used.has(key) && guard++ < maxLen) {
      used.add(key);
      const [px, py] = key.split(',').map(Number);
      loop.push([px, py]);
      const next = links.get(key);
      if (!next) break;
      key = next[0] + ',' + next[1];
      if (key === startKey) break;
    }
    if (loop.length >= 4) loops.push(simplifyColinear(loop));
  }
  if (!loops.length) return '';
  // Build a single path; subpaths combine via fill-rule nonzero (outer CCW,
  // holes CW thanks to opposite winding when traced from inside).
  let d = '';
  for (const lp of loops) {
    d += 'M' + lp.map(p => p[0] + ' ' + p[1]).join('L') + 'Z';
  }
  return d;
}

// Drop colinear midpoints from an axis-aligned polygon to shrink the path.
function simplifyColinear(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const colinear = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
    if (!colinear) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

// ---- gradient -> SVG --------------------------------------------------------

function profileStops(profile, stops) {
  const { r, g, b } = profile;
  const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const els = [];
  for (let s = 0; s < stops; s++) {
    const t = s / (stops - 1);
    const f = t * (BINS - 1), i0 = f | 0, i1 = Math.min(BINS - 1, i0 + 1), fr = f - i0;
    const cr = r[i0] * (1 - fr) + r[i1] * fr, cg = g[i0] * (1 - fr) + g[i1] * fr, cb = b[i0] * (1 - fr) + b[i1] * fr;
    els.push(`<stop offset="${(t * 100).toFixed(1)}%" stop-color="#${hex(cr)}${hex(cg)}${hex(cb)}"/>`);
  }
  return els.join('');
}

function gradientDef(fit, id, stops) {
  const s = profileStops(fit.profile, stops);
  if (fit.kind === 'linear') {
    const { ux, uy, lo, span } = fit.params;
    const x1 = ux * lo, y1 = uy * lo, x2 = ux * (lo + span), y2 = uy * (lo + span);
    return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}">${s}</linearGradient>`;
  }
  const { cx, cy, maxD } = fit.params;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${maxD.toFixed(1)}">${s}</radialGradient>`;
}

// ---- public API -------------------------------------------------------------

/**
 * Segment `img` into regions and fit a per-region linear/radial gradient (or a
 * flat fill when a gradient doesn't pay). Returns assembled SVG inner markup
 * plus per-region fits and coverage stats.
 *
 * @param {{width,height,data}} img  work-resolution RGBA image
 * @param {object} [opts]
 * @param {number} [opts.levels=5]        quant levels per channel (coarser = bigger regions)
 * @param {number} [opts.minAreaFrac=0.004] merge components smaller than this fraction of the image
 * @param {number} [opts.gradGainFrac=0.6]  use a gradient only if its RMSE <= flatRMSE * this
 * @param {number} [opts.stops=10]        gradient stop count
 * @returns {{ defs, body, svg, regions, coverage, residualRmse }}
 */
export function fitRegionGradients(img, opts = {}) {
  const { data, width: W, height: H } = img;
  const {
    levels = 4,
    minAreaFrac = 0.004,
    gradGainFrac = 0.6,
    stops = 10,
  } = opts;
  const step = 256 / levels;
  const minArea = Math.max(64, Math.floor(W * H * minAreaFrac));

  // 1. quantized labels
  const labels = new Int32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const o = p * 4;
    labels[p] = quantizeKey(data[o], data[o + 1], data[o + 2], step);
  }
  // 2. connected components + merge tiny ones
  const { comp, regions: raw } = connectedComponents(labels, W, H);
  const regions = mergeSmall(comp, raw, W, H, minArea).sort((a, b) => b.idx.length - a.idx.length);

  // 3. fit + emit per region
  const defs = [];
  const bodies = [];
  const fits = [];
  let gradCount = 0, flatCount = 0;
  let coveredSse = 0;
  const member = new Uint8Array(W * H);

  let gi = 0;
  for (const reg of regions) {
    const fit = fitRegionGradient(data, W, reg.idx, reg.bbox);
    // build mask for this region
    member.fill(0);
    for (let k = 0; k < reg.idx.length; k++) member[reg.idx[k]] = 1;
    const d = maskToPath(member, W, H, reg.bbox);
    if (!d) continue;

    const useGrad = fit.rmse <= fit.flat.rmse * gradGainFrac && fit.rmse < fit.flat.rmse - 1e-4;
    if (useGrad) {
      const id = 'rg' + (gi++);
      defs.push(gradientDef(fit, id, stops));
      bodies.push(`<path d="${d}" fill="url(#${id})"/>`);
      gradCount++;
      coveredSse += fit.sse;
      fits.push({ id, kind: fit.kind, rmse: fit.rmse, area: reg.idx.length, mode: 'gradient' });
    } else {
      const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
      const { r, g, b } = fit.flat;
      bodies.push(`<path d="${d}" fill="#${hex(r)}${hex(g)}${hex(b)}"/>`);
      flatCount++;
      coveredSse += fit.flat.rmse * fit.flat.rmse * reg.idx.length * 3 * 255 * 255;
      fits.push({ kind: 'flat', rmse: fit.flat.rmse, area: reg.idx.length, mode: 'flat' });
    }
  }

  const body = bodies.join('');
  const defsStr = defs.length ? `<defs>${defs.join('')}</defs>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defsStr}${body}</svg>`;
  const residualRmse = Math.sqrt(coveredSse / (W * H * 3)) / 255;

  // Fraction of pixels carried by the largest few regions. On a clean
  // multi-gradient image (sky/sun/ground) a handful of regions cover almost
  // everything; on a noisy image (a sphere on noise) the field shatters into
  // dozens of confetti regions and this stays low. The caller uses it to
  // refuse region-grad on noise-dominated inputs where the whole-image
  // gradient base is far better.
  const sortedAreas = fits.map(f => f.area).sort((a, b) => b - a);
  const top8 = sortedAreas.slice(0, 8).reduce((s, a) => s + a, 0);
  const topCoverage = top8 / (W * H);
  const fragmented = regions.length > 40 || topCoverage < 0.85;

  return {
    defs: defsStr,
    body,
    svg,
    regions: fits,
    coverage: { regions: regions.length, gradients: gradCount, flats: flatCount, topCoverage, fragmented },
    residualRmse,
  };
}
