// Post-trace geometric fitting. VTracer traces every region boundary as a
// dense spline, so a perfect circle comes back as a wavy 40-node path and a
// triangle gets lumpy edges. This pass recognizes those cases and snaps them:
//
//   1. single closed subpaths that are algebraically circles/ellipses become
//      real <circle>/<ellipse> elements (Kasa fit + axis-aligned conic fit),
//   2. runs of near-collinear vertices collapse to single line segments, and
//      cubics whose control points sit on the chord degrade to plain L's.
//
// Fidelity first: every replacement is gated on a max radial residual that is
// small relative to the shape (default 1.5% of radius, sub-pixel floor), so a
// snapped shape can't expose the stacked VTracer layer underneath its rim.
// Multi-subpath paths (holes) only get the conservative line cleanup; their
// fill-rule rendering is never restructured.

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Tokenize a path `d` string into { cmd, nums } runs. Returns null on any
 *  command we don't model (A/S/Q/T) so callers leave the path untouched. */
function parseD(d) {
  const out = [];
  const re = /([MmLlHhVvCcZz])([^MmLlHhVvCcZzAaSsQqTt]*)/g;
  // Bail if the string contains commands outside our alphabet.
  if (/[AaSsQqTt]/.test(d)) return null;
  let consumed = 0;
  let m;
  while ((m = re.exec(d)) !== null) {
    consumed += m[0].length;
    const nums = (m[2].match(NUM) || []).map(Number);
    out.push({ cmd: m[1], nums });
  }
  // Anything besides whitespace left unmatched means an exotic path — bail.
  if (d.replace(re, '').trim() !== '' || consumed === 0) return null;
  return out;
}

/**
 * Turn parsed commands into subpaths of absolute segments.
 * Each subpath: { start:{x,y}, segs:[{type:'L',x,y} | {type:'C',x1,y1,x2,y2,x,y}], closed }
 * Returns null when the data is malformed.
 */
function toSubpaths(cmds) {
  const subs = [];
  let cur = null;
  let x = 0, y = 0;      // current point
  let sx = 0, sy = 0;    // subpath start
  for (const { cmd, nums } of cmds) {
    const rel = cmd >= 'a' && cmd <= 'z';
    const C = cmd.toUpperCase();
    let i = 0;
    const need = { M: 2, L: 2, H: 1, V: 1, C: 6, Z: 0 }[C];
    if (C !== 'Z' && (nums.length === 0 || nums.length % need !== 0)) return null;
    if (C === 'Z') {
      if (cur) { cur.closed = true; x = sx; y = sy; }
      continue;
    }
    while (i < nums.length) {
      if (C === 'M' && i === 0) {
        x = rel ? x + nums[0] : nums[0];
        y = rel ? y + nums[1] : nums[1];
        sx = x; sy = y;
        cur = { start: { x, y }, segs: [], closed: false };
        subs.push(cur);
        i += 2;
        continue;
      }
      if (!cur) return null;
      if (C === 'M' || C === 'L') { // extra M pairs are implicit linetos
        const nx = rel ? x + nums[i] : nums[i];
        const ny = rel ? y + nums[i + 1] : nums[i + 1];
        cur.segs.push({ type: 'L', x: nx, y: ny });
        x = nx; y = ny; i += 2;
      } else if (C === 'H') {
        const nx = rel ? x + nums[i] : nums[i];
        cur.segs.push({ type: 'L', x: nx, y });
        x = nx; i += 1;
      } else if (C === 'V') {
        const ny = rel ? y + nums[i] : nums[i];
        cur.segs.push({ type: 'L', x, y: ny });
        y = ny; i += 1;
      } else { // C
        const x1 = rel ? x + nums[i] : nums[i], y1 = rel ? y + nums[i + 1] : nums[i + 1];
        const x2 = rel ? x + nums[i + 2] : nums[i + 2], y2 = rel ? y + nums[i + 3] : nums[i + 3];
        const nx = rel ? x + nums[i + 4] : nums[i + 4], ny = rel ? y + nums[i + 5] : nums[i + 5];
        cur.segs.push({ type: 'C', x1, y1, x2, y2, x: nx, y: ny });
        x = nx; y = ny; i += 6;
      }
    }
  }
  return subs.filter((s) => s.segs.length > 0);
}

/** Sample a subpath outline to a dense point list (curves at `perCurve` steps). */
function samplePoints(sub, perCurve = 12) {
  const pts = [{ x: sub.start.x, y: sub.start.y }];
  let px = sub.start.x, py = sub.start.y;
  for (const s of sub.segs) {
    if (s.type === 'L') {
      pts.push({ x: s.x, y: s.y });
    } else {
      for (let k = 1; k <= perCurve; k++) {
        const t = k / perCurve, u = 1 - t;
        const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
        pts.push({
          x: a * px + b * s.x1 + c * s.x2 + d * s.x,
          y: a * py + b * s.y1 + c * s.y2 + d * s.y,
        });
      }
    }
    px = s.x; py = s.y;
  }
  return pts;
}

