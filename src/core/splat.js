// 2D anisotropic Gaussian splats with pure-SVG output (radialGradient ellipses).
// Gives the continuous smooth shading flat-fill vectorizers can't represent.
//
// A splat is an elliptical Gaussian alpha footprint: center (cx,cy), std devs
// sx >= sy, rotation th, peak alpha A. Per pixel: u=(dx cos+dy sin)/sx,
// v=(-dx sin+dy cos)/sy, d2=u²+v², a = A·g(sqrt(d2)/R), cut off at d2 > R².
//
// SVG can't encode exp() — a radialGradient interpolates stop-opacity linearly
// between stops. So g() is defined as exactly that piecewise-linear curve
// through Gaussian samples at the stop offsets. Internal compositing and the
// resvg render of the emitted SVG then agree by construction (verified in
// scripts/test-splat.js: rmse ~0.006 over 40 random splats, budget 0.015).

import { errorMap } from './metrics.js';

export const R_CUT = 2.5; // footprint radius in std devs; edge alpha forced to 0

// Stop offsets (fraction of R) and relative opacities exp(-(o·R)²/2), last 0.
// The internal alpha profile is the piecewise-linear interpolation of these
// samples — exactly what the emitted radialGradient renders — so internal and
// SVG stay in agreement whatever the stop count. Five stops keeps defs small.
export const STOP_OFFSETS = [0, 0.25, 0.5, 0.75, 1];
const STOP_RELS = STOP_OFFSETS.map((o, i) =>
  i === STOP_OFFSETS.length - 1 ? 0 : Math.exp(-((o * R_CUT) ** 2) / 2));

const S_MIN = 1.2;          // smallest useful std dev (px)
const A_MIN = 0.03, A_MAX = 0.95;

