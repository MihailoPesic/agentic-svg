// Per-region text patching: find text INSIDE photos (signs, captions, poster
// lettering) and re-trace just those crops at high resolution so glyphs
// survive vectorization instead of dissolving into refinement blobs.
//
// Detection is a LOCAL version of the classifier's probeText idea. A global
// background bucket misses a sign — the sign is dark-on-light (or the reverse)
// within its own little area, not against the whole frame. So: per-tile
// dominant background, ink = strong local contrast, connected components,
// keep glyph-sized comps, cluster nearby glyphs into boxes, filter clusters
// that don't look like text runs (foliage/crowd speckle is the classic false
// positive).

import sharp from 'sharp';
import { traceImage, TRACE_PRESETS } from './trace.js';
import { fitPrimitives } from './pathfit.js';

const fmt = (n) => {
  const s = n.toFixed(2);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

/**
 * Detect probable text regions in an RGBA image.
 *
 * Runs a STRICT pass, then (unless opts.relaxed === false) a RELAXED second
 * pass tuned for LED/billboard signs: glowing gradient panels get a ~2.75x
 * looser background-flatness cap, and saturated colored letters on a bright
 * background count as ink even without extreme per-channel contrast. The
 * relaxed pass keeps the row-structure test STRICT (that is what separates
 * letter rows from crowds) but only needs 5 glyphs per cluster. Results are
 * merged with strict boxes winning any overlap; each region is tagged
 * `relaxed:true|false` so callers can log its provenance. False positives are
 * acceptable here because the pipeline render-gates every patch.
 *
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img
 *        typically a ~768px-wide load; returned boxes are in ITS coordinates.
 * @param {object} [opts]
 * @param {boolean} [opts.relaxed=true]  run the permissive LED/billboard pass
 * @param {number} [opts.tile=32]        local-background tile size in px
 * @param {number} [opts.inkThresh=45]   max per-channel |rgb - localBg| for a
 *                                       pixel to count as ink
 * @param {number} [opts.bgFracMin=0.5]  tile needs this share in one luma band
 *                                       to have a "background" at all (busy
 *                                       texture like foliage fails this)
 * @param {number} [opts.bgGradMax=8]    max mean luma gradient over INTERIOR
 *                                       background pixels — a real background
 *                                       is flat once glyph halos are excluded
 * @param {number} [opts.minGlyphs=6]    glyph components per cluster to keep it
 * @param {number} [opts.maxRegions=10]  cap (strict first, then glyph count)
 * @param {number} [opts.pad=4]          padding around each final box
 * @returns {Array<{x:number,y:number,w:number,h:number,glyphs:number,relaxed:boolean}>}
 */
export function detectTextRegions(img, opts = {}) {
  const { relaxed = true, maxRegions = 10 } = opts;
  const strict = detectPass(img, opts).map((b) => ({ ...b, relaxed: false }));
  if (!relaxed) return strict.slice(0, maxRegions);

  const loose = detectPass(img, {
    ...opts,
    bgGradMax: (opts.bgGradMax ?? 8) * 2.75,
    minGlyphs: 5,
    _satInk: true,
  });
  const out = [...strict];
  for (const b of loose) {
    // Dedupe against the strict pass: any overlap and the strict box wins.
    const hit = strict.some((s) =>
      b.x <= s.x + s.w - 1 && s.x <= b.x + b.w - 1 &&
      b.y <= s.y + s.h - 1 && s.y <= b.y + b.h - 1);
    if (!hit) out.push({ ...b, relaxed: true });
  }
  // Strict boxes outrank relaxed ones when the cap bites.
  out.sort((a, b) => (a.relaxed === b.relaxed ? b.glyphs - a.glyphs : a.relaxed ? 1 : -1));
  return out.slice(0, maxRegions);
}

function detectPass(img, opts = {}) {
  const { width: W, height: H, data } = img;
  const {
    tile = 32,
    inkThresh = 45,
    bgFracMin = 0.5,
    bgGradMax = 8,
    minGlyphs = 6,
    maxRegions = 10,
    pad = 4,
    _satInk = false,
  } = opts;
  const n = W * H;

  // Luma + local gradient (used to demand a SMOOTH tile background below).
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    lum[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  // Glow-ink (relaxed mode) only makes sense in a DARK scene: a lit sign at
  // night. In daylight the same "bright saturated pixel in a darker tile"
  // rule fires on moss, flowers and whitewater instead.
  let satInk = _satInk;
  if (satInk) {
    const sorted = Float32Array.from(lum).sort();
    if (sorted[n >> 1] > 65) satInk = false;
  }
  const grad = new Float32Array(n);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      grad[i] = Math.abs(lum[i + 1] - lum[i - 1]) + Math.abs(lum[i + W] - lum[i - W]);
    }
  }

  // Per-tile dominant background: mode of 32 luma buckets (±1 neighbours),
  // remembering the band's mean COLOR too. Tiles without a dominant band get
  // bg = -1 and contribute no ink; this is the first texture guard —
  // grass/crowds have no local background.
  const txN = Math.ceil(W / tile), tyN = Math.ceil(H / tile);
  const tileBg = new Float32Array(txN * tyN).fill(-1); // band mean luma
  const tileBgRgb = new Float32Array(txN * tyN * 3);
  const tileMean = new Float32Array(txN * tyN); // plain mean luma, all tiles
  const hist = new Float64Array(32);
  const sums = new Float64Array(32 * 4); // per bucket: luma, r, g, b
  for (let ty = 0; ty < tyN; ty++) {
    for (let tx = 0; tx < txN; tx++) {
      hist.fill(0); sums.fill(0);
      const x1 = Math.min(W, (tx + 1) * tile), y1 = Math.min(H, (ty + 1) * tile);
      let count = 0;
      for (let y = ty * tile; y < y1; y++) {
        for (let x = tx * tile; x < x1; x++) {
          const i = y * W + x, o = i * 4;
          const b = Math.min(31, lum[i] >> 3);
          hist[b]++;
          sums[b * 4] += lum[i];
          sums[b * 4 + 1] += data[o]; sums[b * 4 + 2] += data[o + 1]; sums[b * 4 + 3] += data[o + 2];
          count++;
        }
      }
      let lumSum = 0;
      for (let b = 0; b < 32; b++) lumSum += sums[b * 4];
      tileMean[ty * txN + tx] = lumSum / count;
      let mode = 0;
      for (let b = 1; b < 32; b++) if (hist[b] > hist[mode]) mode = b;
      const lo = Math.max(0, mode - 1), hi = Math.min(31, mode + 1);
      let bandN = 0, bandL = 0, bandR = 0, bandG = 0, bandB = 0;
      for (let b = lo; b <= hi; b++) {
        bandN += hist[b];
        bandL += sums[b * 4]; bandR += sums[b * 4 + 1]; bandG += sums[b * 4 + 2]; bandB += sums[b * 4 + 3];
      }
      if (bandN / count < bgFracMin) continue;
      // The band must also be genuinely FLAT. Foliage/crowds often have a
      // dominant dark band, but it is speckle interleaved with texture (high
      // local gradient); a sign panel, caption bar or sky is flat. Measure on
      // INTERIOR band pixels only (all 4 neighbours also in-band) so the
      // anti-alias halos rimming dense text don't disqualify a real page.
      let intN = 0, intGrad = 0;
      const inBand = (i) => { const b = Math.min(31, lum[i] >> 3); return b >= lo && b <= hi; };
      for (let y = Math.max(1, ty * tile); y < Math.min(H - 1, y1); y++) {
        for (let x = Math.max(1, tx * tile); x < Math.min(W - 1, x1); x++) {
          const i = y * W + x;
          if (!inBand(i) || !inBand(i - 1) || !inBand(i + 1) || !inBand(i - W) || !inBand(i + W)) continue;
          intN++; intGrad += grad[i];
        }
      }
      if (intN < count * 0.2 || intGrad / intN > bgGradMax) continue;
      const t = ty * txN + tx;
      tileBg[t] = bandL / bandN;
      tileBgRgb[t * 3] = bandR / bandN;
      tileBgRgb[t * 3 + 1] = bandG / bandN;
      tileBgRgb[t * 3 + 2] = bandB / bandN;
    }
  }

  // Ink mask. In tiles with a valid background: strong contrast against it in
  // ANY channel — luma alone misses colored sign lettering (white on yellow is
  // nearly iso-luminant but far apart in blue). In background-less (textured)
  // tiles: extreme-white pixels only, which is how caption text stamped over a
  // busy photo (meme lettering) still registers.
  const ink = new Uint8Array(n);
  for (let y = 0; y < H; y++) {
    const trow = ((y / tile) | 0) * txN;
    for (let x = 0; x < W; x++) {
      const i = y * W + x, o = i * 4;
      const t = trow + ((x / tile) | 0);
      if (tileBg[t] < 0) {
        if (lum[i] >= 240) ink[i] = 1;
        // Relaxed mode: glowing saturated lettering (yellow PALACE bulbs, red
        // McDonald's script) on a busy dark facade never gets a flat local
        // background, but it is bright AND vividly colored AND surrounded by
        // darkness — the tile-mean check kills daylight flowers and billboard
        // artwork, which are bright all over.
        else if (satInk && tileMean[t] <= 110) {
          const mx = Math.max(data[o], data[o + 1], data[o + 2]);
          const mn = Math.min(data[o], data[o + 1], data[o + 2]);
          if (mx >= 190 && mx - mn >= 90) ink[i] = 1;
        }
        continue;
      }
      const dr = Math.abs(data[o] - tileBgRgb[t * 3]);
      const dg = Math.abs(data[o + 1] - tileBgRgb[t * 3 + 1]);
      const db = Math.abs(data[o + 2] - tileBgRgb[t * 3 + 2]);
      if (Math.max(dr, dg, db) > inkThresh) { ink[i] = 1; continue; }
      // Relaxed (LED/billboard) mode: strongly saturated letters sitting on a
      // bright glowing panel — MOTOWN-red on white-hot backlight — can be
      // near the background in every channel-delta yet scream in saturation.
      if (satInk && tileBg[t] >= 140) {
        const mx = Math.max(data[o], data[o + 1], data[o + 2]);
        const mn = Math.min(data[o], data[o + 1], data[o + 2]);
        const bgMx = Math.max(tileBgRgb[t * 3], tileBgRgb[t * 3 + 1], tileBgRgb[t * 3 + 2]);
        const bgMn = Math.min(tileBgRgb[t * 3], tileBgRgb[t * 3 + 1], tileBgRgb[t * 3 + 2]);
        if (mx - mn >= 70 && (mx - mn) - (bgMx - bgMn) >= 40) ink[i] = 1;
      }
    }
  }

  // Connected components of ink (4-neighbour); keep the glyph-sized ones.
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  // Roomier than the classifier's 0.09: big caption letters carry thick
  // outlines that bridge neighbours, and dropping those kills whole words.
  const maxSide = Math.max(W, H) * 0.13;
  const maxArea = maxSide * maxSide * 0.6;
  const glyphs = [];
  let comps = 0;
  for (let start = 0; start < n; start++) {
    if (!ink[start] || label[start]) continue;
    comps++;
    let top = 0;
    stack[top++] = start;
    label[start] = comps;
    let area = 0, perim = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    while (top > 0) {
      const p = stack[--top];
      area++;
      const px = p % W, py = (p / W) | 0;
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (px === 0 || px === W - 1 || py === 0 || py === H - 1
        || !ink[p - 1] || !ink[p + 1] || !ink[p - W] || !ink[p + W]) perim++;
      if (px > 0 && ink[p - 1] && !label[p - 1]) { label[p - 1] = comps; stack[top++] = p - 1; }
      if (px < W - 1 && ink[p + 1] && !label[p + 1]) { label[p + 1] = comps; stack[top++] = p + 1; }
      if (py > 0 && ink[p - W] && !label[p - W]) { label[p - W] = comps; stack[top++] = p - W; }
      if (py < H - 1 && ink[p + W] && !label[p + W]) { label[p + W] = comps; stack[top++] = p + W; }
    }
    const w = maxX - minX + 1, h = maxY - minY + 1;
    if (area < 4 || area > maxArea || w > maxSide || h > maxSide) continue;
    if (area / (w * h) < 0.1) continue; // hairline diagonals / edge slivers
    glyphs.push({
      x0: minX, y0: minY, x1: maxX, y1: maxY, w, h, area,
      sw: (2 * area) / Math.max(1, perim), // ~mean stroke width
    });
  }
  if (glyphs.length < minGlyphs) return [];

  // Cluster glyphs: union-find, merging pairs whose box gaps are small
  // relative to glyph height (letters in a word/line sit ~one glyph apart).
  const g = glyphs.length;
  const parent = new Int32Array(g);
  for (let i = 0; i < g; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let a = 0; a < g; a++) {
    for (let b = a + 1; b < g; b++) {
      const A = glyphs[a], B = glyphs[b];
      // Relaxed mode inks far more non-letter clutter, and unconstrained
      // chaining welds every sign in a night scene into one frame-sized
      // cluster. Letters in one sign share a size; junk doesn't — so merge
      // only similar-height glyphs, and cap the merge gap in absolute pixels
      // so billboard-scale blobs can't bridge across the street.
      if (_satInk && Math.min(A.h, B.h) / Math.max(A.h, B.h) < 0.45) continue;
      const hRef = Math.max(3, (A.h + B.h) / 2);
      const gapX = Math.max(0, Math.max(B.x0 - A.x1, A.x0 - B.x1));
      const gapY = Math.max(0, Math.max(B.y0 - A.y1, A.y0 - B.y1));
      const capX = _satInk ? Math.min(1.6 * hRef, 16) : 1.6 * hRef;
      const capY = _satInk ? Math.min(0.9 * hRef, 8) : 0.9 * hRef;
      if (gapX < capX && gapY < capY) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[ra] = rb;
      }
    }
  }
  const clusters = new Map();
  for (let i = 0; i < g; i++) {
    const r = find(i);
    let c = clusters.get(r);
    if (!c) { c = { x0: W, y0: H, x1: 0, y1: 0, members: [] }; clusters.set(r, c); }
    const gl = glyphs[i];
    if (gl.x0 < c.x0) c.x0 = gl.x0; if (gl.y0 < c.y0) c.y0 = gl.y0;
    if (gl.x1 > c.x1) c.x1 = gl.x1; if (gl.y1 > c.y1) c.y1 = gl.y1;
    c.members.push(gl);
  }

  // Cluster filters: enough glyphs, text-like aspect, not the whole frame,
  // sane ink coverage (speckle fields are sparse, solid blocks aren't text),
  // and roughly uniform glyph heights (foliage blobs vary wildly).
  const dbg = opts._debug;
  const reject = (c, why) => { if (dbg) dbg.push({ x: c.x0, y: c.y0, x1: c.x1, y1: c.y1, m: c.members.length, why }); };
  let boxes = [];
  for (const c of clusters.values()) {
    const m = c.members.length;
    if (m < minGlyphs) continue;
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1;
    if (w < 6 || h < 6) continue;
    const aspect = w / h;
    if (aspect < 0.2 || aspect > 30) { reject(c, 'aspect'); continue; }
    if (h > 0.6 * H || w > 0.95 * W) { reject(c, 'frame'); continue; }      // don't swallow the frame
    if (w * h > 0.4 * W * H) { reject(c, 'area'); continue; }
    // Relaxed detections must stay SIGN-sized. A permissive ink rule can weld
    // half a night skyline into one cluster; a real marquee is a compact strip.
    if (_satInk && (h > 0.3 * H || w > 0.6 * W || w * h > 0.1 * W * H)) { reject(c, 'signsize'); continue; }
    let inkArea = 0, hSum = 0, h2Sum = 0, wSum = 0, w2Sum = 0, swSum = 0, hwSum = 0;
    for (const gl of c.members) {
      inkArea += gl.area; hSum += gl.h; h2Sum += gl.h * gl.h;
      wSum += gl.w; w2Sum += gl.w * gl.w;
      swSum += gl.sw; hwSum += gl.h / gl.w;
    }
    const cov = inkArea / (w * h);
    if (cov < 0.04 || cov > 0.8) { reject(c, 'cov=' + cov.toFixed(2)); continue; }
    const hMean = hSum / m;
    const hCv = Math.sqrt(Math.max(0, h2Sum / m - hMean * hMean)) / hMean;
    // Relaxed mode tolerates more size spread: marquee lettering mixes big
    // display glyphs with small sub-lines, and neighbouring sign clutter
    // merges in. The strict row-structure test below still stands guard.
    if (hCv > (_satInk ? 1.6 : 1.1)) { reject(c, 'hCv=' + hCv.toFixed(2)); continue; }
    // Width spread: letters (and short merged runs) have similar widths;
    // rocks-in-a-river or leaf blobs range from specks to boulders.
    const wMean = wSum / m;
    const wCv = Math.sqrt(Math.max(0, w2Sum / m - wMean * wMean)) / wMean;
    if (wCv > (_satInk ? 1.35 : 1.0)) { reject(c, 'wCv=' + wCv.toFixed(2)); continue; }
    // Tall-and-narrow glyphs in bulk are people/poles/fern fronds, not
    // letters. Small-font letters do run ~2.3 tall (i, l, t), so the cut
    // sits just above that.
    if (hwSum / m > 2.5) { reject(c, 'hw=' + (hwSum / m).toFixed(2)); continue; }
    // Glyphs are THIN: stroke width well under glyph height. Rocks, leaves and
    // crowd blobs are solid (stroke ~ half the height). Only meaningful once
    // glyphs are big enough to have discernible strokes — tiny far-away text
    // is nearly solid at this resolution and is exempt.
    if (hMean >= 12 && swSum / m / hMean > 0.42) { reject(c, 'sw=' + (swSum / m / hMean).toFixed(2)); continue; }
    // Row structure: text glyphs organize into rows that they mostly FILL.
    // Group members into rows by center-y; a member counts as "in a text row"
    // when its row has >= 3 glyphs whose widths cover >= 45% of the row span.
    // Random texture blobs (ferns, sky holes, crowd heads) scatter into
    // sparse rows and fail.
    const byCy = [...c.members].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1));
    let rowMembers = 0;
    let row = [byCy[0]];
    const flushRow = () => {
      if (row.length >= 3) {
        let x0 = Infinity, x1 = -Infinity, wsum = 0;
        for (const gl of row) { x0 = Math.min(x0, gl.x0); x1 = Math.max(x1, gl.x1); wsum += gl.w; }
        if (wsum / (x1 - x0 + 1) >= 0.45) rowMembers += row.length;
      }
    };
    for (let i = 1; i < m; i++) {
      const prev = row[row.length - 1], cur = byCy[i];
      if ((cur.y0 + cur.y1) / 2 - (prev.y0 + prev.y1) / 2 <= 0.7 * hMean) row.push(cur);
      else { flushRow(); row = [cur]; }
    }
    flushRow();
    if (rowMembers / m < 0.5) { reject(c, 'rows=' + (rowMembers / m).toFixed(2)); continue; }
    // Row alignment: a glyph should have a horizontal neighbour at roughly the
    // same baseline. Random texture blobs rarely line up.
    let aligned = 0;
    for (let i = 0; i < m; i++) {
      const A = c.members[i];
      const cyA = (A.y0 + A.y1) / 2;
      for (let j = 0; j < m; j++) {
        if (j === i) continue;
        const B = c.members[j];
        const hRef = Math.max(A.h, B.h);
        const gapX = Math.max(0, Math.max(B.x0 - A.x1, A.x0 - B.x1));
        if (Math.abs(cyA - (B.y0 + B.y1) / 2) < 0.6 * hRef && gapX < 2.5 * hRef) { aligned++; break; }
      }
    }
    if (aligned / m < 0.55) { reject(c, 'align=' + (aligned / m).toFixed(2)); continue; }
    boxes.push({
      x: Math.max(0, c.x0 - pad),
      y: Math.max(0, c.y0 - pad),
      x1: Math.min(W - 1, c.x1 + pad),
      y1: Math.min(H - 1, c.y1 + pad),
      glyphs: m,
    });
  }

  // Merge overlapping boxes until stable.
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A.x <= B.x1 && B.x <= A.x1 && A.y <= B.y1 && B.y <= A.y1) {
          A.x = Math.min(A.x, B.x); A.y = Math.min(A.y, B.y);
          A.x1 = Math.max(A.x1, B.x1); A.y1 = Math.max(A.y1, B.y1);
          A.glyphs += B.glyphs;
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  boxes.sort((a, b) => b.glyphs - a.glyphs);
  return boxes.slice(0, maxRegions).map((b) => ({
    x: b.x, y: b.y, w: b.x1 - b.x + 1, h: b.y1 - b.y + 1, glyphs: b.glyphs,
  }));
}

