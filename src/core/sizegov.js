// Size governor: keeps photographic base traces from ballooning into
// multi-megabyte SVGs. The megabytes come from the base trace — fine color
// layers (poster/flat) on big noisy images emit thousands of dense paths —
// while refinement only adds a bounded ~10-50KB on top. So the lever is the
// trace itself: a ladder of progressively coarser preset variants that the
// caller walks until the projected final file size fits the quality budget.

/**
 * Measured raw->post-svgo shrink factor for trace output (see
 * scripts/test-sizegov.js). Across poster-preset traces of painting.jpg,
 * photo-landscape.jpg, photo-signage.jpg and fixtures/orb.png (16 samples,
 * all four ladder rungs each) the pipeline's finalizeSvg pass (svgo,
 * multipass, floatPrecision 2) left 0.53-0.62 of the raw bytes, avg 0.57.
 * We use the pessimistic end so the governor never under-budgets.
 */
export const SVGO_FACTOR = 0.62;

/**
 * Per-quality byte budgets for the finished (post-svgo) file. `max` is
 * uncapped on purpose: the user asked for everything the tracer has.
 */
export const SIZE_BUDGETS = {
  // Calibrated to kill pathological outputs (a 1280px photo tracing to 2.5MB)
  // without forcing visible posterization: budgets tighter than ~1.2MB at
  // 'high' push photographic content 2-3 coarseness rungs down and it shows.
  draft: 300 * 1024,
  balanced: 800 * 1024,
  high: 1500 * 1024,
  max: Infinity,
};

/**
 * Build a ladder of progressively coarser variants of a trace preset.
 * Rung 0 is the original preset untouched. Each later rung doubles the
 * speckle filter (kills small noise regions), widens the color layer step
 * ~1.8x (fewer stacked layers), and drops color precision by one bit
 * (coarser palette quantization -> fewer distinct regions). traceRes is NOT
 * touched here — resolution stays the caller's decision, so edges/text keep
 * their crispness while region count falls.
 *
 * @param {object} preset  a TRACE_PRESETS entry (or compatible config)
 * @param {number} [rungCount=4]  total rungs including rung 0
 * @returns {object[]}  rungCount preset variants, rung 0 first
 */
export function chooseTraceLadder(preset, rungCount = 4) {
  const ladder = [{ ...preset }];
  for (let i = 1; i < rungCount; i++) {
    ladder.push({
      ...preset,
      filterSpeckle: Math.min(64, (preset.filterSpeckle || 4) * 2 ** i),
      layerDifference: Math.min(128, Math.round((preset.layerDifference || 16) * 1.8 ** i)),
      colorPrecision: Math.max(3, (preset.colorPrecision || 6) - i),
    });
  }
  return ladder;
}

/**
 * Estimate what an SVG string will weigh after the pipeline's svgo pass,
 * without actually running svgo (which costs ~seconds on megabyte traces).
 * @param {string} svgString
 * @returns {{ raw:number, estimatedFinal:number }} bytes
 */
export function estimateBytes(svgString) {
  const raw = Buffer.byteLength(svgString);
  return { raw, estimatedFinal: Math.round(raw * SVGO_FACTOR) };
}

/**
 * Convenience for the converge loop: does this trace fit the quality budget?
 * @param {string} svgString
 * @param {'draft'|'balanced'|'high'|'max'} quality
 */
export function fitsBudget(svgString, quality = 'balanced') {
  const cap = SIZE_BUDGETS[quality] ?? SIZE_BUDGETS.balanced;
  return estimateBytes(svgString).estimatedFinal <= cap;
}
