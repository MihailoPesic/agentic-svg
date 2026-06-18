// Bench the converge loop: report trace-only vs trace+refine, honest full-res RMSE/DSSIM.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { converge } from '../src/core/converge.js';
import { loadImage } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { rmse, dssim } from '../src/core/metrics.js';

const file = process.argv[2] || 'fixtures/logo.png';
const strategy = process.argv[3] || 'trace-refine';
const budget = parseInt(process.argv[4] || '150', 10);
const shape = process.argv[5] || 'any';
const workRes = parseInt(process.argv[6] || '320', 10);
mkdirSync('out', { recursive: true });

const base = file.split(/[\\/]/).pop().replace(/\.\w+$/, '');
const t0 = performance.now();
const res = await converge(file, { strategy, budget, shape, workRes,
  onProgress: (p) => { if (p.i % 30 === 0) console.log(`  step ${p.i} added=${p.added} rmse=${p.score.toFixed(4)}`); } });
const t1 = performance.now();

const outSvg = `out/${base}_converge_${strategy}.svg`;
writeFileSync(outSvg, res.svg);

// Honest metric at full resolution.
const full = await loadImage(file);
const rendered = renderSvgToRgba(res.svg, full.width, full.height);
const trueRmse = rmse(full.data, rendered.data, full.width, full.height);
const trueDssim = dssim(full.data, rendered.data, full.width, full.height);

console.log(`\n${base}  strategy=${strategy} shape=${shape} workRes=${workRes}`);
if (res.metrics.trace) console.log(`  trace-only:   rmse=${res.metrics.trace.rmse.toFixed(4)} dssim=${res.metrics.trace.dssim.toFixed(4)}`);
console.log(`  after refine: rmse(work)=${res.metrics.finalRmse.toFixed(4)} dssim(work)=${res.metrics.finalDssim.toFixed(4)}`);
console.log(`  HONEST(full): rmse=${trueRmse.toFixed(4)} dssim=${trueDssim.toFixed(4)}`);
console.log(`  shapesAdded=${res.metrics.shapesAdded}  svgBytes=${Buffer.byteLength(res.svg)}  time=${((t1 - t0) / 1000).toFixed(1)}s`);
console.log(`  wrote ${outSvg}`);