/** Kasa algebraic circle fit -> { cx, cy, r, maxErr, meanErr } or null. */
function fitCircle(pts) {
  const n = pts.length;
  if (n < 8) return null;
  // Solve [x y 1] . [a b c]^T = x^2 + y^2 via 3x3 normal equations.
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, sxz = 0, syz = 0, sz = 0;
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y;
    sxx += p.x * p.x; sxy += p.x * p.y; sx += p.x;
    syy += p.y * p.y; sy += p.y;
    sxz += p.x * z; syz += p.y * z; sz += z;
  }
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const b = [sxz, syz, sz];
  const sol = solve3(A, b);
  if (!sol) return null;
  const cx = sol[0] / 2, cy = sol[1] / 2;
  const r2 = sol[2] + cx * cx + cy * cy;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  let maxErr = 0, sumErr = 0;
  for (const p of pts) {
    const e = Math.abs(Math.hypot(p.x - cx, p.y - cy) - r);
    if (e > maxErr) maxErr = e;
    sumErr += e;
  }
  return { cx, cy, r, maxErr, meanErr: sumErr / n };
}

/** Axis-aligned ellipse fit: A x^2 + C y^2 + D x + E y = 1 (coords pre-shifted
 *  to the centroid so the origin is inside). -> { cx, cy, rx, ry, maxErr } */
function fitEllipse(pts) {
  const n = pts.length;
  if (n < 8) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  // Normal equations for [A C D E].
  const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const v = [0, 0, 0, 0];
  for (const p of pts) {
    const X = p.x - mx, Y = p.y - my;
    const row = [X * X, Y * Y, X, Y];
    for (let i = 0; i < 4; i++) {
      v[i] += row[i];
      for (let j = 0; j < 4; j++) M[i][j] += row[i] * row[j];
    }
  }
  const sol = solveN(M, v);
  if (!sol) return null;
  const [A, C, D, E] = sol;
  if (!(A > 0) || !(C > 0)) return null;
  const cx = -D / (2 * A), cy = -E / (2 * C);
  const G = 1 + A * cx * cx + C * cy * cy;
  if (!(G > 0)) return null;
  const rx = Math.sqrt(G / A), ry = Math.sqrt(G / C);
  let maxErr = 0;
  for (const p of pts) {
    const X = p.x - mx - cx, Y = p.y - my - cy;
    const rho = Math.hypot(X, Y);
    const s = Math.sqrt((X / rx) * (X / rx) + (Y / ry) * (Y / ry));
    if (s <= 0) return null;
    const e = Math.abs(rho * (1 - 1 / s)); // radial distance to the ellipse
    if (e > maxErr) maxErr = e;
  }
  return { cx: mx + cx, cy: my + cy, rx, ry, maxErr };
}

/** Require samples to wrap the whole shape (rejects arcs/semicircles that
 *  happen to sit on a circle). 12 angular bins, at least 10 occupied. */
function fullCoverage(pts, cx, cy) {
  const bins = new Array(12).fill(false);
  for (const p of pts) {
    const a = Math.atan2(p.y - cy, p.x - cx);
    bins[Math.min(11, Math.floor(((a + Math.PI) / (2 * Math.PI)) * 12))] = true;
  }
  return bins.filter(Boolean).length >= 10;
}

function solve3(A, b) { return solveN(A.map((r) => r.slice()), b.slice()); }

/** Gaussian elimination with partial pivoting; null when singular. */
function solveN(A, b) {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col];
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < n; c++) s -= A[r][c] * x[c];
    x[r] = s / A[r][r];
  }
  return x;
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Is this cubic effectively its own chord? (control points on the line) */
function cubicIsStraight(px, py, s, tol) {
  const a = { x: px, y: py }, b = { x: s.x, y: s.y };
  return distToSeg({ x: s.x1, y: s.y1 }, a, b) <= tol
    && distToSeg({ x: s.x2, y: s.y2 }, a, b) <= tol;
}

/**
 * Straight-line cleanup on one subpath: demote straight cubics to lines, then
 * greedily merge consecutive line vertices whose intermediates stay within
 * `tol` of the merged segment. Genuine curves pass through untouched.
 */
