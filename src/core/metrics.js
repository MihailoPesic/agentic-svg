// Similarity metrics + error maps used to drive and evaluate convergence.

import ssimPkg from 'ssim.js';

const ssim = ssimPkg.ssim || ssimPkg;

/** Normalized RMSE over RGB, 0 (identical) .. 1. */
export function rmse(a, b, W, H) {
  let total = 0;
  const px = W * H;
  if (px === 0) return 0;
  for (let i = 0; i < px; i++) {
    const o = i * 4;
    const dr = a[o] - b[o], dg = a[o + 1] - b[o + 1], db = a[o + 2] - b[o + 2];
    total += dr * dr + dg * dg + db * db;
  }
  return Math.sqrt(total / (px * 3)) / 255;
}

/** DSSIM = (1 - MSSIM) / 2, 0 (identical) .. 1. Perceptual structural distance. */
export function dssim(a, b, W, H) {
  const imgA = { data: a, width: W, height: H };
  const imgB = { data: b, width: W, height: H };
  const { mssim } = ssim(imgA, imgB, { downsample: false, ssim: 'bezkrovny' });
  return (1 - mssim) / 2;
}

/**
 * Per-block error map. Divides the image into a grid of `block`-px cells and
 * sums per-pixel squared RGB error in each. Returns { cols, rows, block, cells }
 * where cells[r*cols+c] = { c, r, x, y, w, h, err, area }.
 */
export function errorMap(target, current, W, H, block = 16, weightMap = null) {
  const cols = Math.ceil(W / block);
  const rows = Math.ceil(H / block);
  const cells = new Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * block, y = r * block;
      const w = Math.min(block, W - x), h = Math.min(block, H - y);
      let err = 0;
      for (let yy = y; yy < y + h; yy++) {
        let idx = (yy * W + x) * 4;
        for (let xx = x; xx < x + w; xx++) {
          const dr = target[idx] - current[idx];
          const dg = target[idx + 1] - current[idx + 1];
          const db = target[idx + 2] - current[idx + 2];
          let e = dr * dr + dg * dg + db * db;
          if (weightMap) e *= weightMap[yy * W + xx];
          err += e;
          idx += 4;
        }
      }
      cells[r * cols + c] = { c, r, x, y, w, h, err, area: w * h };
    }
  }
  return { cols, rows, block, cells };
}

/** Return the top-K highest-error cells (optionally jittered for variety). */
export function topErrorCells(map, k = 1) {
  return [...map.cells].sort((a, b) => b.err - a.err).slice(0, k);
}
