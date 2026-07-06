// Global tone matching: correct the overall color drift that refinement's
// low-alpha soft layers introduce (haze / washout / dullness — audit S4).
//
// We fit a per-channel LINEAR map from the rendered SVG to the target image
// (y = a*x + b), with a and b clamped tightly so the correction can only fix
// global drift — it can never restyle the image. The map is applied by
// rewriting every literal color in the SVG string (fill / stroke / stop-color),
// then gated: the corrected SVG is returned only if its render is actually
// closer (dssim) to the target than the original.

import { renderSvgToRgba } from './render.js';
import { dssim } from './metrics.js';

const GAIN_MIN = 0.8, GAIN_MAX = 1.25;
const BIAS_MIN = -25, BIAS_MAX = 25;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Fit per-channel y = a*x + b from `render` to `target` two ways:
 *  - ordinary least squares over all pixels
 *  - moment matching (match mean + std)
 * Returns both candidates, coefficients clamped to the safe window.
 */
function fitLinearMaps(render, target, n) {
  const lsq = { gain: [1, 1, 1], bias: [0, 0, 0], name: 'lsq' };
  const mom = { gain: [1, 1, 1], bias: [0, 0, 0], name: 'moments' };
  for (let ch = 0; ch < 3; ch++) {
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const x = render[i * 4 + ch], y = target[i * 4 + ch];
      sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y;
    }
    const mx = sx / n, my = sy / n;
    const varX = sxx / n - mx * mx;
    const varY = syy / n - my * my;
    const cov = sxy / n - mx * my;
    // least squares
    let aL = varX > 1e-6 ? cov / varX : 1;
    aL = clamp(aL, GAIN_MIN, GAIN_MAX);
    lsq.gain[ch] = aL;
    lsq.bias[ch] = clamp(my - aL * mx, BIAS_MIN, BIAS_MAX);
    // moment matching (std ratio, sign-positive)
    let aM = varX > 1e-6 && varY > 0 ? Math.sqrt(varY / varX) : 1;
    aM = clamp(aM, GAIN_MIN, GAIN_MAX);
    mom.gain[ch] = aM;
    mom.bias[ch] = clamp(my - aM * mx, BIAS_MIN, BIAS_MAX);
  }
  return [lsq, mom];
}

/** Parse a literal SVG color value into [r,g,b,extra] or null if not remappable. */
function parseColor(value) {
  const v = value.trim();
  if (!v || v === 'none' || v === 'transparent' || v === 'currentColor') return null;
  if (v.startsWith('url(')) return null;
  let m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(v);
  if (m) {
    const h = m[1];
    return {
      rgb: [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)],
      alphaHex: m[2] || null,
      fmt: 'hex',
    };
  }
  m = /^#([0-9a-fA-F]{3})$/.exec(v);
  if (m) {
    const h = m[1];
    return { rgb: [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)), alphaHex: null, fmt: 'hex' };
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(v);
  if (m) {
    return { rgb: [+m[1], +m[2], +m[3]], alpha: m[4] !== undefined ? m[4] : null, fmt: 'rgb' };
  }
  return null;
}

function emitColor(parsed, rgb) {
  const [r, g, b] = rgb.map((c) => clamp(Math.round(c), 0, 255));
  if (parsed.fmt === 'hex') {
    const hex = (c) => c.toString(16).padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}${parsed.alphaHex || ''}`;
  }
  return parsed.alpha != null ? `rgba(${r},${g},${b},${parsed.alpha})` : `rgb(${r},${g},${b})`;
}

/** Rewrite every literal fill / stroke / stop-color in the SVG string through the map. */
export function remapSvgColors(svg, gain, bias) {
  const mapRgb = (rgb) => rgb.map((c, ch) => gain[ch] * c + bias[ch]);
  // attribute form: fill="..." stroke="..." stop-color="..."
  let out = svg.replace(/\b(fill|stroke|stop-color)="([^"]*)"/g, (whole, attr, value) => {
    const p = parseColor(value);
    if (!p) return whole;
    return `${attr}="${emitColor(p, mapRgb(p.rgb))}"`;
  });
  // style-property form inside style="..." (svgo sometimes emits these)
  out = out.replace(/\b(fill|stroke|stop-color)\s*:\s*([^;"']+)/g, (whole, prop, value) => {
    const p = parseColor(value);
    if (!p) return whole;
    return `${prop}:${emitColor(p, mapRgb(p.rgb))}`;
  });
  return out;
}

/**
 * Fit and apply a global tone correction to `svg` so its render matches
 * `target` ({width,height,data} RGBA). Gated on dssim: if the correction
 * doesn't measurably improve the render, the original comes back untouched.
 *
 * @param {string} svg
 * @param {{width:number,height:number,data:Uint8ClampedArray}} target
 * @param {{minRelGain?:number}} [opts]  required relative dssim improvement (default 0.5%)
 * @returns {{svg:string, applied:boolean, gain:number[], bias:number[], dssimBefore:number, dssimAfter:number, method:string|null}}
 */
export function matchTone(svg, target, opts = {}) {
  const { minRelGain = 0.005 } = opts;
  const W = target.width, H = target.height;
  const identity = (before, after = before) => ({
    svg, applied: false, gain: [1, 1, 1], bias: [0, 0, 0],
    dssimBefore: before, dssimAfter: after, method: null,
  });

  let baseRender;
  try {
    baseRender = renderSvgToRgba(svg, W, H);
  } catch {
    return identity(NaN);
  }
  const before = dssim(target.data, baseRender.data, W, H);

  const candidates = fitLinearMaps(baseRender.data, target.data, W * H);

  let best = null;
  for (const cand of candidates) {
    // Skip a candidate that is (numerically) the identity — nothing to do.
    const drift = cand.gain.reduce((s, a, i) => s + Math.abs(a - 1) * 128 + Math.abs(cand.bias[i]), 0);
    if (drift < 1) continue;
    const candSvg = remapSvgColors(svg, cand.gain, cand.bias);
    if (candSvg === svg) continue;
    let after;
    try {
      after = dssim(target.data, renderSvgToRgba(candSvg, W, H).data, W, H);
    } catch {
      continue;
    }
    if (!best || after < best.after) best = { ...cand, svg: candSvg, after };
  }

  if (!best || !(best.after < before * (1 - minRelGain))) return identity(before);
  return {
    svg: best.svg, applied: true,
    gain: best.gain.map((v) => +v.toFixed(4)),
    bias: best.bias.map((v) => +v.toFixed(2)),
    dssimBefore: before, dssimAfter: best.after, method: best.name,
  };
}