/**
 * Build SVG patch fragments for detected text regions: crop the ORIGINAL
 * full-res image, upscale, trace with the text preset, and wrap each result
 * in a clipped, transformed <g> ready to composite over an existing output.
 *
 * COORDINATE SPACE: `patchSvgInner` lives in a space `targetW` units wide
 * (height proportional) with origin at the top-left of the image — i.e. the
 * viewBox space of the SVG you intend to insert it into. Insert the returned
 * string just before `</svg>` of that SVG. Regions must be in the coordinates
 * of an image `regionSpaceWidth` px wide (the image detectTextRegions saw).
 *
 * @param {string|Buffer} input  the original image (path or bytes)
 * @param {Array<{x,y,w,h,glyphs}>} regions  from detectTextRegions
 * @param {object} opts
 * @param {number} opts.regionSpaceWidth  width of the detection image
 * @param {number} opts.targetW           viewBox width of the destination SVG
 * @param {number} [opts.upscale=2]       crop upsample factor before tracing
 * @param {number} [opts.maxTraceWidth=1600]  cap on upscaled crop width
 * @param {number} [opts.maxPatchBytes=150000]  skip a region whose trace blows
 *        past this — text on a sign traces to a few KB; a photo-textured crop
 *        (false positive or busy backdrop) explodes, and skipping it is both a
 *        size guard and a second-chance texture filter
 * @param {object} [opts.preset=TRACE_PRESETS.text]
 * @returns {Promise<{patchSvgInner:string, boxes:Array<{x,y,w,h,glyphs}>,
 *          patches:Array<{svg:string, box:{x,y,w,h,glyphs}}>}>}
 *          boxes/patch boxes are the patched rects in TARGET space;
 *          patchSvgInner is all patches concatenated, while `patches` carries
 *          each region's fragment separately so a caller can composite and
 *          keep only the ones that measurably improve the render.
 */
