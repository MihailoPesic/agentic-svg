// Blur-shading base: a coarse VTracer trace (few wide color layers) melted
// into smooth diffusion-curve-style shading by one feGaussianBlur over the
// whole group. The banding between coarse layers becomes the gradient; bytes
// stay at coarse-trace level (~1/50 of a splat layer). This is a BASE — crisp
// content is re-added on top by the refinement/patch machinery.
//
// STATUS: kept as a measured experiment, not wired into the pipeline. The
// premise mostly fails: the shading preset produces near-flat fills rather
// than banded gradients, so there is nothing for the blur to melt — it only
// softens real edges, and the blurred base beat the unblurred trace on one
// of five fixtures (see scripts/test-blurshade.js for the numbers). The
// filter-region / alpha-ramp handling below is correct and reusable if a
// banded base ever materializes.
//
// Gotchas handled here:
// - filter region: default -10%..120% fades the group at its own bbox edge;
//   oversize to -20%..140% so blur reaches the canvas border at full opacity.
// - even with the big region the border pixels thin out: half the kernel
//   samples outside the traced area, so alpha drops to ~0.5 at edges and
//   ~0.25 at corners and the underlying background bleeds through. Blur runs
//   on premultiplied color, so the un-premultiplied edge color is already the
//   correct average of the covered pixels — an feComponentTransfer alpha ramp
//   (slope 8) restores full opacity without touching color. Measured: cuts
//   dssim 10-20% at every radius on every fixture.
// - a solid average-color rect UNDER the group still backstops the far
//   corners of the filter region where boosted alpha stays below 1.

import { vectorizeRaw } from '@neplex/vectorizer';
import { TRACE_PRESETS } from './trace.js';
import { averageColor } from './image.js';
import { renderSvgToRgba } from './render.js';
import { dssim } from './metrics.js';

/** Strip the outer <svg> wrapper, returning inner markup only. */
function stripOuter(svg) {
  const lt = svg.indexOf('<svg');
  if (lt < 0) return '';
  const gt = svg.indexOf('>', lt);
  const end = svg.lastIndexOf('</svg>');
  if (gt < 0 || end < 0 || end < gt) return '';
  return svg.slice(gt + 1, end).trim();
}

/**
 * Build the blur-shading base for a work-resolution image.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img RGBA, work res
 * @param {object} [opts]
 * @param {number[]} [opts.stdDevs]     blur radii (work-res px) to sweep; best by dssim wins
 * @param {object} [opts.tracePreset]   coarse region preset (default TRACE_PRESETS.shading)
 * @param {string} [opts.filterId='bs'] filter id, override to avoid collisions
 * @returns {Promise<{svg:string, inner:string, stdDev:number, dssim:number,
 *                    sweep:{stdDev:number,dssim:number}[], traceSvg:string}>}
 */
export async function buildBlurShade(img, opts = {}) {
  const { width: W, height: H, data } = img;
  const preset = opts.tracePreset || TRACE_PRESETS.shading;
  const id = opts.filterId || 'bs';

  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const traceSvg = await vectorizeRaw(buf, { width: W, height: H }, preset);
  const paths = stripOuter(traceSvg);
  const bg = averageColor(img);

  // Sweep is bottom-heavy: measured on the fixture suite, dssim rises
  // monotonically with radius (softened region edges cost more than melted
  // banding gains), so the useful range sits well below the intuitive
  // side/60 starting point.
  const side = Math.max(W, H);
  const stdDevs = (opts.stdDevs && opts.stdDevs.length)
    ? opts.stdDevs
    : [side / 240, side / 120, side / 60, side / 36].map((s) => Math.max(1, Math.round(s * 10) / 10));

  const compose = (S) => {
    const inner = `<rect width="${W}" height="${H}" fill="rgb(${bg.r},${bg.g},${bg.b})"/>`
      + `<defs><filter id="${id}" x="-20%" y="-20%" width="140%" height="140%">`
      + `<feGaussianBlur stdDeviation="${S}"/>`
      + '<feComponentTransfer><feFuncA type="linear" slope="8" intercept="0"/></feComponentTransfer>'
      + `</filter></defs>`
      + `<g filter="url(#${id})">${paths}</g>`;
    return { inner, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">${inner}</svg>` };
  };

  const sweep = [];
  let best = null;
  for (const S of stdDevs) {
    const cand = compose(S);
    let score;
    try {
      const r = renderSvgToRgba(cand.svg, W, H);
      score = dssim(data, r.data, W, H);
    } catch {
      score = Infinity;
    }
    sweep.push({ stdDev: S, dssim: score });
    if (!best || score < best.dssim) best = { ...cand, stdDev: S, dssim: score };
  }

  return { svg: best.svg, inner: best.inner, stdDev: best.stdDev, dssim: best.dssim, sweep, traceSvg };
}
