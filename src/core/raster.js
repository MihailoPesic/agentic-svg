// Rasterization, optimal-color computation, and error metrics.
// All functions work on flat RGBA Uint8ClampedArray buffers (opaque images).
//
// A "scanline" is { y, x1, x2 } with x1..x2 inclusive — the pixels a shape
// covers on row y. Shapes produce arrays of scanlines clipped to the image.

/**
 * Fill an arbitrary polygon into scanlines using pixel-center sampling.
 * points: array of {x,y} (floats). Returns clipped scanlines within [0,W)x[0,H).
 */
export function polygonScanlines(points, W, H) {
  const lines = [];
  let minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(H - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < points.length; i++) {
      let a = points[i];
      let b = points[(i + 1) % points.length];
      let ay = a.y, by = b.y, ax = a.x, bx = b.x;
      if (ay === by) continue;
      if (ay > by) { const t1 = ay; ay = by; by = t1; const t2 = ax; ax = bx; bx = t2; }
      if (yc < ay || yc >= by) continue;
      const t = (yc - ay) / (by - ay);
      xs.push(ax + t * (bx - ax));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      let xa = Math.round(xs[i]);
      let xb = Math.round(xs[i + 1]) - 1;
      if (xa < 0) xa = 0;
      if (xb > W - 1) xb = W - 1;
      if (xb >= xa) lines.push({ y, x1: xa, x2: xb });
    }
  }
  return lines;
}

/** Axis-aligned ellipse scanlines (cx,cy center, rx,ry radii). */
export function ellipseScanlines(cx, cy, rx, ry, W, H) {
  const lines = [];
  if (rx < 0.5 || ry < 0.5) return lines;
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(H - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (dy < -1 || dy > 1) continue;
    const dx = rx * Math.sqrt(1 - dy * dy);
    let xa = Math.round(cx - dx);
    let xb = Math.round(cx + dx) - 1;
    if (xa < 0) xa = 0;
    if (xb > W - 1) xb = W - 1;
    if (xb >= xa) lines.push({ y, x1: xa, x2: xb });
  }
  return lines;
}

/** Count the number of pixels covered by a scanline set. */
export function scanlineArea(lines) {
  let n = 0;
  for (const l of lines) n += l.x2 - l.x1 + 1;
  return n;
}

/**
 * Optimal flat color (minimizing squared error) for compositing a shape with
 * the given alpha over `current` to best match `target`, restricted to `lines`.
 * Returns [r,g,b] ints 0..255.  Derivation: out = X*a + c*(1-a); choose X per
 * channel = mean over covered pixels of (t - c)/a + c.
 */
export function computeColor(target, current, lines, alpha, W) {
  let rs = 0, gs = 0, bs = 0, count = 0;
  const inv = 1 / Math.max(alpha, 1e-4); // guard against alpha=0 -> Infinity/NaN
  for (const line of lines) {
    let idx = (line.y * W + line.x1) * 4;
    for (let x = line.x1; x <= line.x2; x++) {
      const tr = target[idx], tg = target[idx + 1], tb = target[idx + 2];
      const cr = current[idx], cg = current[idx + 1], cb = current[idx + 2];
      rs += (tr - cr) * inv + cr;
      gs += (tg - cg) * inv + cg;
      bs += (tb - cb) * inv + cb;
      count++;
      idx += 4;
    }
  }
  if (count === 0) return [0, 0, 0];
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return [clamp(rs / count), clamp(gs / count), clamp(bs / count)];
}

/** Full RMSE between two images, normalized to 0..1 (over RGB channels). */
export function differenceFull(target, current, W, H) {
  let total = 0;
  const px = W * H;
  if (px === 0) return 0;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const dr = target[o] - current[o];
    const dg = target[o + 1] - current[o + 1];
    const db = target[o + 2] - current[o + 2];
    total += dr * dr + dg * dg + db * db;
  }
  return Math.sqrt(total / (px * 3)) / 255;
}

/**
 * Incremental RMSE if we were to composite `color` (alpha) over `current` on the
 * covered scanlines — WITHOUT mutating current. `score` is the current full RMSE.
 */
export function differencePartial(target, current, lines, color, alpha, score, W, H) {
  const n = W * H * 3;
  if (n === 0) return 0;
  let total = (score * 255) * (score * 255) * n;
  const ia = 1 - alpha;
  const ar = color[0] * alpha, ag = color[1] * alpha, ab = color[2] * alpha;
  for (const line of lines) {
    let idx = (line.y * W + line.x1) * 4;
    for (let x = line.x1; x <= line.x2; x++) {
      const tr = target[idx], tg = target[idx + 1], tb = target[idx + 2];
      const cr = current[idx], cg = current[idx + 1], cb = current[idx + 2];
      const nr = ar + cr * ia, ng = ag + cg * ia, nb = ab + cb * ia;
      const ob0 = tr - cr, ob1 = tg - cg, ob2 = tb - cb;
      const na0 = tr - nr, na1 = tg - ng, na2 = tb - nb;
      total += na0 * na0 - ob0 * ob0 + na1 * na1 - ob1 * ob1 + na2 * na2 - ob2 * ob2;
      idx += 4;
    }
  }
  if (total < 0) total = 0;
  return Math.sqrt(total / n) / 255;
}

/** Composite `color` (alpha) over `current` on the covered scanlines, in place. */
export function drawLines(current, lines, color, alpha, W) {
  const ia = 1 - alpha;
  const ar = color[0] * alpha, ag = color[1] * alpha, ab = color[2] * alpha;
  for (const line of lines) {
    let idx = (line.y * W + line.x1) * 4;
    for (let x = line.x1; x <= line.x2; x++) {
      current[idx] = ar + current[idx] * ia;
      current[idx + 1] = ag + current[idx + 1] * ia;
      current[idx + 2] = ab + current[idx + 2] * ia;
      idx += 4;
    }
  }
}
