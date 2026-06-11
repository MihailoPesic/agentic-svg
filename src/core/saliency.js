// Cheap perceptual-importance (saliency) map — no ML model required.
//
// "What draws the eye" is NOT just edge density (that flags busy background
// clutter). It's REGION DISTINCTIVENESS (a region whose color stands out from
// the image as a whole) plus a mild CENTER prior. A smooth bright subject on a
// busy background has low local contrast but high global color distinctiveness,
// so this captures it where an edge-based map fails.
//
// Output: per-pixel weight in [floor, 1], used to bias error-targeted
// refinement toward what a human actually judges the result by.

/**
 * @param {{data:Uint8ClampedArray,width:number,height:number}} img
 * @param {object} [opts]
 * @param {number} [opts.floor=0.4]    minimum weight (background never fully ignored)
 * @param {number} [opts.center=0.45]  center-prior strength, 0..1
 * @returns {Float32Array} length W*H in [floor, 1]
 */
export function computeSaliency(img, { floor = 0.4, center = 0.45 } = {}) {
  const { data, width: W, height: H } = img;
  const n = W * H;

  // Downsample to a coarse grid for a robust, cheap region-color estimate.
  const gw = Math.max(8, Math.round(W / 12)), gh = Math.max(8, Math.round(H / 12));
  const gr = new Float32Array(gw * gh), gg = new Float32Array(gw * gh), gb = new Float32Array(gw * gh), gc = new Float32Array(gw * gh);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, (y * gh / H) | 0);
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, (x * gw / W) | 0);
      const o = (y * W + x) * 4, gi = gy * gw + gx;
      gr[gi] += data[o]; gg[gi] += data[o + 1]; gb[gi] += data[o + 2]; gc[gi]++;
    }
  }
  for (let i = 0; i < gr.length; i++) { if (gc[i]) { gr[i] /= gc[i]; gg[i] /= gc[i]; gb[i] /= gc[i]; } }

  // Region distinctiveness = mean color distance from all other regions
  // (weighted by their pixel area). This is a coarse global-contrast saliency.
  const gsal = new Float32Array(gw * gh);
  let gmax = 1e-6;
  for (let i = 0; i < gsal.length; i++) {
    let acc = 0, wsum = 0;
    for (let j = 0; j < gsal.length; j++) {
      if (i === j) continue;
      const dr = gr[i] - gr[j], dg = gg[i] - gg[j], db = gb[i] - gb[j];
      acc += Math.sqrt(dr * dr + dg * dg + db * db) * gc[j];
      wsum += gc[j];
    }
    gsal[i] = wsum ? acc / wsum : 0;
    if (gsal[i] > gmax) gmax = gsal[i];
  }
  for (let i = 0; i < gsal.length; i++) gsal[i] /= gmax; // 0..1

  // Upsample (bilinear) to full res, blend with center prior, lift into [floor,1].
  const cx = W / 2, cy = H / 2;
  const sigma2 = 2 * (Math.min(W, H) * 0.55) ** 2;
  const out = new Float32Array(n);
  for (let y = 0; y < H; y++) {
    const fy = (y * gh / H) - 0.5;
    const y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy))), y1 = Math.min(gh - 1, y0 + 1);
    const ty = fy - Math.floor(fy);
    for (let x = 0; x < W; x++) {
      const fx = (x * gw / W) - 0.5;
      const x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx))), x1 = Math.min(gw - 1, x0 + 1);
      const tx = fx - Math.floor(fx);
      const s00 = gsal[y0 * gw + x0], s10 = gsal[y0 * gw + x1], s01 = gsal[y1 * gw + x0], s11 = gsal[y1 * gw + x1];
      const distinct = (s00 * (1 - tx) + s10 * tx) * (1 - ty) + (s01 * (1 - tx) + s11 * tx) * ty;
      const dx = x - cx, dy = y - cy;
      const centerPrior = Math.exp(-(dx * dx + dy * dy) / sigma2);
      const s = distinct * (1 - center) + Math.max(distinct, 0.15) * centerPrior * center;
      out[y * W + x] = floor + (1 - floor) * Math.min(1, s);
    }
  }
  return out;
}
