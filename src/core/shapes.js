// Primitive shapes. Each shape can rasterize itself to scanlines, mutate by a
// small random perturbation (for hill-climbing), copy, and emit an SVG element.

import { polygonScanlines, ellipseScanlines } from './raster.js';

let _spare = null;
/** Standard-normal random via Box-Muller (cached spare). */
function gauss() {
  if (_spare !== null) { const s = _spare; _spare = null; return s; }
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const mag = Math.sqrt(-2 * Math.log(u));
  _spare = mag * Math.sin(2 * Math.PI * v);
  return mag * Math.cos(2 * Math.PI * v);
}
const clampi = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);

function rotate(px, py, cx, cy, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const dx = px - cx, dy = py - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

// ---------------------------------------------------------------------------
export class Triangle {
  constructor(p) { this.p = p; } // [{x,y},{x,y},{x,y}]
  static random(W, H) {
    const x = rnd(0, W), y = rnd(0, H);
    const m = Math.max(W, H) * 0.35;
    const p = [];
    for (let i = 0; i < 3; i++) p.push({ x: x + rnd(-m, m), y: y + rnd(-m, m) });
    return new Triangle(p);
  }
  rasterize(W, H) { return polygonScanlines(this.p, W, H); }
  copy() { return new Triangle(this.p.map((q) => ({ x: q.x, y: q.y }))); }
  mutate(W, H) {
    const s = this.copy();
    const i = Math.floor(Math.random() * 3);
    const m = Math.max(W, H);
    s.p[i].x = clampi(s.p[i].x + gauss() * m * 0.08, -m * 0.1, W + m * 0.1);
    s.p[i].y = clampi(s.p[i].y + gauss() * m * 0.08, -m * 0.1, H + m * 0.1);
    return s;
  }
  svg(fill) {
    const d = this.p.map((q) => `${r2(q.x)},${r2(q.y)}`).join(' ');
    return `<polygon points="${d}" ${fill}/>`;
  }
}

// ---------------------------------------------------------------------------
export class Ellipse {
  constructor(cx, cy, rx, ry) { this.cx = cx; this.cy = cy; this.rx = rx; this.ry = ry; }
  static random(W, H) {
    return new Ellipse(rnd(0, W), rnd(0, H), rnd(2, W * 0.25), rnd(2, H * 0.25));
  }
  rasterize(W, H) { return ellipseScanlines(this.cx, this.cy, this.rx, this.ry, W, H); }
  copy() { return new Ellipse(this.cx, this.cy, this.rx, this.ry); }
  mutate(W, H) {
    const s = this.copy();
    const m = Math.max(W, H);
    switch (Math.floor(Math.random() * 3)) {
      case 0: s.cx = clampi(s.cx + gauss() * m * 0.08, 0, W); s.cy = clampi(s.cy + gauss() * m * 0.08, 0, H); break;
      case 1: s.rx = clampi(s.rx + gauss() * m * 0.08, 1, W); break;
      default: s.ry = clampi(s.ry + gauss() * m * 0.08, 1, H); break;
    }
    return s;
  }
  svg(fill) { return `<ellipse cx="${r2(this.cx)}" cy="${r2(this.cy)}" rx="${r2(this.rx)}" ry="${r2(this.ry)}" ${fill}/>`; }
}

// ---------------------------------------------------------------------------
export class RotatedEllipse {
  constructor(cx, cy, rx, ry, ang) { this.cx = cx; this.cy = cy; this.rx = rx; this.ry = ry; this.ang = ang; }
  static random(W, H) {
    return new RotatedEllipse(rnd(0, W), rnd(0, H), rnd(2, W * 0.25), rnd(2, H * 0.25), rnd(0, Math.PI));
  }
  _poly() {
    const n = 24;
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI;
      const x = this.cx + this.rx * Math.cos(a);
      const y = this.cy + this.ry * Math.sin(a);
      pts.push(rotate(x, y, this.cx, this.cy, this.ang));
    }
    return pts;
  }
  rasterize(W, H) { return polygonScanlines(this._poly(), W, H); }
  copy() { return new RotatedEllipse(this.cx, this.cy, this.rx, this.ry, this.ang); }
  mutate(W, H) {
    const s = this.copy();
    const m = Math.max(W, H);
    switch (Math.floor(Math.random() * 4)) {
      case 0: s.cx = clampi(s.cx + gauss() * m * 0.08, 0, W); s.cy = clampi(s.cy + gauss() * m * 0.08, 0, H); break;
      case 1: s.rx = clampi(s.rx + gauss() * m * 0.08, 1, W); break;
      case 2: s.ry = clampi(s.ry + gauss() * m * 0.08, 1, H); break;
      default: s.ang += gauss() * 0.3; break;
    }
    return s;
  }
  svg(fill) {
    const deg = (this.ang * 180 / Math.PI).toFixed(2);
    return `<ellipse cx="${r2(this.cx)}" cy="${r2(this.cy)}" rx="${r2(this.rx)}" ry="${r2(this.ry)}" transform="rotate(${deg} ${r2(this.cx)} ${r2(this.cy)})" ${fill}/>`;
  }
}

