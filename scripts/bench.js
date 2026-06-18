// Quick benchmark: optimize a fixture and report RMSE convergence + the honest
// metric (render the produced SVG with resvg and compare to the full-res target).
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { loadImage } from '../src/core/image.js';
import { differenceFull } from '../src/core/raster.js';
import { Model, run } from '../src/core/optimizer.js';

const file = process.argv[2] || 'fixtures/logo.png';
const steps = parseInt(process.argv[3] || '120', 10);
const type = process.argv[4] || 'triangle';
const alpha = parseFloat(process.argv[5] || '1.0');
const workRes = parseInt(process.argv[6] || '200', 10);

mkdirSync('out', { recursive: true });

const work = await loadImage(file, { maxSize: workRes });
const full = await loadImage(file);
console.log(`target ${file}  work=${work.width}x${work.height}  full=${full.width}x${full.height}`);

const model = new Model(work);
const t0 = performance.now();
let last = 0;
await run(model, {
  type, alpha, steps,
  onStep: (i, score) => {
    if (i === 1 || i % 20 === 0 || i === steps) {
      console.log(`  step ${String(i).padStart(4)}  internalRMSE=${score.toFixed(5)}`);
    }
    last = score;
  },
});
const t1 = performance.now();

// Honest metric: render the SVG at full resolution and compare to full target.
const svg = model.toSVG({ scale: full.width / work.width });
const base = file.split(/[\\/]/).pop().replace(/\.\w+$/, '');
const outSvg = `out/${base}_${type}_${steps}.svg`;
writeFileSync(outSvg, svg);

const png = new Resvg(svg, { fitTo: { mode: 'width', value: full.width } }).render().asPng();
const { data: rdata } = await sharp(png).resize(full.width, full.height, { fit: 'fill' })
  .flatten({ background: '#ffffff' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const trueRmse = differenceFull(full.data, new Uint8ClampedArray(rdata), full.width, full.height);

const bytes = Buffer.byteLength(svg);
console.log(`\nshapes=${model.shapes.length}  time=${((t1 - t0) / 1000).toFixed(1)}s  ms/shape=${((t1 - t0) / steps).toFixed(0)}`);
console.log(`internalRMSE=${last.toFixed(5)}  trueRMSE(rendered)=${trueRmse.toFixed(5)}  svgBytes=${bytes}`);
console.log(`wrote ${outSvg}`);
