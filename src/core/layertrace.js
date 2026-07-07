// Layered-quantization tracer: median-cut palette -> per-color binary masks
// -> VTracer binary traces, stacked back into one SVG.
//
// This is the architecture that lets classic layered tracers keep faint,
// thin detail (hairline grid lines, anti-aliased glyph edges) that VTracer's
// color clustering merges away: every palette color gets its own mask and its
// own crisp binary trace, so a 2-px line that's only 8% of the image's colors
// still becomes a real path. VTracer's path fitting (polygon by default here;
// spline scores the same on pixel-doubled input at ~3x the bytes) beats the
// run-length fitting of the older tracers.
//
// Binary-mode semantics (probed): VTracer thresholds the mask by luminance —
// dark pixels are foreground (gray 100 traces, gray 128 doesn't), light
// pixels background, and TRANSPARENT pixels count as dark. Masks are
// therefore encoded black-shape-on-white, fully opaque. Each emitted path
// carries its own translate() transform, which recolorPaths preserves.
//
// FEED IT NEAREST-NEIGHBOR UPSCALED PIXELS. A cubic/lanczos 2x upscale
// invents blended colors: dark text cores get averaged with their AA halos,
// the palette washes out, and ui-type images land ~15x worse (0.022 vs
// 0.0013 dssim measured on fixtures/ui.png). nearestUpscale() duplicates
// pixels instead — the palette sees only original colors while the tracer
// still gets 2x geometry (half-pixel precision, 1px features survive the
// speckle filter).

