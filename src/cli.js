#!/usr/bin/env node
// SVGForge CLI: convert an image to SVG via the converge pipeline.
//   svgforge <input> [output.svg] [--quality balanced] [--no-optimize]
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { convertImage } from './core/pipeline.js';

function parseArgs(argv) {
  const args = { _: [], quality: 'balanced', optimize: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quality' || a === '-q') args.quality = argv[++i];
    else if (a === '--no-optimize') args.optimize = false;
    else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const input = args._[0];
if (!input) {
  console.error('usage: svgforge <input> [output.svg] [--quality draft|balanced|high|max] [--no-optimize]');
  process.exit(1);
}
const output = args._[1] || input.replace(/\.\w+$/, '') + '.svg';

const t0 = performance.now();
const res = await convertImage(input, {
  quality: args.quality,
  optimize: args.optimize,
  onProgress: (p) => {
    if (p.phase === 'analysis') process.stdout.write(`  detected ${p.analysis.type} (${p.analysis.colors} colors)…\n`);
    else if (p.phase === 'trace') process.stdout.write(`  base trace rmse=${p.rmse.toFixed(4)} — refining…\n`);
    else if (p.phase === 'refine') process.stdout.write(`\r  refining… shape ${p.i} (kept ${p.added}) rmse=${p.score.toFixed(4)}   `);
  },
});
const dt = ((performance.now() - t0) / 1000).toFixed(1);
process.stdout.write('\n');

writeFileSync(output, res.svg);
console.log(`\n${input} → ${output}`);
console.log(`  type=${res.analysis.type} colors=${res.analysis.colors} edges=${res.analysis.edgeDensity} quality=${args.quality}`);
if (res.metrics.trace) console.log(`  trace-only dssim=${res.metrics.trace.dssim.toFixed(4)} → converged dssim=${res.metrics.finalDssim.toFixed(4)}`);
const method = res.metrics.pickedCandidate && res.metrics.pickedCandidate !== res.metrics.base
  ? `${res.metrics.base} via ${res.metrics.pickedCandidate}` : (res.metrics.base || '-');
console.log(`  method=${method}  elements=${res.metrics.elements ?? res.metrics.shapesTotal}  size=${(res.metrics.finalBytes / 1024).toFixed(1)}KB (raw ${(res.metrics.rawBytes / 1024).toFixed(1)}KB)  time=${dt}s`);
