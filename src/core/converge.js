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
import { loadImage, averageColor } from './image.js';
import { renderSvgToRgba } from './render.js';
import { rmse, dssim } from './metrics.js';
import { Model } from './optimizer.js';
import { TRACE_PRESETS } from './trace.js';
import { computeSaliency } from './saliency.js';
import { fitGradient, renderGradient, gradientSvg } from './gradient.js';
import { fitRegionGradients } from './regiongradient.js';
import { fitGradientOverlay } from './gradoverlay.js';
import { fitPrimitives } from './pathfit.js';
import { fitSplats, emitSplatsDeduped } from './splat.js';
import { layerTrace, nearestUpscale } from './layertrace.js';
import { chooseTraceLadder, estimateBytes } from './sizegov.js';

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
 * Base-trace dispatch. The 'layered' backend quantizes to a K-color palette
 * and traces each color as its own binary layer — the architecture that wins
 * on screenshots and fine line work. It needs a NEAREST-neighbor 2x upscale:
 * cubic resampling invents blended colors that wash the palette out (measured
 * 15x worse on text).
 */
async function traceBase(img, preset, opts) {
  if (opts.traceBackend === 'layered') {
    return layerTrace(nearestUpscale(img, 2), { colors: opts.layerK || 48 });
  }
  return traceRaw(img, preset);
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
  let importance = weightMap || (saliency ? computeSaliency(work) : null);

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
    let traceImg = (traceRes > W || traceEnlarge)
      ? await loadImage(input, { maxSize: traceRes || W, allowEnlarge: traceEnlarge })
      : work;
    // Post-trace geometric fitting: snap traced polylines that are really
    // circles/ellipses to true primitives and straighten near-collinear runs.
    // Rounder shapes, straighter edges, and much smaller paths — done before
    // the seed render so scoring sees the fitted geometry.
    // Per-class snap/merge tolerances: `false` skips geometric fitting, an
    // object overrides pathfit defaults (photos need tighter tolerances or the
    // 1-2px anti-alias slivers get visibly distorted).
    const pf = (svg) => (opts.pathfitOpts === false ? svg : fitPrimitives(svg, opts.pathfitOpts || {}));
    let traceSvg = pf(await traceBase(traceImg, tracePreset, opts));

    // Size governor: photographic content can trace to megabytes. When over
    // the byte budget, walk coarser preset rungs and reduced trace resolutions
    // in measured fidelity-per-byte order; a byte predictor (bytes halve per
    // rung, scale ~res^2.2) skips straight to the likely landing candidate so
    // we don't pay for every re-trace. 50KB headroom is reserved for the
    // refinement layer.
    const HEADROOM = 50 * 1024;
    // The governor's ladder re-traces with VTracer presets, which would
    // silently swap backends under a layered run — and layered output is
    // byte-bounded by its K anyway, so it opts out.
    if (opts.traceBackend !== 'layered'
      && Number.isFinite(opts.maxBaseBytes) && estimateBytes(traceSvg).estimatedFinal + HEADROOM > opts.maxBaseBytes) {
      const ladder = chooseTraceLadder(tracePreset);
      const cands = [
        { rung: 1, res: 1 }, { rung: 1, res: 0.7 }, { rung: 1, res: 0.57 },
        { rung: 2, res: 0.7 }, { rung: 2, res: 0.57 }, { rung: 3, res: 0.57 },
      ];
      const baseSide = Math.max(traceImg.width, traceImg.height);
      const over = (estimateBytes(traceSvg).estimatedFinal + HEADROOM) / opts.maxBaseBytes;
      let pick = cands.findIndex((c) => (0.5 ** c.rung) * (c.res ** 2.2) <= 1 / over);
      if (pick < 0) pick = cands.length - 1;
      const attempt = async (c) => {
        const img = c.res === 1 ? traceImg : await loadImage(input, { maxSize: Math.round(baseSide * c.res) });
        const svg = pf(await traceRaw(img, ladder[Math.min(c.rung, ladder.length - 1)]));
        return { img, svg, bytes: estimateBytes(svg).estimatedFinal };
      };
      let att = await attempt(cands[pick]);
      while (att.bytes + HEADROOM > opts.maxBaseBytes && pick < cands.length - 1) {
        pick++;
        att = await attempt(cands[pick]);
      }
      traceImg = att.img;
      traceSvg = att.svg;
    }
    const traceInner = innerSvg(traceSvg);
    const traceSeed = renderSvgToRgba(traceSvg, W, H);
    const traceRmse = rmse(work.data, traceSeed.data, W, H);

    let seedData = traceSeed.data;
    baseSvg = traceInner;
    // Base geometry lives in the trace SVG's own coordinate space — trust its
    // viewBox over the image dims (the layered backend traces a nearest-2x
    // canvas, so its coordinates span twice traceImg).
    const tvb = traceSvg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
    baseW = tvb ? +tvb[1] : traceImg.width;
    baseH = tvb ? +tvb[2] : traceImg.height;
    refineScale = baseW / W;
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

    // Per-region gradients: replace the posterized/banded flat regions a photo
    // trace produces with native per-region linear/radial gradient fills. Only
    // when the current base still isn't close, only when the segmentation isn't
    // shattered by noise, and only if it actually beats the current base.
    if (opts.tryRegionGradient !== false) {
      const curD = dssim(work.data, seedData, W, H);
      if (curD > 0.02) {
        const rg = fitRegionGradients(work, { levels: 4 });
        if (!rg.coverage.fragmented) {
          const rgSeed = renderSvgToRgba(rg.svg, W, H);
          if (dssim(work.data, rgSeed.data, W, H) < curD) {
            baseSvg = rg.defs + rg.body;
            seedData = rgSeed.data;
            chosenRmse = rmse(work.data, rgSeed.data, W, H);
            baseKind = 'region-gradient';
            baseW = W; baseH = H; refineScale = 1;
          }
        }
      }
    }
    // Overlay native gradients onto large smooth blobs (a shaded sphere, a sun,
    // a face) so they render as one smooth radial/linear instead of banding.
    // Additive over whatever base we chose; on images with no clean blob it's a
    // no-op. The seed is re-rendered so the refiner sees the smooth gradient
    // rather than trying (and failing) to fix the banding itself.
    if (opts.tryGradientOverlay !== false) {
      const ov = fitGradientOverlay(work);
      if (ov && ov.count > 0) {
        const beforeD = dssim(work.data, seedData, W, H);
        const t = refineScale !== 1 ? ` transform="scale(${refineScale.toFixed(5)})"` : '';
        const withOverlay = `${baseSvg}<g id="grad-overlay"${t}>${ov.overlaySvgInner}</g>`;
        const bg = averageColor(work);
        const composed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${baseW} ${baseH}"><rect width="${baseW}" height="${baseH}" fill="rgb(${bg.r},${bg.g},${bg.b})"/>${withOverlay}</svg>`;
        const ovSeed = renderSvgToRgba(composed, W, H).data;
        // Apply only if it genuinely improves the base — otherwise it's a no-op.
        if (dssim(work.data, ovSeed, W, H) < beforeD) {
          baseSvg = withOverlay;
          seedData = ovSeed;
          chosenRmse = rmse(work.data, seedData, W, H);
          baseKind += '+overlay';
          // Stop the refiner from re-faceting the smooth blobs the overlay just
          // laid down: render the overlay's coverage and drop the refinement
          // weight to ~zero there.
          const maskInner = ov.overlaySvgInner.replace(/<defs>[\s\S]*?<\/defs>/g, '').replace(/fill="url\([^"]*\)"/g, 'fill="#ffffff"');
          const maskSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${baseW} ${baseH}"><rect width="${baseW}" height="${baseH}" fill="#000000"/><g${t}>${maskInner}</g></svg>`;
          const mask = renderSvgToRgba(maskSvg, W, H).data;
          if (!importance) { importance = new Float32Array(W * H); importance.fill(1); }
          for (let i = 0; i < W * H; i++) if (mask[i * 4] > 128) importance[i] = 0;
        }
      }
    }
    // Gaussian-splat shading candidate. Flat fills cannot represent continuous
    // 2D shading — SVG has no gradient meshes — but a stack of anisotropic
    // Gaussian splats (ellipses with radial-gradient falloff) can. Build a
    // competing base: a deliberately coarse trace whose shading error is
    // one-sided, plus a greedy splat fit that owns the shading. Adopt it only
    // when it renders measurably closer than the base chosen above.
    if (opts.useSplats) {
      // Coarse trace at full trace resolution: it supplies the color slabs and
      // the crisp region edges (mountains, silhouettes) under the splats.
      const shadingSvg = pf(await traceRaw(traceImg, TRACE_PRESETS.shading));
      const shadingSeed = renderSvgToRgba(shadingSvg, W, H);
      // Confine splats to smooth regions: weight their error map by inverse
      // local luma variation. Texture and noise stay with the primitive
      // refiner, which also keeps splat colors similar enough that gradient
      // defs dedupe well.
      const smoothW = new Float32Array(W * H);
      {
        const lum = new Float32Array(W * H);
        const D = work.data;
        for (let i = 0; i < W * H; i++) { const o = i * 4; lum[i] = 0.299 * D[o] + 0.587 * D[o + 1] + 0.114 * D[o + 2]; }
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const i = y * W + x;
            let s = 0, s2 = 0, c = 0;
            for (let dy = -2; dy <= 2; dy += 2) {
              const yy = y + dy; if (yy < 0 || yy >= H) continue;
              for (let dx = -2; dx <= 2; dx += 2) {
                const xx = x + dx; if (xx < 0 || xx >= W) continue;
                const v = lum[yy * W + xx]; s += v; s2 += v * v; c++;
              }
            }
            const sd = Math.sqrt(Math.max(0, s2 / c - (s / c) * (s / c)));
            const t = Math.max(0, 1 - sd / 25);
            smoothW[i] = 0.02 + 0.98 * t * t;
          }
        }
      }
      // Tight plateau: the greedy tail adds hundreds of near-no-op splats that
      // cost ~120 bytes each for invisible gains.
      const fit = fitSplats(work, shadingSeed.data, {
        budget: opts.splatBudget || 300,
        weightMap: smoothW,
        plateauWindow: 40,
        plateauRelGain: 0.015,
      });
      if (fit.added > 0) {
        // Base lives in trace space, splats in work space; scale them in.
        const sW = traceImg.width, sH = traceImg.height, sScale = sW / W;
        const st = sScale !== 1 ? ` transform="scale(${sScale.toFixed(5)})"` : '';
        const { defs, body } = emitSplatsDeduped(fit.splats);
        const candSvg = `${innerSvg(shadingSvg)}<g id="splat"${st}><defs>${defs}</defs>${body}</g>`;
        const bg = averageColor(work);
        const composed = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sW} ${sH}"><rect width="${sW}" height="${sH}" fill="rgb(${bg.r},${bg.g},${bg.b})"/>${candSvg}</svg>`;
        const candSeed = renderSvgToRgba(composed, W, H).data;
        // splatForce: the caller runs this whole pipeline twice (with and
        // without splats) and keeps the better final render, so adopt here
        // unconditionally. The gated path stays for single-run callers.
        if (opts.splatForce || dssim(work.data, candSeed, W, H) < dssim(work.data, seedData, W, H) * 0.9) {
          baseSvg = candSvg;
          seedData = candSeed;
          chosenRmse = rmse(work.data, seedData, W, H);
          baseKind = 'shading+splats';
          baseW = sW; baseH = sH; refineScale = sScale;
          // Protect the splat cores from being re-faceted by the primitive
          // refiner: suppress refinement where accumulated splat coverage is
          // strong. Edges (weak coverage) stay refinable.
          const cover = new Float32Array(W * H);
          for (const e of fit.splats) {
            const spans = (e.splat || e).footprint(W, H);
            for (const sp of spans) {
              let k = sp.y * W + sp.x1;
              for (let x = sp.x1; x <= sp.x2; x++, k++) {
                const a = sp.w[x - sp.x1];
                cover[k] = 1 - (1 - cover[k]) * (1 - a);
              }
            }
          }
          if (!importance) { importance = new Float32Array(W * H); importance.fill(1); }
          for (let i = 0; i < W * H; i++) if (cover[i] > 0.35) importance[i] = 0;
        }
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
  // When the base already matches the image closely (clean flat art / a good
  // gradient fit), refinement only stamps polygon dents over crisp edges while
  // shaving imperceptible RMSE. Skip it — cleaner output, smaller file. The
  // threshold scales with the quality target: at high/max a "clean-ish" base
  // (a UI screenshot's icons and chrome) still deserves refinement.
  const cleanSkip = Math.min(0.013, 2 * (targetDssim ?? 0.0065));
  if (traceMetrics && traceMetrics.dssim < cleanSkip) effBudget = 0;

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
