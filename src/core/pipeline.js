// Single entrypoint: classify -> plan -> converge -> finalize (svgo).

import { optimize } from 'svgo';
import { analyze, planConversion } from './classify.js';
import { converge } from './converge.js';
import { TRACE_PRESETS } from './trace.js';

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

  const result = await converge(input, {
    strategy: plan.strategy,
    workRes: plan.workRes,
    traceRes: plan.traceRes,
    traceEnlarge: plan.traceEnlarge,
    budget: plan.budget,
    shape: plan.shape,
    alpha: plan.alpha,
    targetDssim: plan.targetDssim,
    plateauRelGain: plan.plateauRelGain,
    refineOpts: plan.refineOpts,
    tracePreset,
    weightMap,
    saliency: weightMap ? false : plan.saliency,
    onProgress,
  });

  let svg = result.svg;
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
