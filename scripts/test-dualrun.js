// Proof harness for src/core/dualrun.js.
//
// For each test image, builds the SAME opts pair the pipeline's dual-run uses
// (flat pass vs splat pass), then times:
//   serial   — two awaited converge() calls on the main thread
//   parallel — runConvergePair() (two worker threads)
// and checks the parallel results are real: non-empty svg, finalDssim within
// 25% of the serial run's, and progress events observed from BOTH runs.
//
//   node scripts/test-dualrun.js

import { converge } from '../src/core/converge.js';
import { runConvergePair } from '../src/core/dualrun.js';
import { analyze, planConversion } from '../src/core/classify.js';
import { TRACE_PRESETS } from '../src/core/trace.js';
import { SIZE_BUDGETS } from '../src/core/sizegov.js';

const IMAGES = ['testdata/photo-landscape.jpg', 'fixtures/orb.png'];
const QUALITY = 'balanced';

let failures = 0;
function check(ok, label) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
}

/** Mirror pipeline.js: analysis -> plan -> the common converge opts. */
async function buildOptsPair(input) {
  const analysis = await analyze(input);
  const plan = planConversion(analysis, QUALITY, {});
  const common = {
    strategy: plan.strategy,
    workRes: plan.workRes,
    traceRes: plan.traceRes,
    traceEnlarge: plan.traceEnlarge,
    maxBaseBytes: analysis.type === 'text' ? Infinity : (SIZE_BUDGETS[QUALITY] ?? Infinity),
    budget: plan.budget,
    shape: plan.shape,
    alpha: plan.alpha,
    targetDssim: plan.targetDssim,
    plateauRelGain: plan.plateauRelGain,
    refineOpts: plan.refineOpts,
    tracePreset: TRACE_PRESETS[plan.tracePresetName] || TRACE_PRESETS.flat,
    weightMap: null,
    saliency: plan.saliency,
  };
  const optsA = { ...common, useSplats: false };
  const optsB = {
    ...common,
    useSplats: true,
    splatForce: true,
    splatBudget: plan.splatBudget || Math.min(400, Math.round(plan.budget * 1.2)),
  };
  return { optsA, optsB, analysis };
}

function fmtS(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

const rows = [];

for (const image of IMAGES) {
  console.log(`\n=== ${image} ===`);
  const { optsA, optsB, analysis } = await buildOptsPair(image);
  console.log(`  type=${analysis.type} budget=${optsA.budget} workRes=${optsA.workRes}`);

  // --- serial: exactly what pipeline.js does today -------------------------
  const t0 = performance.now();
  const serialA = await converge(image, optsA);
  const serialB = await converge(image, optsB);
  const serialMs = performance.now() - t0;

  // --- parallel: runConvergePair -------------------------------------------
  const progressCount = { A: 0, B: 0 };
  const t1 = performance.now();
  const [parA, parB] = await runConvergePair(image, optsA, optsB, (info) => {
    if (info.run === 'A' || info.run === 'B') progressCount[info.run]++;
  });
  const parallelMs = performance.now() - t1;

  rows.push({ image, serialMs, parallelMs });

  // --- assertions -----------------------------------------------------------
  check(typeof parA.svg === 'string' && parA.svg.includes('<svg') && parA.svg.length > 100,
    `run A svg non-empty (${parA.svg.length} bytes)`);
  check(typeof parB.svg === 'string' && parB.svg.includes('<svg') && parB.svg.length > 100,
    `run B svg non-empty (${parB.svg.length} bytes)`);

  const sA = serialA.metrics.finalDssim, pA = parA.metrics.finalDssim;
  const sB = serialB.metrics.finalDssim, pB = parB.metrics.finalDssim;
  // Same opts, but the refiner samples randomly — allow 25% relative slack
  // (guarded by a small absolute floor for near-zero dssim).
  const near = (s, p) => Math.abs(p - s) <= Math.max(0.25 * Math.max(s, p), 0.002);
  check(Number.isFinite(pA) && near(sA, pA),
    `run A finalDssim within noise: serial=${sA.toFixed(5)} parallel=${pA.toFixed(5)}`);
  check(Number.isFinite(pB) && near(sB, pB),
    `run B finalDssim within noise: serial=${sB.toFixed(5)} parallel=${pB.toFixed(5)}`);

  check(progressCount.A > 0, `progress events from run A (${progressCount.A})`);
  check(progressCount.B > 0, `progress events from run B (${progressCount.B})`);
  check(Array.isArray(parA.history) && Array.isArray(parB.history),
    `history arrays present (A=${parA.history.length}, B=${parB.history.length})`);
}

// --- timing table -----------------------------------------------------------
console.log('\n=== wall-clock: serial (2x awaited converge) vs runConvergePair ===');
console.log('image'.padEnd(32) + 'serial'.padStart(10) + 'parallel'.padStart(10) + 'saving'.padStart(9));
for (const r of rows) {
  const saving = (1 - r.parallelMs / r.serialMs) * 100;
  console.log(
    r.image.padEnd(32)
    + fmtS(r.serialMs).padStart(10)
    + fmtS(r.parallelMs).padStart(10)
    + `${saving.toFixed(0)}%`.padStart(9),
  );
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
