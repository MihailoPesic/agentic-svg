// Lightweight image classifier: routes an image to the right strategy/budget.
// Cheap heuristics (color count, edge density, gradient smoothness) — no model.

import { loadImage } from './image.js';

/**
 * @returns {{type:'flat'|'illustration'|'photo'|'text', colors:number, edgeDensity:number,
 *            smoothness:number, smoothShare:number, texture:number}}
 */
export async function analyze(input) {
  const img = await loadImage(input, { maxSize: 128 });
  const { data, width: W, height: H } = img;

  // Distinct colors quantized to 4 bits/channel (4096 buckets).
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    seen.add(k);
  }
  const colors = seen.size;

  // Edge density: fraction of pixels whose luma gradient exceeds a threshold.
  // Alongside it, bucket every pixel's gradient magnitude: ~zero (flat fill),
  // small-but-nonzero (smooth shading: skies, glows, soft light), or moderate
  // (texture). The shares separate gradient-heavy photographic images from
  // flat art with the same color count.
  let edges = 0, n = 0, gradSum = 0, smoothPx = 0, texturePx = 0;
  const luma = (o) => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const o = (y * W + x) * 4;
      const g = Math.abs(luma(o + 4) - luma(o - 4)) + Math.abs(luma(o + W * 4) - luma(o - W * 4));
      gradSum += g;
      if (g > 40) edges++;
      else if (g > 12) texturePx++;
      else if (g > 1.5) smoothPx++;
      n++;
    }
  }
  const edgeDensity = edges / n;
  const smoothness = 1 - Math.min(1, gradSum / n / 40); // high => lots of flat/smooth area
  const smoothShare = smoothPx / n;
  const texture = texturePx / n;

  // Text/UI lives in a band of edge density: high enough for lots of crisp
  // glyphs/borders, but below the saturation that pure noise or photos hit.
  // Bold-outlined art (stickers, comics) sits below the band; noise above it.
  // This keeps those out of the expensive upscale-trace path.
  const text = edgeDensity >= 0.15 && edgeDensity < 0.42 && colors <= 200;

  // Gradient-dominant photographic images: most of the frame is smooth shading
  // and there is real texture somewhere. Flat art fails the first test (its
  // fills have ~zero gradient), a pure synthetic gradient fails the second
  // (no texture at all) — both keep their cheaper routes. Without this these
  // images land in 'illustration' and the opaque flat-trace path posterizes
  // the shading into stepped rings.
  const gradientPhoto = smoothShare >= 0.5 && texture >= 0.04;

  let type;
  if (text) type = 'text';
  else if (gradientPhoto) type = 'photo';
  else if (colors <= 24 && edgeDensity < 0.18) type = 'flat';
  else if (colors <= 400 && edgeDensity < 0.32) type = 'illustration';
  else type = 'photo';

  return {
    type, colors,
    edgeDensity: +edgeDensity.toFixed(3),
    smoothness: +smoothness.toFixed(3),
    smoothShare: +smoothShare.toFixed(3),
    texture: +texture.toFixed(3),
  };
}

/**
 * Quality levels map to compute budget + early-stop targets (the slider).
 * traceRes is the resolution the base is traced at — kept high so text/edges
 * survive — and is independent of the (smaller) refine resolution.
 */
export const QUALITY = {
  draft:    { workRes: 256, traceRes: 700,  budget: 60,  targetDssim: 0.02,  plateauRelGain: 0.02 },
  balanced: { workRes: 320, traceRes: 1000, budget: 160, targetDssim: 0.006, plateauRelGain: 0.012 },
  high:     { workRes: 384, traceRes: 1400, budget: 320, targetDssim: 0.003, plateauRelGain: 0.006 },
  max:      { workRes: 448, traceRes: 2000, budget: 600, targetDssim: 0.0015, plateauRelGain: 0.003 },
};

/** Combine classification + quality into concrete converge() options. */
export function planConversion(analysis, quality = 'balanced', overrides = {}) {
  const q = { ...(QUALITY[quality] || QUALITY.balanced) };

  // Text/UI: the high-res trace carries the result. Refinement only smears
  // glyphs, so trace crisply and refine sparingly (small budget, early stop).
  if (analysis.type === 'text') {
    const tracePresetName = 'text';
    return {
      strategy: 'trace-refine',
      tracePresetName,
      shape: 'rect',
      alpha: 0.9,
      saliency: false,
      ...q,
      // Upsample to ~2x before tracing so glyph edges resolve into clean curves.
      traceRes: Math.max(q.traceRes, 1300),
      traceEnlarge: true,
      budget: Math.min(q.budget, 50),
      plateauRelGain: Math.max(q.plateauRelGain, 0.02),
      ...overrides,
    };
  }

  // Photos: soft rotated-ellipse refinement over fine cells dissolves the
  // posterized banding instead of stamping flat polygon slabs.
  if (analysis.type === 'photo') {
    return {
      strategy: 'trace-refine',
      tracePresetName: 'poster',
      shape: 'rotatedellipse',
      alpha: quality === 'draft' || quality === 'balanced' ? 0.55 : 0.45,
      saliency: true,
      ...q,
      budget: Math.round(q.budget * 1.4),
      refineOpts: { maxAreaFrac: 0.04, block: 12, topK: 12, expand: 1.3 },
      ...overrides,
    };
  }

  // trace-refine is the robust default; very busy photos benefit from finer trace.
  const tracePresetName = 'flat';
  // Photos/illustrations want softer correction alpha; flat art wants opaque.
  const alpha = analysis.type === 'flat' ? 0.92 : 0.8;
  const shape = 'any';
  // Saliency helps when there's a distinct subject to favor; for flat logos the
  // whole image matters equally, so leave it off there.
  const saliency = analysis.type !== 'flat';
  return {
    strategy: 'trace-refine',
    tracePresetName,
    shape,
    alpha,
    saliency,
    ...q,
    ...overrides,
  };
}