import { vectorizeRaw, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';

/** Integer-factor nearest upscale of an RGBA image (pixel duplication). */
export function nearestUpscale(img, factor = 2) {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return img;
  const { width: W, height: H, data } = img;
  const w2 = W * f, h2 = H * f;
  const out = new Uint8ClampedArray(w2 * h2 * 4);
  for (let y = 0; y < h2; y++) {
    const sy = (y / f) | 0;
    for (let x = 0; x < w2; x++) {
      const si = (sy * W + ((x / f) | 0)) * 4, di = (y * w2 + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { width: w2, height: h2, data: out };
}

/**
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA at trace resolution
 * @param {object} [opts]
 * @param {number} [opts.colors=48]      palette size K (capped at 64)
 * @param {number} [opts.cleanupPasses=1] 3x3 mode-filter passes on the label map
 *   (a 2nd pass helps at native resolution; both are no-ops on pixel-doubled input)
 * @param {'area'|'luma'} [opts.order='area'] layer stacking order
 * @param {number} [opts.minShare=0.0002] skip colors covering less of the image
 * @param {number} [opts.lloyd=1]        k-means refinement iterations on the palette
 * @param {number} [opts.keepAt=3]       cleanup flips pixels whose label appears <= keepAt times in 3x3
 * @param {number} [opts.dilate=0]       dilate each mask by N px (seals seams)
 * @param {object} [opts.trace]          binary trace config overrides
 * @returns {Promise<string>} plain <svg ...><path .../>...</svg>
 */
export async function layerTrace(img, opts = {}) {
  const {
    colors = 48,
    cleanupPasses = 1,
    order = 'area',
    minShare = 0.0002,
    lloyd = 1,
    keepAt = 3,
    dilate = 0,
    trace = {},
  } = opts;
  const K = Math.min(64, Math.max(2, colors));
  const { width: W, height: H, data } = img;
  const px = W * H;

  const palette = medianCut(data, px, K);
  let labels = assignLabels(data, px, palette);
  // Lloyd steps: median-cut centers are population-averaged, which drags
  // rare-but-distinct colors (dark text on light chrome) toward the mass.
  // Recentering on actual assignments separates them again.
  for (let it = 0; it < lloyd; it++) {
    recenterPalette(data, px, labels, palette);
    labels = assignLabels(data, px, palette);
  }
  for (let p = 0; p < cleanupPasses; p++) labels = modeFilter3x3(labels, W, H, keepAt);
  recenterPalette(data, px, labels, palette); // paint with true means of final regions

  // pixel counts per palette color; tiny colors are AA residue, skip them
  const counts = new Uint32Array(palette.length);
  for (let i = 0; i < px; i++) counts[labels[i]]++;
  const minPx = Math.max(9, Math.round(px * minShare));

  const layers = [];
  for (let c = 0; c < palette.length; c++) {
    if (counts[c] >= minPx) layers.push({ c, count: counts[c] });
  }
  if (order === 'luma') {
    // light colors first (usually paper/background), dark detail on top
    const luma = (c) => 0.299 * palette[c][0] + 0.587 * palette[c][1] + 0.114 * palette[c][2];
    layers.sort((a, b) => luma(b.c) - luma(a.c));
  } else {
    layers.sort((a, b) => b.count - a.count); // big background colors first
  }

  const cfg = {
    colorMode: ColorMode.Binary,
    hierarchical: Hierarchical.Stacked,
    // polygon matches spline dssim on this backend at ~1/3 the bytes (on
    // pixel-doubled input every stair step trips the corner threshold and
    // spline degenerates to polygon anyway)
    mode: PathSimplifyMode.Polygon,
    filterSpeckle: 2,
    colorPrecision: 6,
    layerDifference: 16,
    cornerThreshold: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    pathPrecision: 1,
    ...trace,
  };

  // native traces release the JS thread; run them in modest parallel batches
  // (masks are W*H*4 each — batching also caps peak memory)
  const BATCH = 8;
  const results = new Array(layers.length);
  for (let i = 0; i < layers.length; i += BATCH) {
    const slice = layers.slice(i, i + BATCH);
    await Promise.all(slice.map(async (layer, j) => {
      const mask = buildMask(labels, W, H, layer.c, dilate);
      const svg = await vectorizeRaw(mask, { width: W, height: H }, cfg);
      results[i + j] = recolorPaths(svg, hex(palette[layer.c]));
    }));
  }

  const body = results.filter(Boolean).join('');
  const bg = layers.length ? hex(palette[layers[0].c]) : '#ffffff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="${bg}"/>${body}</svg>`;
}

// --- palette ---------------------------------------------------------------

/** Median-cut quantization over a pixel subsample. Returns [[r,g,b], ...]. */
function medianCut(data, px, K) {
  // subsample for the cut decisions: every 2nd-3rd pixel is plenty
  const stride = px > 900000 ? 3 : px > 250000 ? 2 : 1;
  const n = Math.floor(px / stride);
  const samples = new Uint8Array(n * 3);
  for (let i = 0, o = 0; i < n; i++, o += 3) {
    const s = i * stride * 4;
    samples[o] = data[s]; samples[o + 1] = data[s + 1]; samples[o + 2] = data[s + 2];
  }

  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  // a box is a slice [lo,hi) of idx
  const boxes = [makeBox(samples, idx, 0, n)];
  while (boxes.length < K) {
    // split the most "important" box: population * widest channel range
    let bi = -1, bs = 0;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const score = (b.hi - b.lo) * b.range;
      if (b.range > 0 && score > bs) { bs = score; bi = i; }
    }
    if (bi < 0) break; // all boxes uniform
    const b = boxes[bi];
    const ch = b.channel;
    const sub = idx.subarray(b.lo, b.hi);
    // median split along the widest channel — snapped to a value boundary.
    // Cutting inside a run of equal values puts the same color in both
    // halves and wastes the split (equal-population palettes then collapse:
    // two distinct colors end up sharing one box and average together).
    const arr = Array.from(sub);
    arr.sort((a, c) => samples[a * 3 + ch] - samples[c * 3 + ch]);
    sub.set(arr);
    const mid0 = b.lo + ((b.hi - b.lo) >> 1);
    const v = samples[idx[mid0] * 3 + ch];
    let up = mid0, down = mid0;
    while (up < b.hi && samples[idx[up] * 3 + ch] === v) up++;
    while (down > b.lo && samples[idx[down - 1] * 3 + ch] === v) down--;
    // nearest real boundary; range > 0 guarantees one side exists
    let mid = mid0;
    if (down === b.lo) mid = up;
    else if (up === b.hi) mid = down;
    else mid = (mid0 - down <= up - mid0) ? down : up;
    boxes.splice(bi, 1, makeBox(samples, idx, b.lo, mid), makeBox(samples, idx, mid, b.hi));
  }

  return boxes.filter((b) => b.hi > b.lo).map((b) => {
    let r = 0, g = 0, bl = 0;
    for (let i = b.lo; i < b.hi; i++) {
      const o = idx[i] * 3;
      r += samples[o]; g += samples[o + 1]; bl += samples[o + 2];
    }
    const m = b.hi - b.lo;
    return [Math.round(r / m), Math.round(g / m), Math.round(bl / m)];
  });
}

function makeBox(samples, idx, lo, hi) {
  let rmin = 255, rmax = 0, gmin = 255, gmax = 0, bmin = 255, bmax = 0;
  for (let i = lo; i < hi; i++) {
    const o = idx[i] * 3;
    const r = samples[o], g = samples[o + 1], b = samples[o + 2];
    if (r < rmin) rmin = r; if (r > rmax) rmax = r;
    if (g < gmin) gmin = g; if (g > gmax) gmax = g;
    if (b < bmin) bmin = b; if (b > bmax) bmax = b;
  }
  const dr = rmax - rmin, dg = gmax - gmin, db = bmax - bmin;
  let channel = 0, range = dr;
  if (dg > range) { channel = 1; range = dg; }
  if (db > range) { channel = 2; range = db; }
  return { lo, hi, channel, range };
}

/** Nearest-palette label per pixel, memoized on 5-bit-per-channel color keys. */
function assignLabels(data, px, palette) {
  const labels = new Uint8Array(px);
  const cache = new Int8Array(1 << 15).fill(-1);
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let lab = cache[key];
    if (lab < 0) {
      let bd = Infinity;
      for (let c = 0; c < palette.length; c++) {
        const p = palette[c];
        const dr = r - p[0], dg = g - p[1], db = b - p[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; lab = c; }
      }
      cache[key] = lab;
    }
    labels[i] = lab;
  }
  return labels;
}

/** Reset each palette entry to the mean color of the pixels assigned to it. */
function recenterPalette(data, px, labels, palette) {
  const K = palette.length;
  const sums = new Float64Array(K * 3);
  const counts = new Uint32Array(K);
  for (let i = 0; i < px; i++) {
    const c = labels[i], o = i * 4;
    sums[c * 3] += data[o]; sums[c * 3 + 1] += data[o + 1]; sums[c * 3 + 2] += data[o + 2];
    counts[c]++;
  }
  for (let c = 0; c < K; c++) {
    if (!counts[c]) continue; // orphaned entry keeps its old color
    palette[c] = [
      Math.round(sums[c * 3] / counts[c]),
      Math.round(sums[c * 3 + 1] / counts[c]),
      Math.round(sums[c * 3 + 2] / counts[c]),
    ];
  }
}

// --- label cleanup ----------------------------------------------------------

/**
 * Conditional 3x3 mode filter: a pixel flips to the neighborhood majority
 * only when its own label barely appears there (<= keepAt occurrences,
 * itself included). Unconditional majority voting erodes 2-3px strokes —
 * a thin-stroke pixel loses 6-vs-3 to the background and text gets eaten —
 * while the conditional form still kills isolated AA speckle. Ties keep
 * the center pixel.
 */
function modeFilter3x3(labels, W, H, keepAt = 3) {
  const out = new Uint8Array(labels.length);
  const vals = new Uint8Array(9);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - 1), y1 = Math.min(H - 1, y + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(W - 1, x + 1);
      let n = 0;
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * W;
        for (let xx = x0; xx <= x1; xx++) vals[n++] = labels[row + xx];
      }
      const center = labels[y * W + x];
      // mode of <=9 small ints: O(n^2) beats a K-sized histogram reset
      let bestLab = center, bestCount = 0, tie = false, centerCount = 0;
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        let cnt = 1;
        for (let j = i + 1; j < n; j++) if (vals[j] === v) cnt++;
        if (v === center && cnt > centerCount) centerCount = cnt;
        if (cnt > bestCount) { bestCount = cnt; bestLab = v; tie = false; }
        else if (cnt === bestCount && v !== bestLab) tie = true;
      }
      out[y * W + x] = (tie || centerCount > keepAt) ? center : bestLab;
    }
  }
  return out;
}

