// Parallel converge runner.
//
// The pipeline's dual-run (flat-fill pass vs Gaussian-splat pass on
// shading-heavy images) used to await two full converge() calls back to back.
// The two passes share no state and are CPU-bound, so each gets its own
// worker thread and they run wall-clock-concurrently.
//
//   const [flat, splat] = await runConvergePair(input, optsA, optsB, onProgress);
//
// Results are { svg, metrics, history } — the shape the pipeline actually
// consumes. The live `model` / `work` fields of a converge() result never
// cross the thread boundary (class instances + pixel buffers).
//
// Progress events from both runs are piped to `onProgress`, tagged with
// `run: 'A' | 'B'` so the caller can tell them apart.
//
// Failure handling:
//  - converge() itself throwing inside a worker rejects with that error
//    (rerunning inline would just fail the same way).
//  - Worker *infrastructure* failure (thread can't spawn, dies without a
//    result) falls back to running converge() inline on this thread.
//  - When either run of a pair fails, the sibling worker is terminated.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { converge } from './converge.js';

const WORKER_URL = new URL('./converge-worker.js', import.meta.url);

/**
 * Split converge opts into a structured-cloneable payload + transfer list.
 * `onProgress` (a function) is dropped — progress flows over messages instead.
 * `weightMap` is copied into a fresh ArrayBuffer and transferred, so the
 * caller's Float32Array stays usable (and two workers never fight over one
 * buffer).
 */
function packOpts(opts = {}) {
  const { onProgress, weightMap, ...rest } = opts;
  const packed = { ...rest };
  const transfer = [];
  if (weightMap) {
    const copy = new Float32Array(weightMap);
    packed.weightMap = copy.buffer;
    transfer.push(copy.buffer);
  } else {
    packed.weightMap = null;
  }
  return { packed, transfer };
}

/** Tag + forward a progress event; a listener throwing must not kill the run. */
function emitProgress(onProgress, data, tag) {
  if (!onProgress) return;
  try {
    onProgress({ ...data, run: tag });
  } catch {
    // progress observers are best-effort
  }
}

/**
 * Spawn one converge worker. Returns { worker, result } where `result`
 * resolves with { svg, metrics, history }. Rejection reasons carry
 * `workerInfra: true` when the failure is thread plumbing rather than
 * converge() itself.
 */
function spawnConverge(input, opts, onProgress, tag) {
  const { packed, transfer } = packOpts(opts);
  const worker = new Worker(fileURLToPath(WORKER_URL), {
    workerData: { input, opts: packed },
    transferList: transfer,
  });

  const result = new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      fn(v);
    };

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'progress') {
        emitProgress(onProgress, msg.data, tag);
      } else if (msg.type === 'result') {
        settle(resolve, msg.data);
      } else if (msg.type === 'error') {
        const err = new Error(msg.error?.message || 'converge failed in worker');
        if (msg.error?.stack) err.stack = msg.error.stack;
        settle(reject, err); // converge threw: NOT infra — no inline retry
      }
    });

    worker.on('error', (err) => {
      settle(reject, Object.assign(err instanceof Error ? err : new Error(String(err)), { workerInfra: true }));
    });

    worker.on('exit', (code) => {
      // Normal completion posts a result first, so this settle() is a no-op
      // then. Reaching here unsettled means the thread died on us.
      settle(reject, Object.assign(
        new Error(`converge worker exited (code ${code}) without a result`),
        { workerInfra: true },
      ));
    });
  });

  return { worker, result };
}

/** Inline (same-thread) converge with the same result/progress contract. */
async function runInline(input, opts, onProgress, tag) {
  const res = await converge(input, {
    ...opts,
    weightMap: opts?.weightMap || null,
    onProgress: onProgress
      ? (info) => {
        if (!info) return;
        const { model, ...data } = info;
        emitProgress(onProgress, data, tag);
      }
      : null,
  });
  return { svg: res.svg, metrics: res.metrics, history: res.history };
}

async function terminateQuietly(spawned) {
  if (!spawned) return;
  try {
    await spawned.worker.terminate();
  } catch {
    // already dead — fine
  }
}

/**
 * Run one converge() in a worker thread.
 *
 * @param {string|Buffer} input       image path or bytes
 * @param {object} opts               converge options (onProgress ignored —
 *                                    use the third argument)
 * @param {(info)=>void} [onProgress] receives converge progress events with
 *                                    an added `run` tag
 * @param {string} [tag='A']
 * @returns {Promise<{svg:string, metrics:object, history:Array}>}
 */
export async function runConvergeOne(input, opts, onProgress, tag = 'A') {
  let spawned;
  try {
    spawned = spawnConverge(input, opts, onProgress, tag);
  } catch {
    // Worker creation failed outright (e.g. threads unavailable) — run inline.
    return runInline(input, opts, onProgress, tag);
  }
  try {
    return await spawned.result;
  } catch (err) {
    await terminateQuietly(spawned);
    if (err && err.workerInfra) return runInline(input, opts, onProgress, tag);
    throw err;
  }
}

/**
 * Run two independent converge() passes concurrently in worker threads.
 *
 * @param {string|Buffer} input       image path or bytes (shared by both runs)
 * @param {object} optsA              converge options for run A
 * @param {object} optsB              converge options for run B
 * @param {(info)=>void} [onProgress] receives events from BOTH runs, each
 *                                    tagged `run: 'A' | 'B'`
 * @returns {Promise<[resA, resB]>}   each { svg, metrics, history }
 */
export async function runConvergePair(input, optsA, optsB, onProgress) {
  let a = null;
  let b = null;
  try {
    a = spawnConverge(input, optsA, onProgress, 'A');
    b = spawnConverge(input, optsB, onProgress, 'B');
  } catch {
    // Could not create worker threads at all — serial inline fallback.
    await terminateQuietly(a);
    await terminateQuietly(b);
    const resA = await runInline(input, optsA, onProgress, 'A');
    const resB = await runInline(input, optsB, onProgress, 'B');
    return [resA, resB];
  }

  const settled = await Promise.allSettled([a.result, b.result]);
  if (settled[0].status === 'fulfilled' && settled[1].status === 'fulfilled') {
    return [settled[0].value, settled[1].value];
  }

  // Something failed: make sure neither thread keeps burning CPU.
  await Promise.allSettled([terminateQuietly(a), terminateQuietly(b)]);

  const reasons = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);
  const realError = reasons.find((r) => !(r && r.workerInfra));
  if (realError) throw realError; // converge failed — inline would fail too

  // Infra-only failure: redo the missing run(s) inline, keep what succeeded.
  const out = [];
  out[0] = settled[0].status === 'fulfilled'
    ? settled[0].value
    : await runInline(input, optsA, onProgress, 'A');
  out[1] = settled[1].status === 'fulfilled'
    ? settled[1].value
    : await runInline(input, optsB, onProgress, 'B');
  return out;
}
