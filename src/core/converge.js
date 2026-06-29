// Converge orchestrator — the differentiator.
//
//   trace (base skeleton) ─▶ render to seed canvas ─▶ measure error map
//        ─▶ targeted refinement (spend shapes where error is) ─▶ repeat
//
// Two strategies, chosen by the caller / classifier:
//   'trace-refine'  : VTracer base + light error-targeted polish (flat art)
//   'primitive'     : blank canvas + many primitives (photos / gradients)

import sharp from 'sharp';
import { vectorizeRaw } from '@neplex/vectorizer';
import { loadImage } from './image.js';
import { renderSvgToRgba } from './render.js';
import { rmse, dssim } from './metrics.js';
import { Model } from './optimizer.js';
import { TRACE_PRESETS } from './trace.js';
import { computeSaliency } from './saliency.js';
import { fitGradient, renderGradient, gradientSvg } from './gradient.js';

/** Strip the outer <svg> wrapper, returning inner markup only. */
export function innerSvg(svg) {
  const lt = svg.indexOf('<svg');
  if (lt < 0) return '';
  const gt = svg.indexOf('>', lt);
  const end = svg.lastIndexOf('</svg>');
  if (gt < 0 || end < 0 || end < gt) return '';
  return svg.slice(gt + 1, end).trim();
}

/** Trace a work-resolution RGBA image directly (no re-encode) to an SVG string. */
async function traceRaw(work, preset) {
  const buf = Buffer.from(work.data.buffer, work.data.byteOffset, work.data.byteLength);
  return vectorizeRaw(buf, { width: work.width, height: work.height }, preset);
}

/**
 * @param {string|Buffer} input  image path or bytes
 * @param {object} opts
 * @param {number} [opts.workRes=320]   working resolution (longest side)
 * @param {'trace-refine'|'primitive'} [opts.strategy='trace-refine']
 * @param {string} [opts.shape='any']   refinement primitive type
 * @param {number} [opts.budget=200]    max refinement shapes
 * @param {number} [opts.alpha=0.85]    refinement alpha
 * @param {Float32Array} [opts.weightMap]  per-pixel importance (saliency)
 * @param {object} [opts.tracePreset]   VTracer config
 * @param {(info)=>void} [opts.onProgress]
 */
