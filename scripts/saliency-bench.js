// Does saliency weighting buy crisper SUBJECTS at equal shape budget?
// Compares converge() with saliency off vs on, measuring DSSIM separately in
// the subject region (center) and the background.
import { converge } from '../src/core/converge.js';
import { loadImage, toPng } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { computeSaliency } from '../src/core/saliency.js';
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const file = 'fixtures/orb.png';
const budget = 120, workRes = 320, shape = 'any';

const full = await loadImage(file);
const N = full.width;
// subject = central 47% box (the face)
const m = Math.round(N * 0.265), x0 = m, y0 = m, x1 = N - m, y1 = N - m;

function crop(img, W, x0, y0, x1, y1) {
  const cw = x1 - x0, ch = y1 - y0;
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const si = ((y + y0) * W + (x + x0)) * 4, di = (y * cw + x) * 4;
      out[di] = img[si]; out[di + 1] = img[si + 1]; out[di + 2] = img[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, w: cw, h: ch };
}

async function score(saliency) {
  const res = await converge(file, { strategy: 'trace-refine', budget, workRes, shape, saliency });
  const r = renderSvgToRgba(res.svg, full.width, full.height);
  const whole = dssim(full.data, r.data, full.width, full.height);
  const ct = crop(full.data, N, x0, y0, x1, y1), cr = crop(r.data, N, x0, y0, x1, y1);
  const subj = dssim(ct.data, cr.data, ct.w, ct.h);
  return { whole, subj, shapes: res.metrics.shapesTotal, svg: res.svg };
}

// Visualize the saliency map.
const work = await loadImage(file, { maxSize: workRes });
const sal = computeSaliency(work);
const salImg = new Uint8ClampedArray(work.width * work.height * 4);
for (let i = 0; i < sal.length; i++) { const v = Math.round(sal[i] * 255); salImg[i * 4] = v; salImg[i * 4 + 1] = v; salImg[i * 4 + 2] = v; salImg[i * 4 + 3] = 255; }
await sharp(Buffer.from(salImg.buffer), { raw: { width: work.width, height: work.height, channels: 4 } }).png().toFile('out/mascot_saliency.png');

const off = await score(false);
const on = await score(true);
console.log(`budget=${budget} workRes=${workRes}`);
console.log(`saliency OFF: whole DSSIM=${off.whole.toFixed(4)}  SUBJECT DSSIM=${off.subj.toFixed(4)}  shapes=${off.shapes}`);
console.log(`saliency ON : whole DSSIM=${on.whole.toFixed(4)}  SUBJECT DSSIM=${on.subj.toFixed(4)}  shapes=${on.shapes}`);
const subjGain = ((1 - on.subj / off.subj) * 100).toFixed(1);
console.log(`SUBJECT improvement with saliency: ${subjGain}%  (background trades off as expected)`);
writeFileSync('out/mascot_saliency_off.svg', off.svg);
writeFileSync('out/mascot_saliency_on.svg', on.svg);
console.log('wrote out/mascot_saliency.png (map), _off.svg, _on.svg');
