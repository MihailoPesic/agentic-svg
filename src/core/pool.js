// A small, generic worker_threads pool for CPU-bound fan-out work.
//
// createPool() spins up N workers (default: one per core, capped) running
// pool-worker.js. Each worker registers named task handlers; the pool dispatches
// payloads to whichever worker is free and resolves a Promise with the result.
//
//   const pool = createPool();
//   const r = await pool.run('shape-eval', payload);   // any registered task
//   await pool.destroy();
//
// Design notes:
//  - Round-robin over idle workers; tasks queue when all are busy.
//  - Transferables (ArrayBuffers) are moved, not copied, when you pass a
//    `transfer` list — essential for shipping pixel buffers without cloning.
//  - Errors thrown in a handler reject the corresponding run() Promise.
//  - destroy() drains in-flight tasks (rejecting the queue) and terminates.

import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER_URL = new URL('./pool-worker.js', import.meta.url);

function defaultSize() {
  const cores = (availableParallelism ? availableParallelism() : 4);
  // Leave a core for the main thread / OS; never spin up fewer than 1.
  return Math.max(1, Math.min(cores - 1, 8));
}

/**
 * @param {number} [size]  worker count (default: cores-1, capped at 8)
 * @param {object} [opts]
 * @param {*} [opts.workerData]  passed to each worker's init (for one-time setup)
 * @returns {{ run: (task:string, payload:any, opts?:{transfer?:ArrayBuffer[]})=>Promise<any>,
 *            size:number, stats:()=>object, destroy:()=>Promise<void> }}
 */
export function createPool(size = defaultSize(), opts = {}) {
  size = Math.max(1, size | 0);
  let nextId = 1;
  let destroyed = false;

  // Per-worker bookkeeping: { worker, busy, inflight: Map<id,{resolve,reject}> }
  const workers = [];
  const queue = []; // { task, payload, transfer, resolve, reject }

  function spawn() {
    const worker = new Worker(fileURLToPath(WORKER_URL), {
      workerData: opts.workerData ?? null,
    });
    const slot = { worker, busy: false, inflight: new Map() };

    worker.on('message', (msg) => {
      const pending = slot.inflight.get(msg.id);
      if (!pending) return; // stale (worker errored) — already settled
      slot.inflight.delete(msg.id);
      slot.busy = false;
      if (msg.ok) pending.resolve(msg.result);
      else pending.reject(Object.assign(new Error(msg.error.message), { stack: msg.error.stack, code: msg.error.code }));
      pump();
    });

    worker.on('error', (err) => {
      // Fatal worker error: reject everything it was running, then replace it.
      for (const pending of slot.inflight.values()) pending.reject(err);
      slot.inflight.clear();
      const idx = workers.indexOf(slot);
      if (idx !== -1) workers.splice(idx, 1);
      if (!destroyed) { workers.push(spawn()); pump(); }
    });

    return slot;
  }

  for (let i = 0; i < size; i++) workers.push(spawn());

  function pump() {
    if (queue.length === 0) return;
    const slot = workers.find((w) => !w.busy);
    if (!slot) return;
    const job = queue.shift();
    const id = nextId++;
    slot.busy = true;
    slot.inflight.set(id, { resolve: job.resolve, reject: job.reject });
    slot.worker.postMessage(
      { id, task: job.task, payload: job.payload },
      job.transfer || [],
    );
    // Keep filling while idle workers remain.
    if (queue.length) pump();
  }

  function run(task, payload, runOpts = {}) {
    if (destroyed) return Promise.reject(new Error('pool destroyed'));
    return new Promise((resolve, reject) => {
      queue.push({ task, payload, transfer: runOpts.transfer, resolve, reject });
      pump();
    });
  }

  function stats() {
    let busy = 0, inflight = 0;
    for (const w of workers) { if (w.busy) busy++; inflight += w.inflight.size; }
    return { size: workers.length, busy, queued: queue.length, inflight };
  }

  async function destroy() {
    if (destroyed) return;
    destroyed = true;
    const err = new Error('pool destroyed');
    for (const job of queue.splice(0)) job.reject(err);
    for (const w of workers) {
      for (const pending of w.inflight.values()) pending.reject(err);
      w.inflight.clear();
    }
    await Promise.all(workers.map((w) => w.worker.terminate()));
    workers.length = 0;
  }

  return { run, size, stats, destroy };
}

/**
 * Map a list of payloads across the pool for one task, preserving input order.
 * Convenience wrapper; each payload becomes its own run().
 */
export function mapPool(pool, task, payloads, perItemOpts) {
  return Promise.all(payloads.map((p, i) => pool.run(task, p, perItemOpts ? perItemOpts(p, i) : undefined)));
}