// ---------------------------------------------------------------------------
export class RotatedRectangle {
  constructor(cx, cy, w, h, ang) { this.cx = cx; this.cy = cy; this.w = w; this.h = h; this.ang = ang; }
  static random(W, H) {
    return new RotatedRectangle(rnd(0, W), rnd(0, H), rnd(4, W * 0.5), rnd(4, H * 0.5), rnd(0, Math.PI));
  }
  _corners() {
    const hw = this.w / 2, hh = this.h / 2;
    return [
      rotate(this.cx - hw, this.cy - hh, this.cx, this.cy, this.ang),
      rotate(this.cx + hw, this.cy - hh, this.cx, this.cy, this.ang),
      rotate(this.cx + hw, this.cy + hh, this.cx, this.cy, this.ang),
      rotate(this.cx - hw, this.cy + hh, this.cx, this.cy, this.ang),
    ];
  }
  rasterize(W, H) { return polygonScanlines(this._corners(), W, H); }
  copy() { return new RotatedRectangle(this.cx, this.cy, this.w, this.h, this.ang); }
  mutate(W, H) {
    const s = this.copy();
    const m = Math.max(W, H);
    switch (Math.floor(Math.random() * 4)) {
      case 0: s.cx = clampi(s.cx + gauss() * m * 0.08, 0, W); s.cy = clampi(s.cy + gauss() * m * 0.08, 0, H); break;
      case 1: s.w = clampi(s.w + gauss() * m * 0.08, 1, W); break;
      case 2: s.h = clampi(s.h + gauss() * m * 0.08, 1, H); break;
      default: s.ang += gauss() * 0.3; break;
    }
    return s;
  }
  svg(fill) {
    const deg = (this.ang * 180 / Math.PI).toFixed(2);
    return `<rect x="${r2(this.cx - this.w / 2)}" y="${r2(this.cy - this.h / 2)}" width="${r2(this.w)}" height="${r2(this.h)}" transform="rotate(${deg} ${r2(this.cx)} ${r2(this.cy)})" ${fill}/>`;
  }
}

// ---------------------------------------------------------------------------
export const SHAPE_TYPES = {
  triangle: Triangle,
  ellipse: Ellipse,
  rotatedellipse: RotatedEllipse,
  rect: RotatedRectangle,
};

export function randomShape(type, W, H) {
  if (type === 'any') {
    const keys = Object.keys(SHAPE_TYPES);
    type = keys[Math.floor(Math.random() * keys.length)];
  }
  const cls = SHAPE_TYPES[type];
  if (!cls) throw new Error(`unknown shape type: ${type}`);
  return cls.random(W, H);
}

/**
 * Create a random shape seeded inside a region {x,y,w,h}. Used by the targeted
 * refiner to spend shapes where the error map is highest. Sizes scale to the
 * region so corrections are local; mutation can still drift outward.
 */
export function randomShapeIn(type, W, H, region) {
  if (type === 'any') {
    const keys = Object.keys(SHAPE_TYPES);
    type = keys[Math.floor(Math.random() * keys.length)];
  }
  const cx = region.x + Math.random() * region.w;
  const cy = region.y + Math.random() * region.h;
  const s = Math.max(region.w, region.h);
  switch (type) {
    case 'triangle': {
      const p = [];
      for (let i = 0; i < 3; i++) p.push({ x: cx + rnd(-s, s), y: cy + rnd(-s, s) });
      return new Triangle(p);
    }
    case 'ellipse':
      return new Ellipse(cx, cy, rnd(1, s * 0.7), rnd(1, s * 0.7));
    case 'rotatedellipse':
      return new RotatedEllipse(cx, cy, rnd(1, s * 0.7), rnd(1, s * 0.7), rnd(0, Math.PI));
    case 'rect':
      return new RotatedRectangle(cx, cy, rnd(1, s * 1.4), rnd(1, s * 1.4), rnd(0, Math.PI));
    default:
      throw new Error(`unknown shape type: ${type}`);
  }
}

function r2(v) { return Math.round(v * 100) / 100; }
