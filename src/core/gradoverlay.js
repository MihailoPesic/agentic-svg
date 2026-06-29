// Strategy C: smooth-blob gradient overlay.
//
// regiongradient.js segments the WHOLE frame and rejects it when the field
// shatters on noise (a sphere on confetti). That throws away the one thing we
// actually want: the big smooth sphere/sun/face sitting *on* the noise.
//
// Here we go the other way. We don't try to partition the image. We find the
// few LARGE, SMOOTH, blobby regions directly, fit ONE radial gradient to each
// (elliptical falloff via gradientTransform), and emit them as gradient-filled
// shapes to be painted OVER the normal trace. Everything we can't confidently
// call a smooth blob we leave alone — the trace already handles it.
//
// Pipeline per image:
//   1. smoothness mask  : pixels whose local color gradient is small (flat or
//                         gently shaded) — texture/noise/edges are excluded.
//   2. connected comps  : large smooth components are blob candidates.
//   3. ellipse fit      : moments of the component give center + axes + tilt;
//                         a near-elliptical blob (sphere/sun/face) fills its
//                         ellipse well, so we render the gradient on that
//                         ellipse rather than a jagged pixel outline.
//   4. radial fit       : non-parametric bin profile vs distance-from-extreme,
//                         in the ELLIPSE's normalized frame so the iso-contours
//                         match the blob shape. Keep it only if the gradient
//                         clearly beats a flat fill of the same region.
//
// Additive + robust: if nothing qualifies we emit nothing (count 0) and the
// trace stands alone. We never reject the image.

const BINS = 40;

// ---- smoothness mask --------------------------------------------------------

// Per-pixel local gradient magnitude (max abs RGB delta to the 4-neighbours,
// averaged). Small => locally smooth. We blur the magnitude a touch so a single
// noisy pixel doesn't punch a hole in an otherwise smooth blob.
function smoothMask(data, W, H, thresh) {
  const grad = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x, o = p * 4;
      let g = 0, n = 0;
      // 4-neighbour color deltas
      if (x > 0) { g += chDelta(data, o, o - 4); n++; }
      if (x < W - 1) { g += chDelta(data, o, o + 4); n++; }
      if (y > 0) { g += chDelta(data, o, o - W * 4); n++; }
      if (y < H - 1) { g += chDelta(data, o, o + W * 4); n++; }
      grad[p] = n ? g / n : 0;
    }
  }
  // 3x3 box blur of the gradient field -> tolerant of isolated speckles.
  const sm = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= W) continue;
          s += grad[yy * W + xx]; c++;
        }
      }
      sm[y * W + x] = s / c;
    }
  }
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) mask[p] = sm[p] <= thresh ? 1 : 0;
  return mask;
}

function chDelta(data, a, b) {
  const dr = Math.abs(data[a] - data[b]);
  const dg = Math.abs(data[a + 1] - data[b + 1]);
  const db = Math.abs(data[a + 2] - data[b + 2]);
  return (dr + dg + db) / 3;
}

// Morphological open (erode then dilate) on a binary mask to drop thin smooth
// bridges between separate blobs and shave ragged 1px fringes — gives cleaner,
// rounder components for the ellipse fit.
function open(mask, W, H, r = 1) {
  return dilate(erode(mask, W, H, r), W, H, r);
}
function erode(mask, W, H, r) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let keep = 1;
    for (let dy = -r; dy <= r && keep; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= W || yy >= H || mask[yy * W + xx] === 0) { keep = 0; break; }
    }
    out[y * W + x] = keep;
  }
  return out;
}
function dilate(mask, W, H, r) {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let on = 0;
    for (let dy = -r; dy <= r && !on; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && mask[yy * W + xx]) { on = 1; break; }
    }
    out[y * W + x] = on;
  }
  return out;
}

// ---- connected components over the smooth mask ------------------------------