export async function buildTextPatches(input, regions, opts) {
  const {
    regionSpaceWidth,
    targetW,
    upscale = 2,
    maxTraceWidth = 1600,
    maxPatchBytes = 150000,
    preset = TRACE_PRESETS.text,
  } = opts;
  if (!regionSpaceWidth || !targetW) throw new Error('buildTextPatches: regionSpaceWidth and targetW are required');

  const meta = await sharp(input).metadata();
  const W0 = meta.width, H0 = meta.height;
  const toFull = W0 / regionSpaceWidth;   // region space -> original pixels
  const toTarget = targetW / W0;          // original pixels -> target space

  let inner = '';
  const boxes = [];
  const patches = [];
  let idx = 0;
  for (const r of regions) {
    // Snap the crop to whole original pixels, then derive the target-space box
    // from the ACTUAL crop rect so the patch lands exactly on its content.
    const x0 = Math.max(0, Math.floor(r.x * toFull));
    const y0 = Math.max(0, Math.floor(r.y * toFull));
    const w0 = Math.min(W0 - x0, Math.ceil(r.w * toFull));
    const h0 = Math.min(H0 - y0, Math.ceil(r.h * toFull));
    if (w0 < 8 || h0 < 8) continue;

    const cropW = Math.min(maxTraceWidth, Math.round(w0 * upscale));
    const buf = await sharp(input)
      .extract({ left: x0, top: y0, width: w0, height: h0 })
      .resize({ width: cropW, kernel: 'cubic' })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();

    let svg;
    try {
      svg = fitPrimitives(await traceImage(buf, preset));
    } catch {
      continue; // a failed crop trace never kills the whole patch set
    }
    const m = svg.match(/<svg[^>]*>([\s\S]*)<\/svg>\s*$/);
    if (!m || !m[1].trim()) continue;
    if (Buffer.byteLength(m[1]) > maxPatchBytes) continue;

    const xT = x0 * toTarget, yT = y0 * toTarget;
    const wT = w0 * toTarget, hT = h0 * toTarget;
    const s = wT / cropW; // 2x-crop pixels -> target units
    const id = `tp${idx++}`;
    // The clip must live on an OUTER group: an element's own transform also
    // remaps its clip-path coordinates, which would drag the target-space
    // rect into crop space and clip the whole patch away.
    const frag =
      `<clipPath id="${id}c"><rect x="${fmt(xT)}" y="${fmt(yT)}" width="${fmt(wT)}" height="${fmt(hT)}"/></clipPath>` +
      `<g clip-path="url(#${id}c)"><g transform="translate(${fmt(xT)} ${fmt(yT)}) scale(${s.toFixed(6)})">${m[1]}</g></g>`;
    inner += frag;
    const box = { x: xT, y: yT, w: wT, h: hT, glyphs: r.glyphs };
    boxes.push(box);
    patches.push({ svg: frag, box });
  }

  return { patchSvgInner: inner ? `<g id="textpatches">${inner}</g>` : '', boxes, patches };
}