// --- masks + recolor ---------------------------------------------------------

/** Black shape on white background (binary mode treats dark as foreground). */
function buildMask(labels, W, H, color, dilate = 0) {
  const px = W * H;
  let on = new Uint8Array(px);
  for (let i = 0; i < px; i++) if (labels[i] === color) on[i] = 1;
  for (let d = 0; d < dilate; d++) {
    // 4-neighborhood grow: seals the hairline seams exclusive masks leave
    const grown = Uint8Array.from(on);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        if (on[i]) continue;
        if ((x > 0 && on[i - 1]) || (x < W - 1 && on[i + 1])
          || (y > 0 && on[i - W]) || (y < H - 1 && on[i + W])) grown[i] = 1;
      }
    }
    on = grown;
  }
  const mask = Buffer.alloc(px * 4, 255);
  for (let i = 0; i < px; i++) {
    if (on[i]) {
      const o = i * 4;
      mask[o] = 0; mask[o + 1] = 0; mask[o + 2] = 0;
    }
  }
  return mask;
}

/** Pull the path elements out of a binary trace and re-fill them. */
function recolorPaths(svg, fill) {
  let out = '';
  const re = /<path\b[^>]*>/g;
  let m;
  while ((m = re.exec(svg))) {
    const tag = m[0]
      .replace(/\s(?:fill|stroke|stroke-width)="[^"]*"/g, '')
      .replace(/<path/, `<path fill="${fill}"`);
    out += tag.endsWith('/>') ? tag : tag.replace(/>$/, '/>');
  }
  return out;
}

function hex([r, g, b]) {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