function components(mask, W, H) {
  const comp = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  const regions = [];
  for (let start = 0; start < W * H; start++) {
    if (mask[start] === 0 || comp[start] !== -1) continue;
    const id = regions.length;
    let sp = 0; stack[sp++] = start; comp[start] = id;
    const idx = [];
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    while (sp > 0) {
      const p = stack[--sp]; idx.push(p);
      const x = p % W, y = (p / W) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && comp[p - 1] === -1) { comp[p - 1] = id; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && comp[p + 1] === -1) { comp[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && comp[p - W] === -1) { comp[p - W] = id; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && comp[p + W] === -1) { comp[p + W] = id; stack[sp++] = p + W; }
    }
    regions.push({ id, idx: Int32Array.from(idx), bbox: { x0, y0, x1, y1 } });
  }
  return regions;
}

// ---- ellipse from second moments --------------------------------------------

// Fit an ellipse (center, semi-axes, rotation) to a pixel set via covariance of
// the coordinates. A 2D uniform ellipse has covariance diag(a^2/4, b^2/4) in
// its principal frame, so axis = 2*sqrt(eigenvalue). We inflate slightly so the
// ellipse covers the blob rather than the inertia-equivalent radius.
function fitEllipse(idx, W) {
  let n = idx.length, sx = 0, sy = 0;
  for (let k = 0; k < n; k++) { const p = idx[k]; sx += p % W; sy += (p / W) | 0; }
  const cx = sx / n, cy = sy / n;
  let xx = 0, yy = 0, xy = 0;
  for (let k = 0; k < n; k++) {
    const p = idx[k]; const dx = (p % W) - cx, dy = ((p / W) | 0) - cy;
    xx += dx * dx; yy += dy * dy; xy += dx * dy;
  }
  xx /= n; yy /= n; xy /= n;
  // eigen-decomposition of the 2x2 covariance
  const tr = xx + yy, det = xx * yy - xy * xy;
  const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
  // principal axis angle
  let theta;
  if (Math.abs(xy) < 1e-6) theta = (xx >= yy) ? 0 : Math.PI / 2;
  else theta = Math.atan2(l1 - xx, xy);
  // 2*sqrt(eig) is the semi-axis of the equivalent uniform ellipse; *1.06 pad.
  const ra = 2 * Math.sqrt(Math.max(0.5, l1)) * 1.06;
  const rb = 2 * Math.sqrt(Math.max(0.5, l2)) * 1.06;
  return { cx, cy, ra, rb, theta };
}

// ---- radial gradient fit in the ellipse frame -------------------------------

// Map a pixel into normalized polar radius around a chosen FOCUS center, using
// the ellipse's axis ratio + tilt for anisotropy. The radial extreme of a
// shaded sphere/sun is the highlight, which is usually OFF the centroid — so we
// let the caller pick the focus (brightness/color extreme) while the iso-t
// contours stay elliptical to match the blob. Reproduced in SVG by a
// radialGradient on a unit circle plus a gradientTransform.
function makeCoord(ell, fx, fy) {
  const { ra, rb, theta } = ell;
  const c = Math.cos(theta), s = Math.sin(theta);
  const ira = 1 / ra, irb = 1 / rb;
  return (x, y) => {
    const dx = x - fx, dy = y - fy;
    const u = (dx * c + dy * s) * ira;
    const v = (-dx * s + dy * c) * irb;
    return Math.hypot(u, v);
  };
}

// Candidate gradient centers for a region: the centroid, the luma-bright and
// luma-dark centroids (a highlight or a dark pole), and a coarse grid over the
// bbox. The best by SSE wins.
function candidateFoci(data, W, idx, bbox, cx, cy) {
  const foci = [[cx, cy]];
  let bx = 0, by = 0, bw = 0, dx = 0, dy = 0, dw = 0;
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k]; const x = p % W, y = (p / W) | 0; const o = p * 4;
    const l = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    const wb = l * l * l, wd = (255 - l) * (255 - l) * (255 - l);
    bx += x * wb; by += y * wb; bw += wb; dx += x * wd; dy += y * wd; dw += wd;
  }
  if (bw) foci.push([bx / bw, by / bw]);
  if (dw) foci.push([dx / dw, dy / dw]);
  const { x0, y0, x1, y1 } = bbox, bwd = x1 - x0, bhd = y1 - y0;
  for (let gy = 0; gy <= 2; gy++) for (let gx = 0; gx <= 2; gx++) foci.push([x0 + (gx / 2) * bwd, y0 + (gy / 2) * bhd]);
  return foci;
}