export async function converge(input, opts = {}) {
  const {
    workRes = 320,
    traceRes = 0,        // 0 => trace at workRes; higher keeps text/detail crisp
    traceEnlarge = false, // upsample small images before tracing (crisp text)
    strategy = 'trace-refine',
    shape = 'any',
    budget = 200,
    alpha = 0.85,
    weightMap = null,
    saliency = false,
    tracePreset = TRACE_PRESETS.flat,
    onProgress = null,
    refineOpts = {},
  } = opts;

  const meta = await sharp(input).metadata();
  const work = await loadImage(input, { maxSize: workRes });
  const W = work.width, H = work.height;
  const origW = meta.width || W, origH = meta.height || H;
  const history = [];

  // Perceptual-importance weighting: spend shapes where a human would look.
  const importance = weightMap || (saliency ? computeSaliency(work) : null);

  let model;
  let baseSvg = null;
  let traceMetrics = null;

  let baseKind = 'trace';
  // Base coordinate space (defaults to the refine canvas; overridden by a
  // higher-resolution trace so text and fine edges stay crisp).
  let baseW = W, baseH = H, refineScale = 1;
  if (strategy === 'trace-refine') {
    // Trace at traceRes (>= workRes) so detail survives, then render that trace
    // down to the refine canvas. The base lives in trace space; the refine
    // group is scaled into it. For workRes==traceRes this is a no-op.
    const traceImg = (traceRes > W || traceEnlarge)
      ? await loadImage(input, { maxSize: traceRes || W, allowEnlarge: traceEnlarge })
      : work;
    const traceSvg = await traceRaw(traceImg, tracePreset);
    const traceInner = innerSvg(traceSvg);
    const traceSeed = renderSvgToRgba(traceSvg, W, H);
    const traceRmse = rmse(work.data, traceSeed.data, W, H);

    let seedData = traceSeed.data;
    baseSvg = traceInner;
    baseW = traceImg.width; baseH = traceImg.height; refineScale = baseW / W;
    let chosenRmse = traceRmse;

    // Also try a real gradient base; use it as the seed only if it's clearly
    // better than the trace (smooth/gradient-dominant images). No banding,
    // hundreds of bytes — and the refine loop then polishes the residual.
    if (opts.tryGradient !== false) {
      const fit = fitGradient(work);
      if (fit && fit.rmse < traceRmse * 0.85) {
        const { defs, rect } = gradientSvg(fit, W, H, 12);
        baseSvg = defs + rect;
        seedData = renderGradient(fit, W, H);
        chosenRmse = fit.rmse;
        baseKind = `gradient(${fit.kind})`;
        baseW = W; baseH = H; refineScale = 1; // gradient base lives in refine space
      }
    }
    traceMetrics = { rmse: chosenRmse, dssim: dssim(work.data, seedData, W, H), base: baseKind };
    model = new Model(work, { seedCanvas: seedData, baseSvg, baseW, baseH, refineScale });
    if (onProgress) onProgress({ phase: 'trace', svg: model.toSVG(), rmse: traceMetrics.rmse, dssim: traceMetrics.dssim, base: baseKind });
  } else {
    model = new Model(work); // blank (average-color) seed
  }

  const {
    targetDssim = null,       // stop early once work-res DSSIM <= this
    plateauWindow = 24,       // # of recent shapes to measure marginal gain over
    plateauRelGain = 0.012,   // stop if that window improved score < this fraction
    dssimCheckEvery = 8,
  } = opts;

  // A gradient base is already perceptually excellent; refining it for tiny
  // RMSE gains adds structure that HURTS perceptual quality (DSSIM). So when we
  // chose a gradient base, refine minimally — only genuinely high-error spots
  // (non-gradient elements) should qualify, via a stricter acceptance epsilon.
  let effBudget = budget;
  let effRefine = refineOpts;
  if (baseKind.startsWith('gradient')) {
    effBudget = Math.min(budget, 30);
    effRefine = { epsilon: Math.max(1e-6, model.score * 0.02), ...refineOpts };
  }

  const startScore = model.score;
  let added = 0;
  let stalls = 0;
  const maxStalls = Math.max(40, Math.floor(effBudget * 0.4));
  const recent = []; // {added, score} snapshots to detect a plateau

  for (let i = 0; i < effBudget; i++) {
    const r = model.refineStep(shape, alpha, { weightMap: importance, ...effRefine });
    if (r.improved) {
      added++;
      stalls = 0;
    } else {
      stalls++;
    }
    if (onProgress && (i % 10 === 0 || i === effBudget - 1)) {
      onProgress({ phase: 'refine', i: i + 1, budget: effBudget, added, score: model.score, improved: r.improved, model });
    }
    history.push({ i: i + 1, score: model.score, added, improved: r.improved });
    if (stalls >= maxStalls) break; // nothing improvable — converged

    // Plateau stop: if the last `plateauWindow` *added* shapes barely moved the
    // score, we've hit diminishing returns (the convergence-slider floor).
    if (r.improved) {
      recent.push({ added, score: model.score });
      if (recent.length > plateauWindow) {
        const past = recent[recent.length - 1 - plateauWindow];
        const relGain = (past.score - model.score) / (past.score || 1);
        if (relGain < plateauRelGain) break;
      }
    }

    // Target-quality stop.
    if (targetDssim != null && added > 0 && added % dssimCheckEvery === 0) {
      if (dssim(work.data, model.currentU8(), W, H) <= targetDssim) break;
    }
  }

  // Drop marginal refinement shapes (background residue / stray smears), but
  // only keep the prune if it doesn't meaningfully degrade fidelity — on some
  // images every shape contributes a little and pruning would hurt.
  if (model.shapes.length) {
    const preShapes = model.shapes;
    const preCurrent = model.current;
    const preScore = model.score;
    model.prunePass();
    if (model.score > preScore * 1.12) {
      model.shapes = preShapes;
      model.current = preCurrent;
      model.score = preScore;
    }
  }

  let finalDssim = dssim(work.data, model.currentU8(), W, H);
  // Safety guard: never ship something perceptually worse than the base. On
  // already-excellent bases (e.g. a fitted gradient) RMSE-driven refinement can
  // raise DSSIM; if so, discard the refinement layer and keep the clean base.
  let reverted = false;
  if (traceMetrics && finalDssim > traceMetrics.dssim) {
    model.shapes = [];
    finalDssim = traceMetrics.dssim;
    reverted = true;
  }
  return {
    model,
    svg: model.toSVG({ width: origW, height: origH }),
    work,
    metrics: {
      trace: traceMetrics,
      base: baseKind,
      startRmse: startScore,
      finalRmse: reverted ? traceMetrics.rmse : model.score,
      finalDssim,
      shapesAdded: reverted ? 0 : added,
      shapesTotal: model.shapes.length,
      reverted,
    },
    history,
  };
}
