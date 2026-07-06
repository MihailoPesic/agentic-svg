// Lightweight image classifier: routes an image to the right strategy/budget.
// Cheap heuristics (color count, edge density, gradient smoothness) — no model.

import { loadImage } from './image.js';

/**
 * Text probe at 512px. The 128px thumbnail the main signals use blurs body
 * text into smooth gray, so documents route to flat/illustration and get their
 * ink deleted. Real text has a signature that survives at 512: one dominant
 * background luma, moderate ink coverage, and MANY glyph-sized connected ink
 * components. A grainy portrait has no dominant background; a logo or icon set
 * has few, large components.
 */
function probeText(img) {
  const { data, width: W, height: H } = img;
  const n = W * H;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  // Dominant background: mode of 16 luma buckets.
  const hist = new Float64Array(16);
  for (let i = 0; i < n; i++) hist[Math.min(15, lum[i] >> 4)]++;
  let bgBucket = 0;
  for (let b = 1; b < 16; b++) if (hist[b] > hist[bgBucket]) bgBucket = b;
  const bgFrac = (hist[bgBucket] + (hist[bgBucket - 1] || 0) + (hist[bgBucket + 1] || 0)) / n;
  const bgLuma = bgBucket * 16 + 8;

  // Ink mask: strong contrast against the background.
  const ink = new Uint8Array(n);
  let inkPx = 0;
  for (let i = 0; i < n; i++) if (Math.abs(lum[i] - bgLuma) > 45) { ink[i] = 1; inkPx++; }
  const inkFrac = inkPx / n;

  // Stroke-width proxy: per-pixel horizontal and vertical ink run lengths
  // (each run's length assigned to every pixel in it, two linear passes).
  // Thin ink = min(hRun, vRun) <= 3 at the 512px probe — map grid lines and
  // hairline borders count, solid shapes don't. These details are invisible to
  // the 128px signals, so this is the only place to catch them. thinShare is
  // relative to the IMAGE (thin coverage), not to total ink — big solid
  // regions (continents on an ocean) would otherwise drown the lines out.
  let thinInkFrac = 0;
  let thinShare = 0;
  if (inkPx > 0) {
    const hRun = new Uint16Array(n);
    for (let y = 0; y < H; y++) {
      let x = 0;
      const row = y * W;
      while (x < W) {
        if (!ink[row + x]) { x++; continue; }
        let x2 = x;
        while (x2 < W && ink[row + x2]) x2++;
        const len = Math.min(65535, x2 - x);
        for (let k = x; k < x2; k++) hRun[row + k] = len;
        x = x2;
      }
    }
    let thinPx = 0;
    for (let x = 0; x < W; x++) {
      let y = 0;
      while (y < H) {
        if (!ink[y * W + x]) { y++; continue; }
        let y2 = y;
        while (y2 < H && ink[y2 * W + x]) y2++;
        const len = y2 - y;
        for (let k = y; k < y2; k++) {
          if (Math.min(hRun[k * W + x], len) <= 3) thinPx++;
        }
        y = y2;
      }
    }
    thinInkFrac = thinPx / inkPx;
    thinShare = thinPx / n;
  }

  if (bgFrac < 0.4 || inkFrac < 0.01 || inkFrac > 0.45) {
    return { textish: false, bgFrac: +bgFrac.toFixed(3), inkFrac: +inkFrac.toFixed(3), glyphComps: 0, thinInkFrac: +thinInkFrac.toFixed(3), thinShare: +thinShare.toFixed(4) };
  }

  // Connected components of ink (4-neighbour flood via a stack); count the
  // glyph-sized ones. Sized for a 512px probe.
  const label = new Int32Array(n); // 0 = unvisited
  const stack = new Int32Array(n);
  let comps = 0, glyphComps = 0;
  const maxSide = Math.max(W, H) * 0.09; // a glyph/word chunk, not a shape
  for (let start = 0; start < n; start++) {
    if (!ink[start] || label[start]) continue;
    comps++;
    let top = 0;
    stack[top++] = start;
    label[start] = comps;
    let area = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    while (top > 0) {
      const p = stack[--top];
      area++;
      const px = p % W, py = (p / W) | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px > 0 && ink[p - 1] && !label[p - 1]) { label[p - 1] = comps; stack[top++] = p - 1; }
      if (px < W - 1 && ink[p + 1] && !label[p + 1]) { label[p + 1] = comps; stack[top++] = p + 1; }
      if (py > 0 && ink[p - W] && !label[p - W]) { label[p - W] = comps; stack[top++] = p - W; }
      if (py < H - 1 && ink[p + W] && !label[p + W]) { label[p + W] = comps; stack[top++] = p + W; }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (area >= 3 && area <= 2200 && w <= maxSide && h <= maxSide) glyphComps++;
  }
  const textish = glyphComps >= 45;
  return { textish, bgFrac: +bgFrac.toFixed(3), inkFrac: +inkFrac.toFixed(3), glyphComps, thinInkFrac: +thinInkFrac.toFixed(3), thinShare: +thinShare.toFixed(4) };
}

