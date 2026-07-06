// Single entrypoint: classify -> plan -> converge -> finalize (svgo).

import { optimize } from 'svgo';
import { analyze, planConversion } from './classify.js';
import { converge } from './converge.js';
import { TRACE_PRESETS } from './trace.js';
import { SIZE_BUDGETS } from './sizegov.js';
import { runConvergePair, runConvergeOne } from './dualrun.js';
import { matchTone } from './tonematch.js';
import { detectTextRegions, buildTextPatches } from './textregions.js';
import { loadImage } from './image.js';
import { renderSvgToRgba } from './render.js';
import { dssim } from './metrics.js';

/**
 * @param {string|Buffer} input
 * @param {object} [opts]
 * @param {'draft'|'balanced'|'high'|'max'} [opts.quality='balanced']
 * @param {boolean} [opts.optimize=true]   run svgo cleanup
 * @param {Float32Array} [opts.weightMap]  saliency importance map
 * @param {object} [opts.overrides]        converge() option overrides
 * @param {Function} [opts.onProgress]
 */
export async function convertImage(input, opts = {}) {
  const { quality = 'balanced', optimize: doOptimize = true, weightMap = null, overrides = {}, onProgress } = opts;

  const analysis = await analyze(input);
  const plan = planConversion(analysis, quality, overrides);
  const tracePreset = TRACE_PRESETS[plan.tracePresetName] || TRACE_PRESETS.flat;
  if (onProgress) onProgress({ phase: 'analysis', analysis, plan: { quality, ...plan } });

  const common = {
    strategy: plan.strategy,
    workRes: plan.workRes,
    traceRes: plan.traceRes,
    traceEnlarge: plan.traceEnlarge,
    // Byte budget for the base trace. Text/document routes have their own
    // collapse logic and small text must never be coarsened away.
    maxBaseBytes: analysis.type === 'text' ? Infinity : (SIZE_BUDGETS[quality] ?? Infinity),
    budget: plan.budget,
    shape: plan.shape,
    alpha: plan.alpha,
    targetDssim: plan.targetDssim,
    plateauRelGain: plan.plateauRelGain,
    refineOpts: plan.refineOpts,
    tracePreset,
    weightMap,
    saliency: weightMap ? false : plan.saliency,
  };

  // Shading-heavy images get two full runs — flat-fill pipeline vs Gaussian
  // splat pipeline — and we keep the better final render. Base-stage scores
  // mispredict the final (refinement compensates differently on each base),
  // so the only honest gate is the finished result. On a near-tie the splat
  // run wins: continuous shading beats equal-scoring flat fills. The two runs
  // are independent and CPU-bound, so they execute in parallel worker threads
  // (~33% wall-clock saved); live previews stream from the flat run only so
  // the UI doesn't flicker between two different pipelines.
  const progressA = onProgress
    ? (p) => { if (p.run === 'B' && p.phase === 'refine') { const { svg, ...rest } = p; onProgress(rest); } else onProgress(p); }
    : null;
  const splatEligible = plan.useSplats
    || (analysis.type === 'illustration' && (analysis.smoothShare || 0) >= 0.3);
  let result;
  if (splatEligible) {
    const [flat, splat] = await runConvergePair(
      input,
      { ...common, useSplats: false },
      {
        ...common,
        useSplats: true,
        splatForce: true,
        splatBudget: plan.splatBudget || Math.min(400, Math.round(plan.budget * 1.2)),
      },
      progressA,
    );
    result = splat.metrics.finalDssim < flat.metrics.finalDssim * 1.07 ? splat : flat;
  } else {
    result = await runConvergeOne(
      input,
      { ...common, useSplats: plan.useSplats, splatBudget: plan.splatBudget },
      onProgress,
    );
  }

  // Text patches: photos/illustrations with sign/caption text get each text
  // region re-traced from the full-res original (text preset, 2x) and
  // composited on top. Every patch is gated: it stays only if the render
  // inside its own box actually gets closer to the source. Text/document
  // routes skip this — they already trace at high resolution.
  let svgOut = result.svg;
  if (analysis.type === 'photo' || analysis.type === 'illustration') {
    try {
      const det = await loadImage(input, { maxSize: 768 });
      const regions = detectTextRegions(det);
      const vb = svgOut.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/);
      if (regions.length && vb) {
        const vbW = +vb[1];
        const { patches } = await buildTextPatches(input, regions, { regionSpaceWidth: det.width, targetW: vbW });
        if (patches.length) {
          const src = await loadImage(input, { maxSize: 512 });
          const scale = src.width / vbW;
          const baseR = renderSvgToRgba(svgOut, src.width, src.height);
          const boxDssim = (data, b) => {
            const x0 = Math.max(0, Math.floor(b.x * scale)), y0 = Math.max(0, Math.floor(b.y * scale));
            const x1 = Math.min(src.width, Math.ceil((b.x + b.w) * scale)), y1 = Math.min(src.height, Math.ceil((b.y + b.h) * scale));
            const w = x1 - x0, h = y1 - y0;
            if (w < 12 || h < 12) return null;
            const crop = (d) => {
              const o = new Uint8ClampedArray(w * h * 4);
              for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                  const si = ((y + y0) * src.width + (x + x0)) * 4, di = (y * w + x) * 4;
                  o[di] = d[si]; o[di + 1] = d[si + 1]; o[di + 2] = d[si + 2]; o[di + 3] = 255;
                }
              }
              return o;
            };
            return dssim(crop(src.data), crop(data), w, h);
          };
          const kept = [];
          for (const p of patches) {
            const before = boxDssim(baseR.data, p.box);
            if (before == null) continue;
            const candR = renderSvgToRgba(svgOut.replace('</svg>', p.svg + '</svg>'), src.width, src.height);
            const after = boxDssim(candR.data, p.box);
            if (after != null && after < before * 0.97) kept.push(p.svg);
          }
          if (kept.length) svgOut = svgOut.replace('</svg>', `<g id="textpatches">${kept.join('')}</g></svg>`);
        }
      }
    } catch {
      // patching must never break a conversion
    }
  }

  // Tone match: soft translucent refinement layers can wash global contrast
  // out (haze). Fit a tightly-clamped per-channel linear map render->source
  // and bake it into the emitted colors; gated inside matchTone — applied only
  // when the corrected render scores closer.
  if (analysis.type === 'photo' || analysis.type === 'illustration') {
    try {
      const toneRef = await loadImage(input, { maxSize: 768 });
      const tm = matchTone(svgOut, toneRef);
      if (tm.applied) svgOut = tm.svg;
    } catch {
      // tone matching must never break a conversion
    }
  }

  let svg = svgOut;
  let rawBytes = Buffer.byteLength(svg);
  if (doOptimize) svg = finalizeSvg(svg);

  // Honest element count: the whole emitted vector, base trace included — not
  // just the refinement primitives (which `shapesTotal` counts).
  const elements = (svg.match(/<(path|rect|circle|ellipse|polygon|line)\b/g) || []).length;

  return {
    svg,
    analysis,
    plan: { quality, ...plan, tracePresetName: plan.tracePresetName },
    metrics: { ...result.metrics, rawBytes, finalBytes: Buffer.byteLength(svg), elements },
    history: result.history,
  };
}

/** SVGO cleanup tuned to preserve visual fidelity (no path merging that shifts pixels). */
export function finalizeSvg(svg) {
  try {
    const { data } = optimize(svg, {
      multipass: true,
      floatPrecision: 2,
      plugins: [
        // preset-default keeps the viewBox by default; just stop it from
        // rewriting the ids we use to separate base/refine layers.
        { name: 'preset-default', params: { overrides: { cleanupIds: false } } },
      ],
    });
    return data;
  } catch {
    return svg; // never let cleanup break a valid result
  }
}
