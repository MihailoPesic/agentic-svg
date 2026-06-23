// Microbenchmark for the conversion pipeline. Times convertImage() on a couple
// of fixtures at quality 'high' and reports wall-clock + ms/shape, so we can
// measure the effect of optimizer changes (e.g. offloading candidate evaluation
// to the worker pool) against a stable baseline.
//
//   node scripts/perf.js                 # default fixtures, quality 'high'
//   node scripts/perf.js scene orb logo  # pick fixtures by name or path
//   node scripts/perf.js --quality=max --runs=3
//
// Output is one row per fixture plus a totals line. ms/shape uses the number of
// refinement shapes actually committed (metrics.shapesTotal); the trace/gradient
// base is free, so this isolates the cost of the refine loop.

import { performance } from 'node:perf_hooks';
import { existsSync } from 'node:fs';
import { convertImage } from '../src/core/pipeline.js';

const args = process.argv.slice(2);
const flags = {};
const names = [];
for (const a of args) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (m) flags[m[1]] = m[2] ?? true;
  else names.push(a);
}

const quality = flags.quality || 'high';
const runs = Math.max(1, parseInt(flags.runs || '1', 10));
const fixtures = (names.length ? names : ['scene', 'orb']).map(resolveFixture);

function resolveFixture(n) {
  if (existsSync(n)) return n;
  const p = `fixtures/${n}.png`;
  if (existsSync(p)) return p;
  throw new Error(`fixture not found: ${n}`);
}

function fmtMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`; }
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

async function timeOne(file) {
  // Best-of-`runs` wall clock to damp JIT warmup / GC noise; metrics are taken
  // from the fastest run so ms/shape lines up with the reported wall time.
  let best = null;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    const res = await convertImage(file, { quality });
    const wall = performance.now() - t0;
    if (!best || wall < best.wall) best = { wall, res };
  }
  return best;
}

console.log(`pipeline perf  quality=${quality}  runs=${runs}  node=${process.version}\n`);
console.log(`${pad('fixture', 14)}${pad('wall', 10)}${pad('shapes', 8)}${pad('ms/shape', 10)}${pad('dssim', 9)}${pad('bytes', 8)}`);
console.log('-'.repeat(59));

let totalWall = 0, totalShapes = 0;
for (const file of fixtures) {
  const { wall, res } = await timeOne(file);
  const shapes = res.metrics.shapesTotal || 0;
  const msPerShape = shapes ? (wall / shapes) : 0;
  totalWall += wall; totalShapes += shapes;
  const name = file.split(/[\\/]/).pop();
  console.log(
    pad(name, 14) +
    pad(fmtMs(wall), 10) +
    pad(shapes, 8) +
    pad(shapes ? msPerShape.toFixed(2) : '-', 10) +
    pad((res.metrics.finalDssim ?? 0).toFixed(4), 9) +
    pad(res.metrics.finalBytes ?? '-', 8),
  );
}

console.log('-'.repeat(59));
console.log(
  pad('TOTAL', 14) +
  pad(fmtMs(totalWall), 10) +
  pad(totalShapes, 8) +
  pad(totalShapes ? (totalWall / totalShapes).toFixed(2) : '-', 10),
);
