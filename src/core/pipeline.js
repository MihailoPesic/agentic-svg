// Single entrypoint: classify -> plan -> converge -> finalize (svgo).

import { optimize } from 'svgo';
import { analyze, planConversion } from './classify.js';
import { converge } from './converge.js';
import { TRACE_PRESETS } from './trace.js';
import { SIZE_BUDGETS } from './sizegov.js';
import { runConvergeMany, runConvergeOne } from './dualrun.js';
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
    pathfitOpts: plan.pathfitOpts,
    tracePreset,
    weightMap,
    saliency: weightMap ? false : plan.saliency,
  };

  // Candidate set: some image classes are best served by 2-3 COMPLETE runs
  // (different presets / the Gaussian-splat pipeline), executed in parallel
  // worker threads, keeping the best finished render. Base-stage scores
  // mispredict finals (refinement compensates differently per base), so the
  // only honest gate is the finished result. `bias` weights the comparison:
  // the splat run wins near-ties (continuous shading beats equal-scoring flat
  // fills, bias 1/1.07); alternate presets must win by >=3% (bias 1/0.97) so
  // fatter traces don't take noise-level wins. Candidate 0 is always the
  // primary route — live previews stream from it only, so the UI doesn't
  // flicker between different pipelines.
  const candidates = [{ name: plan.tracePresetName, opts: { ...common, useSplats: plan.useSplats, splatBudget: plan.splatBudget }, bias: 1 }];
  const richTier = quality === 'high' || quality === 'max';
  const smoothShare = analysis.smoothShare || 0;
  // Near-pure gradients (smoothShare >= 0.8) are owned by the whole-image
  // gradient base; a forced splat run there is slow wasted work.
  const splatEligible = plan.useSplats
    || (analysis.type === 'illustration' && smoothShare >= 0.3 && smoothShare < 0.8);
  if (splatEligible) {
    candidates[0].opts.useSplats = false;
    candidates.push({
      name: 'splats',
      opts: {
        ...common,
        useSplats: true,
        splatForce: true,
        splatBudget: plan.splatBudget || Math.min(400, Math.round(plan.budget * 1.2)),
      },
      bias: 1 / 1.07,
    });
  }
  if (richTier) {
    // Alternates run only at high/max: they buy the last few points of
    // fidelity at real wall-clock cost, which is exactly what those tiers are
    // for. Splat-eligible images skip the preset alternate entirely — measured
    // across the suite it never beat both the flat and splat runs.
    if ((analysis.type === 'flat' || analysis.type === 'illustration')
      && !splatEligible
      && (analysis.smoothShare || 0) < 0.5 // gradient-dominant images gain nothing from a fine trace, it just crawls
      && (plan.tracePresetName === 'flat' || plan.tracePresetName === 'fine')) {
      // The other of flat/fine: fine keeps AA gradation and thin strokes the
      // flat preset filters away (and vice versa saves bytes when fine loses).
      const other = plan.tracePresetName === 'fine' ? 'flat' : 'fine';
      candidates.push({ name: other, opts: { ...common, useSplats: false, tracePreset: TRACE_PRESETS[other] }, bias: 1 / 0.97 });
    }
    // Layered-quantization backend: median-cut K-color palette, one binary
    // VTracer pass per color, stacked area-descending. It owns screenshots and
    // fine line work (~10x lower error on those) at a byte premium, so it
    // competes as a candidate instead of routing outright — the transparency
    // floor below keeps it from taking wins a smaller run already nailed.
    const layered = {
      name: 'layered-48',
      opts: { ...common, useSplats: false, traceBackend: 'layered', layerK: 48, traceEnlarge: false, pathfitOpts: false },
      bias: 1 / 0.97,
    };
    if (analysis.type === 'text' && !plan.isDocument) {
      candidates.push(layered);
      if (quality === 'max') {
        // The 2x-enlarged trace wins on small glyphs but can lose on
        // screenshots with plenty of non-text chrome; at max a
        // native-resolution run competes too.
        candidates.push({ name: 'text-native', opts: { ...common, traceEnlarge: false }, bias: 1 / 0.97 });
      }
    } else if (analysis.type === 'illustration' && !splatEligible && smoothShare < 0.8
      && (analysis.texture || 0) < 0.25) {
      // smoothShare >= 0.8 is gradient-base territory — a layered run there is
      // banding at 50x the bytes, wasted wall-clock (same skip as the splat run).
      // The texture gate keeps paintings/photos that misroute to illustration
      // out: 48 binary traces of brushwork emit a multi-megabyte SVG that svgo
      // then chews on past the timeout, with no fine-line payoff (line-art
      // keepers measure <=0.14, paintings 0.38+).
      candidates.push(layered);
    }
  }

  const progressFiltered = onProgress
    ? (p) => { if (p.run !== 'A' && p.phase === 'refine') { const { svg, ...rest } = p; onProgress(rest); } else onProgress(p); }
    : null;
  let result;
  if (candidates.length === 1) {
    result = await runConvergeOne(input, candidates[0].opts, onProgress);
    result.metrics.pickedCandidate = candidates[0].name;
  } else {
    const results = await runConvergeMany(input, candidates.map((c) => c.opts), progressFiltered);
    // Pick on a shared higher-resolution re-render, not each run's work-res
    // score: work-res comparisons across different trace resolutions mispick
    // (an enlarged-trace run and a native-trace run measure different things).
    const pickRef = await loadImage(input, { maxSize: 768 });
    const scores = results.map((r) => {
      try {
        const rr = renderSvgToRgba(r.svg, pickRef.width, pickRef.height);
        return dssim(pickRef.data, rr.data, pickRef.width, pickRef.height);
      } catch {
        return r.metrics.finalDssim; // unrenderable candidate: fall back
      }
    });
    let best = 0;
    for (let i = 1; i < results.length; i++) {
      if (scores[i] * candidates[i].bias < scores[best] * candidates[best].bias) best = i;
    }
    // Near-tie byte tiebreak: a candidate that scores within the preference
    // margin AND is at least 3x smaller takes the win — a heavy splat/fine run
    // has to beat the margin to justify a 10x file, but modest byte savings
    // never override the smoothness preference.
    for (let i = 0; i < results.length; i++) {
      if (i === best) continue;
      if (scores[i] <= scores[best] * 1.07
        && Buffer.byteLength(results[i].svg) * 3 <= Buffer.byteLength(results[best].svg)) best = i;
    }
    // Transparency floor: below ~0.006 every candidate is visually
    // indistinguishable from the source, so a further dssim edge buys nothing
    // anyone can see — among those, a MATERIALLY smaller file (>=1.3x) wins.
    // The materiality bar stops sub-kilobyte savings from trading away score
    // for nothing; the real target is the layered backend's 4x byte premium
    // on flat art it doesn't need to own.
    if (scores[best] <= 0.006) {
      for (let i = 0; i < results.length; i++) {
        if (scores[i] <= 0.006
          && Buffer.byteLength(results[i].svg) * 1.3 <= Buffer.byteLength(results[best].svg)) best = i;
      }
    }
    result = results[best];
    result.metrics.pickedCandidate = candidates[best].name;
  }
  plan.candidates = candidates.map((c) => c.name);

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