// Non-parametric profile (mean color per radius bin) over the region, then SSE.
function radialProfile(data, W, idx, coord) {
  const sumR = new Float64Array(BINS), sumG = new Float64Array(BINS), sumB = new Float64Array(BINS), cnt = new Float64Array(BINS);
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k]; const x = p % W, y = (p / W) | 0;
    let b = (coord(x, y) * (BINS - 1)) | 0; if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    const o = p * 4;
    sumR[b] += data[o]; sumG[b] += data[o + 1]; sumB[b] += data[o + 2]; cnt[b]++;
  }
  const pr = new Float64Array(BINS), pg = new Float64Array(BINS), pb = new Float64Array(BINS);
  let lr = 0, lg = 0, lb = 0, seen = false;
  for (let b = 0; b < BINS; b++) {
    if (cnt[b] > 0) { pr[b] = sumR[b] / cnt[b]; pg[b] = sumG[b] / cnt[b]; pb[b] = sumB[b] / cnt[b]; lr = pr[b]; lg = pg[b]; lb = pb[b]; seen = true; }
    else if (seen) { pr[b] = lr; pg[b] = lg; pb[b] = lb; }
  }
  for (let b = BINS - 1; b >= 0; b--) { if (cnt[b] === 0) { pr[b] = pr[b + 1] ?? lr; pg[b] = pg[b + 1] ?? lg; pb[b] = pb[b + 1] ?? lb; } }

  let sse = 0;
  for (let k = 0; k < idx.length; k++) {
    const p = idx[k]; const x = p % W, y = (p / W) | 0;
    let b = (coord(x, y) * (BINS - 1)) | 0; if (b < 0) b = 0; else if (b >= BINS) b = BINS - 1;
    const o = p * 4;
    const dr = data[o] - pr[b], dg = data[o + 1] - pg[b], db = data[o + 2] - pb[b];
    sse += dr * dr + dg * dg + db * db;
  }
  return { sse, profile: { r: pr, g: pg, b: pb } };
}

function flatStats(data, W, idx) {
  let mr = 0, mg = 0, mb = 0;
  for (let k = 0; k < idx.length; k++) { const o = idx[k] * 4; mr += data[o]; mg += data[o + 1]; mb += data[o + 2]; }
  mr /= idx.length; mg /= idx.length; mb /= idx.length;
  let sse = 0;
  for (let k = 0; k < idx.length; k++) { const o = idx[k] * 4; const dr = data[o] - mr, dg = data[o + 1] - mg, db = data[o + 2] - mb; sse += dr * dr + dg * dg + db * db; }
  return { r: mr, g: mg, b: mb, sse };
}

// ---- mask -> clip path ------------------------------------------------------

