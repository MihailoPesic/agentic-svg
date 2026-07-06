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
 * Run N independent converge() passes concurrently in worker threads.
 *
 * @param {string|Buffer} input       image path or bytes (shared by all runs)
 * @param {object[]} optsList         one converge options object per run
 * @param {(info)=>void} [onProgress] receives events from ALL runs, each
 *                                    tagged `run: 'A' | 'B' | 'C' | ...`
 * @param {string[]} [tags]           run tags; defaults to 'A','B','C',...
 * @returns {Promise<Array<{svg:string, metrics:object, history:Array}>>}
 */
export async function runConvergeMany(input, optsList, onProgress, tags) {
  const runTags = tags || optsList.map((_, i) => String.fromCharCode(65 + i));
  const spawned = [];
  try {
    for (let i = 0; i < optsList.length; i++) {
      spawned.push(spawnConverge(input, optsList[i], onProgress, runTags[i]));
    }
  } catch {
    // Could not create worker threads at all — serial inline fallback,
    // all-or-nothing (same rule the pair always had).
    await Promise.allSettled(spawned.map(terminateQuietly));
    const out = [];
    for (let i = 0; i < optsList.length; i++) {
      out.push(await runInline(input, optsList[i], onProgress, runTags[i]));
    }
    return out;
  }

  const settled = await Promise.allSettled(spawned.map((s) => s.result));
  if (settled.every((s) => s.status === 'fulfilled')) {
    return settled.map((s) => s.value);
  }

  // Something failed: make sure no thread keeps burning CPU.
  await Promise.allSettled(spawned.map(terminateQuietly));

  const reasons = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);
  const realError = reasons.find((r) => !(r && r.workerInfra));
  if (realError) throw realError; // converge failed — inline would fail too

  // Infra-only failure: redo the missing run(s) inline, keep what succeeded.
  const out = [];
  for (let i = 0; i < optsList.length; i++) {
    out.push(settled[i].status === 'fulfilled'
      ? settled[i].value
      : await runInline(input, optsList[i], onProgress, runTags[i]));
  }
  return out;
}

/**
 * Run two independent converge() passes concurrently in worker threads.
 * Kept as a thin wrapper over runConvergeMany for existing callers.
 *
 * @returns {Promise<[resA, resB]>}   each { svg, metrics, history }
 */
export async function runConvergePair(input, optsA, optsB, onProgress) {
  return runConvergeMany(input, [optsA, optsB], onProgress);
}
