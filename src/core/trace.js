// Base-trace path: VTracer (color region tracing) for flat / vector-like art.
// Produces a clean, layered SVG skeleton that the refinement loop builds on.

import { vectorize, ColorMode, Hierarchical, PathSimplifyMode } from '@neplex/vectorizer';

/** Sensible defaults; tuned per-image by the classifier later. */
export const TRACE_PRESETS = {
  // Flat illustration / logo: few colors, crisp splines, aggressive speckle filter.
  flat: {
    colorMode: ColorMode.Color,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Spline,
    filterSpeckle: 8,
    colorPrecision: 6,
    layerDifference: 16,
    cornerThreshold: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    pathPrecision: 2,
  },
  // Screenshots / UI / line art: crisp edges and text. High color precision,
  // minimal speckle filtering, tighter corners so glyph edges survive.
  text: {
    colorMode: ColorMode.Color,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Spline,
    filterSpeckle: 2,
    colorPrecision: 8,
    layerDifference: 8,
    cornerThreshold: 40,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    pathPrecision: 2,
  },
  // Posterized photo: more colors, finer gradient steps.
  poster: {
    colorMode: ColorMode.Color,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Spline,
    filterSpeckle: 10,
    colorPrecision: 7,
    layerDifference: 8,
    cornerThreshold: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    pathPrecision: 2,
  },
};

/**
 * Trace a raster buffer (PNG/JPEG bytes) to an SVG string.
 * @param {Buffer} buf  encoded image bytes
 * @param {object} [config]  a TRACE_PRESETS entry or full vectorizer Config
 */
export async function traceImage(buf, config = TRACE_PRESETS.flat) {
  return vectorize(buf, config);
}