// Trace the region mask outline(s) as axis-aligned polygon loops (boundary
// march over pixel-grid edges). Used as a clip so the gradient only paints the
// actual smooth pixels — features/edges excluded from the mask stay as holes,
// and the trace shows through them. CCW outer + CW holes => nonzero fill works.
function maskToPath(member, W, H, bbox) {
  const inReg = (x, y) => (x >= 0 && y >= 0 && x < W && y < H && member[y * W + x] === 1);
  const links = new Map();
  const addEdge = (ax, ay, bx, by) => { links.set(ax + ',' + ay, [bx, by]); };
  for (let y = bbox.y0; y <= bbox.y1; y++) {
    for (let x = bbox.x0; x <= bbox.x1; x++) {
      if (member[y * W + x] !== 1) continue;
      if (!inReg(x, y - 1)) addEdge(x, y, x + 1, y);
      if (!inReg(x + 1, y)) addEdge(x + 1, y, x + 1, y + 1);
      if (!inReg(x, y + 1)) addEdge(x + 1, y + 1, x, y + 1);
      if (!inReg(x - 1, y)) addEdge(x, y + 1, x, y);
    }
  }
  const used = new Set();
  const loops = [];
  for (const [startKey] of links) {
    if (used.has(startKey)) continue;
    const loop = [];
    let key = startKey, guard = 0; const maxLen = links.size + 4;
    while (key && !used.has(key) && guard++ < maxLen) {
      used.add(key);
      const [px, py] = key.split(',').map(Number);
      loop.push([px, py]);
      const next = links.get(key); if (!next) break;
      key = next[0] + ',' + next[1];
      if (key === startKey) break;
    }
    if (loop.length >= 4) loops.push(simplifyColinear(loop));
  }
  if (!loops.length) return '';
  let d = '';
  for (const lp of loops) d += 'M' + lp.map(p => p[0] + ' ' + p[1]).join('L') + 'Z';
  return d;
}

function simplifyColinear(pts) {
  const out = []; const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const colinear = (a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1]);
    if (!colinear) out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

// Fill the gaps left by features/speckles inside the blob so the clip is the
// solid blob silhouette, not a confetti of the smooth pixels. A morphological
// close (dilate then erode) bridges the small holes; we keep the result for the
// CLIP only (the gradient was still fit on the genuinely-smooth pixels).
function closeMask(member, W, H, bbox, r) {
  // local dilate
  const dil = new Uint8Array(W * H);
  for (let y = bbox.y0; y <= bbox.y1; y++) for (let x = bbox.x0; x <= bbox.x1; x++) {
    let on = 0;
    for (let dy = -r; dy <= r && !on; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H && member[yy * W + xx]) { on = 1; break; }
    }
    dil[y * W + x] = on;
  }
  const out = new Uint8Array(W * H);
  for (let y = bbox.y0; y <= bbox.y1; y++) for (let x = bbox.x0; x <= bbox.x1; x++) {
    let keep = 1;
    for (let dy = -r; dy <= r && keep; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < bbox.x0 || yy < bbox.y0 || xx > bbox.x1 || yy > bbox.y1 || dil[yy * W + xx] === 0) { keep = 0; break; }
    }
    out[y * W + x] = keep;
  }
  return out;
}

// ---- SVG emission -----------------------------------------------------------

const hex = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');

function profileStops(profile, stops) {
  const { r, g, b } = profile;
  const els = [];
  for (let s = 0; s < stops; s++) {
    const t = s / (stops - 1);
    const f = t * (BINS - 1), i0 = f | 0, i1 = Math.min(BINS - 1, i0 + 1), fr = f - i0;
    const cr = r[i0] * (1 - fr) + r[i1] * fr, cg = g[i0] * (1 - fr) + g[i1] * fr, cb = b[i0] * (1 - fr) + b[i1] * fr;
    els.push(`<stop offset="${(t * 100).toFixed(1)}%" stop-color="#${hex(cr)}${hex(cg)}${hex(cb)}"/>`);
  }
  return els.join('');
}