/**
 * @returns {{type:'flat'|'illustration'|'photo'|'text', colors:number, edgeDensity:number,
 *            smoothness:number, smoothShare:number, texture:number}}
 */
export async function analyze(input) {
  const img = await loadImage(input, { maxSize: 128 });
  const probe = probeText(await loadImage(input, { maxSize: 512 }));
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

  // Text/UI: either the 512px ink probe finds glyph-sized components on a
  // dominant background (documents, code, fine print — invisible at 128px), or
  // the edge-density band fires (UI screenshots). The band alone also matched
  // grainy grayscale photos, so it now requires the probe's dominant-background
  // signal too — a portrait has no flat background and stays out.
  const text = probe.textish
    || (edgeDensity >= 0.15 && edgeDensity < 0.42 && colors <= 200 && probe.bgFrac >= 0.4);

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
    bgFrac: probe.bgFrac,
    inkFrac: probe.inkFrac,
    glyphComps: probe.glyphComps,
    thinInkFrac: probe.thinInkFrac || 0,
    thinShare: probe.thinShare || 0,
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
    // Dense scans (thousands of glyph components) are documents: one paper
    // tone plus ink. The regular text preset traces every mottle of a noisy
    // scan into megabytes; the document preset collapses the paper instead.
    const isDocument = (analysis.glyphComps || 0) > 800;
    // UI screenshots carry non-text chrome (icons, images) that the tiny text
    // budget can't refine; unlock some budget at high/max. Documents keep the
    // tight cap — extra shapes only smear ink.
    const textBudget = isDocument ? 50 : quality === 'max' ? 200 : quality === 'high' ? 120 : 50;
    const textPlateau = isDocument || (quality !== 'high' && quality !== 'max') ? 0.02 : 0.012;
    return {
      strategy: 'trace-refine',
      tracePresetName: isDocument ? 'document' : 'text',
      isDocument,
      shape: 'rect',
      alpha: 0.9,
      saliency: false,
      ...q,
      // Upsample to ~2x before tracing so glyph edges resolve into clean curves.
      traceRes: isDocument ? Math.min(q.traceRes, 1200) : Math.max(q.traceRes, 1300),
      traceEnlarge: true,
      budget: Math.min(q.budget, textBudget),
      plateauRelGain: Math.max(q.plateauRelGain, textPlateau),
      ...overrides,
    };
  }

  // Photos: soft rotated-ellipse refinement over fine cells dissolves the
  // posterized banding instead of stamping flat polygon slabs, and a Gaussian
  // splat candidate competes to own the continuous shading.
  if (analysis.type === 'photo') {
    return {
      strategy: 'trace-refine',
      tracePresetName: 'poster',
      shape: 'rotatedellipse',
      alpha: quality === 'draft' || quality === 'balanced' ? 0.55 : 0.45,
      saliency: true,
      useSplats: true,
      splatBudget: Math.min(400, Math.round(q.budget * 1.2)),
      // Poster traces of photos are mostly 1-2px anti-alias slivers; ANY
      // snap/merge tolerance is a large relative distortion there (measured:
      // fitting costs mascot 0.0021 -> 0.0033 dssim at identical bytes).
      pathfitOpts: false,
      ...q,
      budget: Math.round(q.budget * 1.4),
      refineOpts: { maxAreaFrac: 0.04, block: 12, topK: 12, expand: 1.3 },
      ...overrides,
    };
  }

  // Fine lines (map grids, hairline borders) get erased by the flat preset's
  // speckle/layer settings, but no cheap signal separates them reliably —
  // faint lines hide below any ink-contrast threshold and photo texture fires
  // false positives. The fine preset competes as a full candidate run instead
  // (see the pipeline's candidate set) and wins empirically where it matters.
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
    pathfitOpts: { circleTol: 0.008, residualFloor: 0.3, lineTol: 0.35 },
    ...q,
    ...overrides,
  };
}
