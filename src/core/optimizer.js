// The optimizer: greedily adds primitives that most reduce whole-image RMSE,
// each found by random sampling + hill-climbing. Modeled on Fogleman's
// "primitive" algorithm, ported to JS — extended with two things existing
// tools don't ship: (1) seeding the canvas from a base trace, and (2)
// error-targeted refinement that spends shapes where the residual error is.

import { solidImage, averageColor } from './image.js';
import {
  computeColor, differenceFull, differencePartial, drawLines, scanlineArea,
} from './raster.js';
import { randomShape, randomShapeIn } from './shapes.js';
import { errorMap } from './metrics.js';

export class Model {
  /**
   * @param {import('./image.js').RGBAImage} target  working-resolution target
   * @param {object} [opts]
   * @param {{r,g,b}} [opts.bg]  background fill (defaults to image average)
   * @param {Uint8ClampedArray} [opts.seedCanvas]  starting canvas (e.g. a rendered trace)
   * @param {string} [opts.baseSvg]  inner SVG markup to emit beneath refinement shapes
   */
  constructor(target, opts = {}) {
    this.W = target.width;
    this.H = target.height;
    this.target = target.data;
    this.bg = opts.bg || averageColor(target);
    // The working canvas is Float32 (not Uint8) so incremental error scoring is
    // exact — Uint8 rounding would drift the greedy decisions over many shapes.
    if (opts.seedCanvas) {
      this.current = Float32Array.from(opts.seedCanvas);
    } else {
      this.current = Float32Array.from(solidImage(this.W, this.H, this.bg).data);
    }
    this.baseSvg = opts.baseSvg || null;
    // The base trace may live in a higher-resolution coordinate space than the
    // refinement canvas (so text stays crisp while the loop runs cheaply). The
    // refine group is scaled by refineScale to map into that base space.
    this.baseW = opts.baseW || this.W;
    this.baseH = opts.baseH || this.H;
    this.refineScale = opts.refineScale || 1;
    this.maxArea = Infinity; // optional per-shape area cap (set during refinement)
    this.score = differenceFull(this.target, this.current, this.W, this.H);
    this.shapes = []; // { shape, color:[r,g,b], alpha }
  }

  /** Energy (resulting RMSE) and chosen color/lines for a candidate shape. */
  _energy(shape, alpha) {
    const lines = shape.rasterize(this.W, this.H);
    const area = scanlineArea(lines);
    // Reject degenerate or oversized shapes — unbounded growth produces big
    // translucent blobs that shave RMSE but wreck the picture.
    if (area < 1 || area > this.maxArea) return { score: this.score + 1, color: [0, 0, 0], lines };
    const color = computeColor(this.target, this.current, lines, alpha, this.W);
    const score = differencePartial(this.target, this.current, lines, color, alpha, this.score, this.W, this.H);
    return { score, color, lines };
  }

  /** Hill-climb a shape: keep mutating while it improves, up to maxAge stalls. */
  _hillClimb(state, alpha, maxAge) {
    let best = state;
    let age = 0;
    while (age < maxAge) {
      const cand = best.shape.mutate(this.W, this.H);
      const e = this._energy(cand, alpha);
      if (e.score < best.score) {
        best = { shape: cand, ...e };
        age = 0;
      } else {
        age++;
      }
    }
    return best;
  }

  /** Best shape anywhere in the image (global greedy step). */
  bestShape(type, alpha, { candidates = 4, randomTries = 30, maxAge = 100 } = {}) {
    let best = null;
    for (let c = 0; c < candidates; c++) {
      let start = null;
      for (let i = 0; i < randomTries; i++) {
        const shape = randomShape(type, this.W, this.H);
        const e = this._energy(shape, alpha);
        if (!start || e.score < start.score) start = { shape, ...e };
      }
      const climbed = this._hillClimb(start, alpha, maxAge);
      if (!best || climbed.score < best.score) best = climbed;
    }
    return best;
  }

  /** Best shape seeded within a region (targeted refinement step). */
  bestShapeIn(type, alpha, region, { candidates = 3, randomTries = 24, maxAge = 80 } = {}) {
    let best = null;
    for (let c = 0; c < candidates; c++) {
      let start = null;
      for (let i = 0; i < randomTries; i++) {
        const shape = randomShapeIn(type, this.W, this.H, region);
        const e = this._energy(shape, alpha);
        if (!start || e.score < start.score) start = { shape, ...e };
      }
      const climbed = this._hillClimb(start, alpha, maxAge);
      if (!best || climbed.score < best.score) best = climbed;
    }
    return best;
  }