// Emit the radial gradient on a unit circle and place it via gradientTransform:
// translate to the FOCUS, rotate by theta, scale by (ra, rb). The profile was
// fit in exactly that normalized frame, so this reproduces the elliptical
// falloff from an off-center highlight.
function gradientDef(ell, fx, fy, profile, id, stops) {
  const { ra, rb, theta } = ell;
  const deg = (theta * 180 / Math.PI).toFixed(2);
  const tf = `translate(${fx.toFixed(2)} ${fy.toFixed(2)}) rotate(${deg}) scale(${ra.toFixed(2)} ${rb.toFixed(2)})`;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="${tf}">${profileStops(profile, stops)}</radialGradient>`;
}

// The painted shape: the blob's own silhouette (mask path), filled with the
// elliptical radial gradient. Clipping to the mask (not the bounding ellipse)
// keeps the overlay off the noise/features outside it and lets the trace show
// through any holes — only the genuinely-smooth interior is repainted.
function blobShape(d, id) {
  return `<path d="${d}" fill="url(#${id})"/>`;
}

// ---- public API -------------------------------------------------------------

/**
 * Find large smooth blobs in `img` and emit a radial-gradient overlay for each.
 * Additive: returns inner SVG markup to paint over an existing trace. Never
 * rejects the image — if no blob qualifies, count is 0 and the overlay is empty.
 *
 * @param {{width,height,data}} img  work-resolution RGBA image
 * @param {object} [opts]
 * @param {number} [opts.smoothThresh=10]   max local gradient to count as smooth
 * @param {number} [opts.minAreaFrac=0.02]  ignore blobs smaller than this frac
 * @param {number} [opts.fillFrac=0.55]     blob must fill >= this much of its ellipse
 * @param {number} [opts.gradGainFrac=0.85] keep gradient only if rmse <= flatRmse*this
 * @param {number} [opts.maxBlobs=6]        cap on emitted overlays
 * @param {number} [opts.stops=12]          gradient stop count
 * @returns {{ overlaySvgInner, defs, body, count, regions }}
 */
export function fitGradientOverlay(img, opts = {}) {
  const { data, width: W, height: H } = img;
  const {
    smoothThresh = 10,
    minAreaFrac = 0.012,
    fillFrac = 0.6,
    gradGainFrac = 0.8,
    maxBlobs = 4,
    stops = 12,
  } = opts;
  const minArea = Math.max(200, Math.floor(W * H * minAreaFrac));

  const mask0 = smoothMask(data, W, H, smoothThresh);
  const mask = open(mask0, W, H, 1);

  // Candidate regions come from two mask sources:
  //  (1) the plain smooth mask — isolated smooth islands (orb, face).
  //  (2) smooth AND bright — a glowing sun is smooth-connected to a smooth sky,
  //      so it never separates on (1); thresholding on high luma carves it out
  //      as its own blob. (Symmetric dark band would carve a dark pole.)
  let lmin = 255, lmax = 0;
  const luma = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const o = p * 4; const l = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    luma[p] = l; if (mask[p]) { if (l < lmin) lmin = l; if (l > lmax) lmax = l; }
  }
  const sources = [mask];
  if (lmax - lmin > 60) {
    const hiCut = lmin + (lmax - lmin) * 0.72;
    const bright = new Uint8Array(W * H);
    for (let p = 0; p < W * H; p++) bright[p] = (mask[p] && luma[p] >= hiCut) ? 1 : 0;
    sources.push(open(bright, W, H, 1));
  }

  let regions = [];
  for (const src of sources) {
    for (const r of components(src, W, H)) if (r.idx.length >= minArea) regions.push(r);
  }
  // Largest-first: emit the full object (whole sphere) before its bright core,
  // so the core is deduped out. A sun that only exists in the bright source has
  // no full-object competitor (its sky is border-rejected and never emitted),
  // so it still gets through. Dedup runs only against EMITTED blobs.
  regions.sort((a, b) => b.idx.length - a.idx.length);

  const defs = [];
  const bodies = [];
  const kept = [];
  let gi = 0;
  const member = new Uint8Array(W * H);

  const keptBlobs = []; // {cx,cy,bbox} of emitted blobs, for overlap dedup
  for (const reg of regions) {
    if (kept.length >= maxBlobs) break;
    const ell = fitEllipse(reg.idx, W);
    if (ell.ra < 4 || ell.rb < 4) continue;

    // Skip if this candidate overlaps one we already emitted: either its center
    // sits inside an emitted blob, or it engulfs an emitted blob's center. This
    // collapses the smooth-source and bright-source duplicates of one object.
    let dup = false;
    for (const kb of keptBlobs) {
      const cIn = ell.cx >= kb.bbox.x0 && ell.cx <= kb.bbox.x1 && ell.cy >= kb.bbox.y0 && ell.cy <= kb.bbox.y1;
      const engulf = kb.cx >= reg.bbox.x0 && kb.cx <= reg.bbox.x1 && kb.cy >= reg.bbox.y0 && kb.cy <= reg.bbox.y1;
      if (cIn || engulf) { dup = true; break; }
    }
    if (dup) continue;

    // Blobbiness: how much of the fitted ellipse the region actually fills.
    // A clean sphere/disc fills most of it; a thin smooth streak or an L-shaped
    // smear fills little and we skip it (it isn't a radial blob).
    const ellArea = Math.PI * ell.ra * ell.rb;
    const fill = reg.idx.length / ellArea;
    if (fill < fillFrac) continue;

    // Reject background-spanning regions. A real blob (sphere/sun/face) is a
    // compact island; a sky or a full-frame skin field hugs the frame on most
    // sides and is already traced fine — overlaying it only adds jagged-edge
    // error. Count borders the bbox touches; >2 means it's the backdrop.
    const { x0, y0, x1, y1 } = reg.bbox;
    const touch = (x0 <= 1 ? 1 : 0) + (y0 <= 1 ? 1 : 0) + (x1 >= W - 2 ? 1 : 0) + (y1 >= H - 2 ? 1 : 0);
    if (touch >= 3) continue;
    // Also reject regions that nearly fill the frame both ways (a vignette/skin
    // backdrop rather than an object).
    if ((x1 - x0) >= W * 0.92 && (y1 - y0) >= H * 0.92) continue;

    // Search candidate gradient centers; the radial extreme (highlight / dark
    // pole) is rarely the centroid, so picking the best focus is what makes a
    // shaded sphere fit a single clean radial.
    const foci = candidateFoci(data, W, reg.idx, reg.bbox, ell.cx, ell.cy);
    let best = null;
    for (const [fx, fy] of foci) {
      const coord = makeCoord(ell, fx, fy);
      const { sse, profile } = radialProfile(data, W, reg.idx, coord);
      if (!best || sse < best.sse) best = { sse, profile, fx, fy };
    }
    const { sse, profile, fx, fy } = best;
    const flat = flatStats(data, W, reg.idx);
    const n3 = reg.idx.length * 3;
    const gradRmse = Math.sqrt(sse / n3) / 255;
    const flatRmse = Math.sqrt(flat.sse / n3) / 255;

    // Only worth an overlay if it's actually a gradient (clearly beats flat)
    // and reconstructs well. A flat smooth patch (e.g. the sticker's pink bg)
    // would just bloat the file — leave it to the trace.
    if (!(gradRmse <= flatRmse * gradGainFrac && flatRmse - gradRmse > 0.01)) continue;
    if (gradRmse > 0.16) continue;

    // Silhouette to paint: close the smooth mask so small feature/speckle holes
    // bridge, then trace it. We clip the gradient to THIS, not the bbox ellipse,
    // so we never paint past the blob into the noise.
    member.fill(0);
    for (let k = 0; k < reg.idx.length; k++) member[reg.idx[k]] = 1;
    const closed = closeMask(member, W, H, reg.bbox, 1);
    const d = maskToPath(closed, W, H, reg.bbox);
    if (!d) continue;

    const id = 'gc' + (gi++);
    defs.push(gradientDef(ell, fx, fy, profile, id, stops));
    bodies.push(blobShape(d, id));
    keptBlobs.push({ cx: ell.cx, cy: ell.cy, bbox: reg.bbox });
    kept.push({
      id, kind: 'radial', gradRmse, flatRmse,
      area: reg.idx.length, fill,
      ellipse: { cx: ell.cx, cy: ell.cy, ra: ell.ra, rb: ell.rb, theta: ell.theta },
      focus: { fx, fy },
    });
  }

  const defsStr = defs.length ? `<defs>${defs.join('')}</defs>` : '';
  const body = bodies.join('');
  return {
    overlaySvgInner: defsStr + body,
    defs: defsStr,
    body,
    count: kept.length,
    regions: kept,
  };
}
