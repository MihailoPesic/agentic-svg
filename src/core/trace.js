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
  // Coarse base for splat-shaded photos: few wide color layers give a stable
  // skeleton whose smooth-shading error is one-sided, so Gaussian splats can
  // own the shading. A fine poster trace averages shading correctly (zero-mean
  // banding residual) and no smooth splat can improve on it.
  shading: {
    colorMode: ColorMode.Color,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Polygon,
    filterSpeckle: 4,
    colorPrecision: 4,
    layerDifference: 48,
    cornerThreshold: 60,
    lengthThreshold: 4,
    maxIterations: 10,
    spliceThreshold: 45,
    pathPrecision: 2,
  },
  // Photos: low speckle + many fine color layers is what kills the posterized
  // banding. Polygon mode matches spline fidelity here at ~1/3 the file size.
  poster: {
    colorMode: ColorMode.Color,
    hierarchical: Hierarchical.Stacked,
    mode: PathSimplifyMode.Polygon,
    filterSpeckle: 4,
    colorPrecision: 8,
    layerDifference: 4,
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