function cleanSubpath(sub, tol) {
  // Pass 1: cubic -> line where the control points sit on the chord.
  let px = sub.start.x, py = sub.start.y;
  const segs = sub.segs.map((s) => {
    const out = s.type === 'C' && cubicIsStraight(px, py, s, tol)
      ? { type: 'L', x: s.x, y: s.y }
      : s;
    px = s.x; py = s.y;
    return out;
  });
  // Pass 2: collapse runs of near-collinear line vertices.
  const merged = [];
  let anchor = { x: sub.start.x, y: sub.start.y };
  let i = 0;
  while (i < segs.length) {
    if (segs[i].type !== 'L') {
      merged.push(segs[i]);
      anchor = { x: segs[i].x, y: segs[i].y };
      i++;
      continue;
    }
    // Extend j while every intermediate vertex stays within tol of anchor->v_j.
    let j = i;
    const verts = []; // vertices covered so far (intermediates)
    while (j + 1 < segs.length && segs[j + 1].type === 'L') {
      verts.push({ x: segs[j].x, y: segs[j].y });
      const end = { x: segs[j + 1].x, y: segs[j + 1].y };
      if (!verts.every((v) => distToSeg(v, anchor, end) <= tol)) { verts.pop(); break; }
      j++;
    }
    merged.push({ type: 'L', x: segs[j].x, y: segs[j].y });
    anchor = { x: segs[j].x, y: segs[j].y };
    i = j + 1;
  }
  return { start: sub.start, segs: merged, closed: sub.closed };
}

const fmt = (n) => {
  const s = n.toFixed(2);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

function emitD(subs) {
  let d = '';
  for (const sub of subs) {
    d += `M${fmt(sub.start.x)} ${fmt(sub.start.y)}`;
    for (const s of sub.segs) {
      d += s.type === 'L'
        ? `L${fmt(s.x)} ${fmt(s.y)}`
        : `C${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)}`;
    }
    if (sub.closed) d += 'Z';
  }
  return d;
}

/**
 * Recognize and snap traced geometry in an SVG string.
 * @param {string} svgString
 * @param {object} [opts]
 * @param {number} [opts.circleTol=0.015]  max radial residual as fraction of radius
 * @param {number} [opts.residualFloor=0.4] absolute residual floor in px (sub-pixel)
 * @param {number} [opts.lineTol=0.5]      collinearity deviation in px
 * @param {number} [opts.minRadius=3]      don't snap shapes smaller than this
 * @param {number} [opts.perCurve=12]      samples per cubic segment
 * @returns {string} rewritten SVG
 */
export function fitPrimitives(svgString, opts = {}) {
  const {
    circleTol = 0.015,
    residualFloor = 0.4,
    lineTol = 0.5,
    minRadius = 3,
    perCurve = 12,
    maxAspect = 8,
  } = opts;

  return svgString.replace(/<path\b[^>]*?\/>|<path\b[^>]*?><\/path>/g, (tag) => {
    const dm = tag.match(/\bd="([^"]*)"/);
    if (!dm) return tag;
    const cmds = parseD(dm[1]);
    if (!cmds) return tag;
    const subs = toSubpaths(cmds);
    if (!subs || subs.length === 0) return tag;

    // Single closed subpath: try to snap to a true circle / ellipse.
    if (subs.length === 1 && subs[0].closed) {
      const pts = samplePoints(subs[0], perCurve);
      const attrs = tag
        .replace(/^<path\b/, '')
        .replace(/\/>$|><\/path>$/, '')
        .replace(/\s*\bd="[^"]*"/, '')
        .trim();
      const circ = fitCircle(pts);
      if (circ && circ.r >= minRadius
        && circ.maxErr <= Math.max(circleTol * circ.r, residualFloor)
        && fullCoverage(pts, circ.cx, circ.cy)) {
        return `<circle cx="${fmt(circ.cx)}" cy="${fmt(circ.cy)}" r="${fmt(circ.r)}"${attrs ? ' ' + attrs : ''}/>`;
      }
      const ell = fitEllipse(pts);
      if (ell && Math.min(ell.rx, ell.ry) >= minRadius
        && Math.max(ell.rx, ell.ry) / Math.min(ell.rx, ell.ry) <= maxAspect
        && ell.maxErr <= Math.max(circleTol * Math.min(ell.rx, ell.ry), residualFloor)
        && fullCoverage(pts, ell.cx, ell.cy)) {
        return `<ellipse cx="${fmt(ell.cx)}" cy="${fmt(ell.cy)}" rx="${fmt(ell.rx)}" ry="${fmt(ell.ry)}"${attrs ? ' ' + attrs : ''}/>`;
      }
    }

    // Everything else (including holes): conservative straight-line cleanup
    // per subpath. This only merges vertices that already lie on a line, so
    // fill-rule rendering and silhouettes are preserved to within lineTol.
    const cleaned = subs.map((s) => cleanSubpath(s, lineTol));
    const newD = emitD(cleaned);
    if (newD.length >= dm[1].length) return tag; // no win — keep the original
    return tag.replace(/\bd="[^"]*"/, `d="${newD}"`);
  });
}
