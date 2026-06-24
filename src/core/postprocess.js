// Standalone, fidelity-preserving SVG shrinkers. Everything here is meant to make
// the markup smaller/cleaner WITHOUT moving a pixel: coordinate rounding within a
// safe precision, redundant-attribute pruning, and a stronger svgo pass than the
// one finalizeSvg() runs in the pipeline. Nothing merges or reshapes geometry.

import { optimize } from 'svgo';

// Numbers inside path data and transforms: integer + fractional part, optional
// exponent, optional leading sign. We rewrite each match to fewer decimals.
const NUM_RE = /-?\d*\.\d+(?:e[-+]?\d+)?|-?\d+(?:e[-+]?\d+)?/gi;

/** Round a single numeric string to `decimals`, trimming trailing zeros and a
 *  leading zero on fractions (0.5 -> .5, -0.5 -> -.5). */
function trimNumber(str, decimals) {
  let n = Number(str);
  if (!Number.isFinite(n)) return str;
  let s = n.toFixed(decimals);
  // strip trailing zeros / dangling dot
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  // -0 -> 0
  if (s === '-0') s = '0';
  // drop leading zero in |value| < 1
  s = s.replace(/^(-?)0\./, '$1.');
  return s;
}

function roundNumbersIn(value, decimals) {
  return value.replace(NUM_RE, (m) => trimNumber(m, decimals));
}

const COORD_ATTRS = new Set([
  'd', 'points', 'transform', 'gradientTransform',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'width', 'height', 'offset', 'fx', 'fy', 'stroke-width', 'stroke-dashoffset',
]);

/**
 * Round all coordinate-bearing attributes to `decimals` decimal places. This is
 * the single biggest cheap win on optimizer output, where paths carry 5-6 noise
 * digits. `decimals` of 2 is visually lossless at typical raster sizes; 1 is
 * usually still safe for icons. Attributes not in COORD_ATTRS are left untouched
 * so we never disturb ids, colors, opacities expressed as words, etc.
 * @param {string} svg
 * @param {number} [decimals=2]
 */
export function roundPathCoords(svg, decimals = 2) {
  if (decimals < 0) decimals = 0;
  // attr="value" or attr='value'
  return svg.replace(/([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (full, name, _q, dq, sq) => {
    if (!COORD_ATTRS.has(name)) return full;
    const raw = dq !== undefined ? dq : sq;
    if (!/\d/.test(raw)) return full;
    const rounded = roundNumbersIn(raw, decimals);
    const quote = dq !== undefined ? '"' : "'";
    return `${name}=${quote}${rounded}${quote}`;
  });
}

/** Collapse runs of whitespace between tags and trim the XML/doctype noise. Cheap,
 *  fully reversible at render time. */
export function collapseWhitespace(svg) {
  return svg
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .replace(/<\?xml[^>]*\?>\s*/i, '')
    .replace(/<!DOCTYPE[^>]*>\s*/i, '')
    .trim();
}

/**
 * Stronger-than-pipeline svgo pass, still tuned for fidelity. The pipeline's
 * finalizeSvg keeps multipass + precision 2; here we additionally:
 *  - round coords ourselves first (svgo's path rounding is conservative),
 *  - allow a configurable precision (default 2),
 *  - keep cleanupIds off so base/refine layer ids survive,
 *  - never run geometry-altering plugins (mergePaths, convertShapeToPath off).
 * Returns the smaller of {svgo output, input}; never throws.
 * @param {string} svg
 * @param {object} [opts]
 * @param {number} [opts.precision=2]   decimal places for coords
 * @param {boolean} [opts.multipass=true]
 * @param {boolean} [opts.collapse=true]   pre-collapse whitespace
 */
export function optimizeSvg(svg, opts = {}) {
  const { precision = 2, multipass = true, collapse = true } = opts;
  let working = roundPathCoords(svg, precision);
  if (collapse) working = collapseWhitespace(working);

  try {
    const { data } = optimize(working, {
      multipass,
      floatPrecision: precision,
      plugins: [
        {
          name: 'preset-default',
          params: {
            overrides: {
              // keep ids: base/refine groups are referenced by the renderer/tests
              cleanupIds: false,
              // never reshape geometry or remap shapes -> can shift pixels
              mergePaths: false,
              convertShapeToPath: false,
              // viewBox is load-bearing for scaling; preset-default keeps it by
              // default (removeViewBox is disabled there), so nothing to override.
            },
          },
        },
        'removeDimensions', // prefer viewBox; width/height are redundant for scaling
      ],
    });
    // svgo can occasionally produce larger output on already-tight input; keep best
    return Buffer.byteLength(data) < Buffer.byteLength(working) ? data : working;
  } catch {
    return working; // a partial win (rounded coords) still beats failing
  }
}

/**
 * One-call convenience: round + svgo, returning both the result and a byte report.
 * @returns {{ svg:string, before:number, after:number, saved:number, ratio:number }}
 */
export function postprocess(svg, opts = {}) {
  const before = Buffer.byteLength(svg);
  const out = optimizeSvg(svg, opts);
  const after = Buffer.byteLength(out);
  return { svg: out, before, after, saved: before - after, ratio: after / before };
}