  /** Commit a shape into the model, updating the working canvas and score. */
  add(state, alpha) {
    drawLines(this.current, state.lines, state.color, alpha, this.W);
    this.score = state.score;
    this.shapes.push({ shape: state.shape, color: state.color, alpha });
  }

  /** One global optimization step. */
  step(type, alpha, opts) {
    const best = this.bestShape(type, alpha, opts);
    this.add(best, alpha);
    return this.score;
  }

  /**
   * One targeted refinement step: locate a high-error region (weighted by an
   * optional importance map), search there, and keep the shape only if it
   * improves the score. Returns { improved, score }.
   */
  refineStep(type, alpha, {
    block = 16, topK = 6, expand = 1.4, weightMap = null, epsilon = 1e-7,
    maxAreaFrac = 0.06, opts = {},
  } = {}) {
    const map = errorMap(this.target, this.current, this.W, this.H, block, weightMap);
    const cells = [...map.cells].sort((a, b) => b.err - a.err).slice(0, topK).filter((c) => c.err > 0);
    if (cells.length === 0) return { improved: false, score: this.score };
    // Pick a cell weighted by its error (explore, don't always hammer the top one).
    let totalErr = 0;
    for (const c of cells) totalErr += c.err;
    let pick = Math.random() * totalErr;
    let chosen = cells[0];
    for (const c of cells) { pick -= c.err; if (pick <= 0) { chosen = c; break; } }
    // Expand the cell into a search region.
    const cx = chosen.x + chosen.w / 2, cy = chosen.y + chosen.h / 2;
    const hw = (chosen.w * expand) / 2, hh = (chosen.h * expand) / 2;
    const region = {
      x: Math.max(0, cx - hw), y: Math.max(0, cy - hh),
      w: Math.min(this.W, hw * 2), h: Math.min(this.H, hh * 2),
    };
    // Cap shape area to the local neighbourhood (a few cells), never more than a
    // small fraction of the whole image — this is what stops giant blob artifacts.
    const cellArea = chosen.w * chosen.h;
    this.maxArea = Math.min(this.W * this.H * maxAreaFrac, Math.max(cellArea * 9, 256));
    const best = this.bestShapeIn(type, alpha, region, opts);
    this.maxArea = Infinity;
    if (best && best.score < this.score - epsilon) {
      this.add(best, alpha);
      return { improved: true, score: this.score };
    }
    return { improved: false, score: this.score };
  }

  /** Uint8 snapshot of the working canvas (for metrics that want integer RGBA). */
  currentU8() { return new Uint8ClampedArray(this.current); }

  /**
   * Render to an SVG string. The viewBox is the base (trace) coordinate space;
   * the refinement group is scaled into it so a low-res refine pass composites
   * correctly over a high-res trace.
   */
  toSVG({ width, height } = {}) {
    const bw = this.baseW, bh = this.baseH;
    const w = Math.round(width || bw);
    const h = Math.round(height || bh);
    const out = [];
    out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${bw} ${bh}">`);
    out.push(`<rect width="${bw}" height="${bh}" fill="${rgb(this.bg)}"/>`);
    if (this.baseSvg) out.push(`<g id="base">${this.baseSvg}</g>`);
    if (this.shapes.length) {
      const t = this.refineScale !== 1 ? ` transform="scale(${round(this.refineScale, 5)})"` : '';
      out.push(`<g id="refine"${t}>`);
      for (const { shape, color, alpha } of this.shapes) {
        const fill = alpha >= 0.999
          ? `fill="${rgbArr(color)}"`
          : `fill="${rgbArr(color)}" fill-opacity="${round(alpha, 3)}"`;
        out.push(shape.svg(fill));
      }
      out.push('</g>');
    }
    out.push('</svg>');
    return out.join('\n');
  }
}

function round(v, d) { const m = 10 ** d; return Math.round(v * m) / m; }
function rgb({ r, g, b }) { return `#${hex(r)}${hex(g)}${hex(b)}`; }
function rgbArr([r, g, b]) { return `#${hex(r)}${hex(g)}${hex(b)}`; }
function hex(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }

/** Convenience driver for plain global optimization (no trace seed). */
export async function run(model, { type = 'triangle', alpha = 0.5, steps = 100, opts = {}, onStep } = {}) {
  for (let i = 0; i < steps; i++) {
    const score = model.step(type, alpha, opts);
    if (onStep) await onStep(i + 1, score, model);
  }
  return model;
}