/** Piecewise-linear Gaussian profile, t = r/R in [0,1). Matches the SVG stops. */
function profile(t) {
  if (t >= 1) return 0;
  let k = 1;
  while (STOP_OFFSETS[k] < t) k++;
  const f = (t - STOP_OFFSETS[k - 1]) / (STOP_OFFSETS[k] - STOP_OFFSETS[k - 1]);
  return STOP_RELS[k - 1] + (STOP_RELS[k] - STOP_RELS[k - 1]) * f;
}

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function logUniform(lo, hi) {
  return lo * Math.exp(Math.random() * Math.log(hi / lo));
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function f2(v) { return Math.round(v * 100) / 100; }

export class GaussianSplat {
  constructor(cx, cy, sx, sy, th, A, color = [128, 128, 128]) {
    this.cx = cx; this.cy = cy;
    this.sx = sx; this.sy = sy;
    this.th = th; this.A = A;
    this.color = color;
  }

  /**
   * Random splat. Center inside `region` (defaults to the whole image); scales
   * log-uniform from a few px up to the region size (or `scale.min/max`).
   */
  static random(W, H, region = null, scale = null) {
    const rg = region || { x: 0, y: 0, w: W, h: H };
    const cx = rg.x + Math.random() * rg.w;
    const cy = rg.y + Math.random() * rg.h;
    const lo = Math.max(S_MIN, (scale && scale.min) || S_MIN);
    const hi = clamp(Math.max(lo + 1, (scale && scale.max) || Math.max(rg.w, rg.h)), 4, Math.max(W, H) * 0.6);
    const a = logUniform(lo, hi), b = logUniform(lo, hi);
    const sx = Math.max(a, b), sy = Math.min(a, b);
    const th = Math.random() * Math.PI;
    const A = 0.05 + Math.random() * 0.85;
    return new GaussianSplat(cx, cy, sx, sy, th, A);
  }

  copy() {
    return new GaussianSplat(this.cx, this.cy, this.sx, this.sy, this.th, this.A, this.color.slice());
  }

  /** Gaussian-perturb one parameter; returns a new splat (original untouched). */
  mutate(W, H) {
    const s = this.copy();
    const sMax = Math.max(W, H) * 0.6;
    const step = Math.max(1, s.sx * 0.2);
    switch ((Math.random() * 6) | 0) {
      case 0: s.cx = clamp(s.cx + gauss() * step, 0, W); break;
      case 1: s.cy = clamp(s.cy + gauss() * step, 0, H); break;
      case 2: s.sx = clamp(s.sx * Math.exp(gauss() * 0.2), S_MIN, sMax); break;
      case 3: s.sy = clamp(s.sy * Math.exp(gauss() * 0.2), S_MIN, sMax); break;
      case 4: s.th += gauss() * 0.3; break;
      case 5: s.A = clamp(s.A + gauss() * 0.08, A_MIN, A_MAX); break;
    }
    if (s.sy > s.sx) { const t = s.sx; s.sx = s.sy; s.sy = t; s.th += Math.PI / 2; }
    return s;
  }

  /**
   * Per-pixel alpha footprint as scanline spans, clipped to the image.
   * Each span is { y, x1, x2, w } with w[i] = alpha at pixel x1+i (incl. A).
   */
  footprint(W, H) {
    const { cx, cy, sx, sy, th, A } = this;
    const cos = Math.cos(th), sin = Math.sin(th);
    const isx2 = 1 / (sx * sx), isy2 = 1 / (sy * sy);
    const qa = cos * cos * isx2 + sin * sin * isy2;
    const qb = 2 * cos * sin * (isx2 - isy2);
    const qc = sin * sin * isx2 + cos * cos * isy2;
    const R2 = R_CUT * R_CUT;
    const ry = R_CUT * Math.sqrt(sx * sx * sin * sin + sy * sy * cos * cos);
    const y0 = Math.max(0, Math.floor(cy - ry));
    const y1 = Math.min(H - 1, Math.ceil(cy + ry));
    const spans = [];
    for (let y = y0; y <= y1; y++) {
      const yp = y + 0.5 - cy;
      // qa·xp² + qb·yp·xp + qc·yp² <= R² -> xp root interval
      const b = qb * yp, c = qc * yp * yp - R2;
      const disc = b * b - 4 * qa * c;
      if (disc <= 0) continue;
      const sq = Math.sqrt(disc);
      const xlo = (-b - sq) / (2 * qa) + cx;
      const xhi = (-b + sq) / (2 * qa) + cx;
      const x1 = Math.max(0, Math.ceil(xlo - 0.5));
      const x2 = Math.min(W - 1, Math.floor(xhi - 0.5));
      if (x2 < x1) continue;
      const w = new Float32Array(x2 - x1 + 1);
      for (let x = x1; x <= x2; x++) {
        const xp = x + 0.5 - cx;
        const d2 = qa * xp * xp + qb * xp * yp + qc * yp * yp;
        w[x - x1] = A * profile(Math.sqrt(d2) / R_CUT);
      }
      spans.push({ y, x1, x2, w });
    }
    return spans;
  }

  /** SVG emission: gradient def + ellipse element referencing it. */
  svg(id) {
    const [r, g, b] = this.color;
    const col = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    const stops = STOP_OFFSETS.map((o, i) =>
      `<stop offset="${o}" stop-color="${col}" stop-opacity="${Math.round(this.A * STOP_RELS[i] * 10000) / 10000}"/>`).join('');
    const def = `<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx=".5" cy=".5" r=".5">${stops}</radialGradient>`;
    const deg = f2((this.th * 180) / Math.PI);
    const cx = f2(this.cx), cy = f2(this.cy);
    const el = `<ellipse cx="${cx}" cy="${cy}" rx="${f2(R_CUT * this.sx)}" ry="${f2(R_CUT * this.sy)}" transform="rotate(${deg} ${cx} ${cy})" fill="url(#${id})"/>`;
    return { def, el };
  }
}

/**
 * Least-squares color for compositing the footprint over `current` to match
 * `target`: minimize Σ (t - c·a - cur·(1-a))² per channel
 *   -> c = Σ a·(t - cur·(1-a)) / Σ a².  Clamped to 0..255.
 */
export function computeColorWeighted(target, current, spans, W) {
  let sa2 = 0, sr = 0, sg = 0, sb = 0;
  for (const s of spans) {
    const w = s.w;
    let idx = (s.y * W + s.x1) * 4;
    for (let i = 0; i < w.length; i++, idx += 4) {
      const a = w[i];
      if (a <= 0) continue;
      const ia = 1 - a;
      sa2 += a * a;
      sr += a * (target[idx] - current[idx] * ia);
      sg += a * (target[idx + 1] - current[idx + 1] * ia);
      sb += a * (target[idx + 2] - current[idx + 2] * ia);
    }
  }
  if (sa2 < 1e-6) return [0, 0, 0];
  const cl = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  return [cl(sr / sa2), cl(sg / sa2), cl(sb / sa2)];
}

/**
 * Change in SSE (Σ over footprint of (new-t)² - (old-t)², RGB) if the splat
 * were composited — without mutating `current`. Negative = improvement.
 */
export function scoreDeltaWeighted(target, current, spans, color, W) {
  const [r, g, b] = color;
  let delta = 0;
  for (const s of spans) {
    const w = s.w;
    let idx = (s.y * W + s.x1) * 4;
    for (let i = 0; i < w.length; i++, idx += 4) {
      const a = w[i];
      if (a <= 0) continue;
      const ia = 1 - a;
      const t0 = target[idx], c0 = current[idx];
      const t1 = target[idx + 1], c1 = current[idx + 1];
      const t2 = target[idx + 2], c2 = current[idx + 2];
      const n0 = r * a + c0 * ia - t0, o0 = c0 - t0;
      const n1 = g * a + c1 * ia - t1, o1 = c1 - t1;
      const n2 = b * a + c2 * ia - t2, o2 = c2 - t2;
      delta += n0 * n0 - o0 * o0 + n1 * n1 - o1 * o1 + n2 * n2 - o2 * o2;
    }
  }
  return delta;
}

/** Composite the footprint over `current` (Float32Array RGBA), in place. */
export function drawWeighted(current, spans, color, W) {
  const [r, g, b] = color;
  for (const s of spans) {
    const w = s.w;
    let idx = (s.y * W + s.x1) * 4;
    for (let i = 0; i < w.length; i++, idx += 4) {
      const a = w[i];
      if (a <= 0) continue;
      const ia = 1 - a;
      current[idx] = r * a + current[idx] * ia;
      current[idx + 1] = g * a + current[idx + 1] * ia;
      current[idx + 2] = b * a + current[idx + 2] * ia;
    }
  }
}

/**
 * Greedy splat fitting on the residual between `target` and `seedCanvas`.
 * Each step: block error map -> error-weighted pick among top-K cells ->
 * random splat proposals seeded there -> hill-climb the best -> accept only
 * if whole-image RMSE drops.
 *
 * @param {{width,height,data}} target  working-resolution RGBA image
 * @param {ArrayLike<number>} seedCanvas  starting RGBA canvas (copied)
 * @returns {{ splats:{splat,color}[], defs:string, body:string, score:number, added:number }}
 */
export function fitSplats(target, seedCanvas, opts = {}) {
  const {
    budget = 300,
    tries = 48,          // random proposals per step
    maxAge = 40,         // hill-climb stall limit
    block = 16,          // error-map cell size
    topK = 8,            // cells eligible for the weighted pick
    expand = 3,          // cell -> search-region expansion
    bigFrac = 0.25,      // fraction of proposals allowed image-scale sizes
    targetRmse = null,
    plateauWindow = 30,  // accepted splats measured for the plateau stop
    plateauRelGain = 0.006,
    idPrefix = 'sp',
    onSplat = null,
    weightMap = null,    // per-pixel error weight; confines splats (e.g. to smooth areas)
  } = opts;

  const W = target.width, H = target.height;
  const T = target.data;
  const current = Float32Array.from(seedCanvas);
  const n3 = W * H * 3;

  let sse = 0;
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    const d0 = T[o] - current[o], d1 = T[o + 1] - current[o + 1], d2 = T[o + 2] - current[o + 2];
    sse += d0 * d0 + d1 * d1 + d2 * d2;
  }
  const rmseOf = (s) => Math.sqrt(Math.max(0, s) / n3) / 255;

  const evaluate = (splat) => {
    const spans = splat.footprint(W, H);
    if (spans.length === 0) return { splat, spans, color: [0, 0, 0], delta: Infinity };
    const color = computeColorWeighted(T, current, spans, W);
    const delta = scoreDeltaWeighted(T, current, spans, color, W);
    return { splat, spans, color, delta };
  };

  const splats = [];
  const defParts = [], bodyParts = [];
  let added = 0, stalls = 0;
  const maxStalls = Math.max(30, Math.floor(budget * 0.35));
  const recent = [];

  for (let it = 0; it < budget; it++) {
    const map = errorMap(T, current, W, H, block, weightMap);
    const cells = [...map.cells].sort((a, b) => b.err - a.err).slice(0, topK).filter((c) => c.err > 0);
    if (cells.length === 0) break;
    let tot = 0;
    for (const c of cells) tot += c.err;
    let pick = Math.random() * tot;
    let chosen = cells[0];
    for (const c of cells) { pick -= c.err; if (pick <= 0) { chosen = c; break; } }
    const cxm = chosen.x + chosen.w / 2, cym = chosen.y + chosen.h / 2;
    const hw = (chosen.w * expand) / 2, hh = (chosen.h * expand) / 2;
    const region = {
      x: Math.max(0, cxm - hw), y: Math.max(0, cym - hh),
      w: Math.min(W, hw * 2), h: Math.min(H, hh * 2),
    };

    let best = null;
    for (let i = 0; i < tries; i++) {
      const scale = Math.random() < bigFrac ? { max: Math.max(W, H) * 0.5 } : null;
      const ev = evaluate(GaussianSplat.random(W, H, region, scale));
      if (!best || ev.delta < best.delta) best = ev;
    }
    let age = 0;
    while (age < maxAge) {
      const ev = evaluate(best.splat.mutate(W, H));
      if (ev.delta < best.delta) { best = ev; age = 0; } else age++;
    }

    if (best.delta < 0) {
      drawWeighted(current, best.spans, best.color, W);
      sse += best.delta;
      best.splat.color = best.color;
      const { def, el } = best.splat.svg(`${idPrefix}${added}`);
      defParts.push(def);
      bodyParts.push(el);
      splats.push({ splat: best.splat, color: best.color });
      added++;
      stalls = 0;
      const score = rmseOf(sse);
      if (onSplat) onSplat({ added, score, splat: best.splat, color: best.color });
      if (targetRmse != null && score <= targetRmse) break;
      recent.push(score);
      if (recent.length > plateauWindow) {
        const past = recent[recent.length - 1 - plateauWindow];
        if ((past - score) / (past || 1) < plateauRelGain) break;
      }
    } else {
      stalls++;
      if (stalls >= maxStalls) break;
    }
  }

  return {
    splats,
    defs: defParts.join(''),
    body: bodyParts.join(''),
    score: rmseOf(sse),
    added,
  };
}

/**
 * Emit accepted splats with shared gradient defs. gradientUnits is
 * objectBoundingBox, so a def depends only on (color, peak alpha) — hundreds
 * of splats typically collapse to a handful of defs, cutting output size ~5x.
 * Peak alpha is quantized to 0.02 steps to make sharing effective.
 */
export function emitSplatsDeduped(entries, prefix = 'sp') {
  const defs = [];
  const seen = new Map();
  const body = [];
  const f2v = (v) => Math.round(v * 100) / 100;
  // Quantize def color to 32 levels/channel and alpha to 0.04 steps: at splat
  // opacities the shift is invisible, and neighbouring splats (a sky, a shaded
  // sphere) collapse onto shared defs instead of one def per splat.
  const q8 = (v) => Math.max(0, Math.min(255, Math.round(v / 12) * 12));
  const hex = (v) => v.toString(16).padStart(2, '0');
  for (const e of entries) {
    const s = e.splat || e;
    const [r, g, b] = (e.color || s.color).map(q8);
    const Aq = Math.max(0.06, Math.round(s.A * 16) / 16);
    const key = `${r},${g},${b},${Aq}`;
    let id = seen.get(key);
    if (!id) {
      id = `${prefix}${seen.size}`;
      seen.set(key, id);
      const col = `#${hex(r)}${hex(g)}${hex(b)}`;
      const stops = STOP_OFFSETS.map((o, i) =>
        `<stop offset="${o}" stop-color="${col}" stop-opacity="${Math.round(Aq * STOP_RELS[i] * 1000) / 1000}"/>`).join('');
      defs.push(`<radialGradient id="${id}" gradientUnits="objectBoundingBox" cx=".5" cy=".5" r=".5">${stops}</radialGradient>`);
    }
    const deg = f2v((s.th * 180) / Math.PI);
    const cx = f2v(s.cx), cy = f2v(s.cy);
    body.push(`<ellipse cx="${cx}" cy="${cy}" rx="${f2v(R_CUT * s.sx)}" ry="${f2v(R_CUT * s.sy)}" transform="rotate(${deg} ${cx} ${cy})" fill="url(#${id})"/>`);
  }
  return { defs: defs.join(''), body: body.join('') };
}
