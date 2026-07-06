// Worker entry for running a full converge() pass off the main thread.
//
// workerData = {
//   input: string (path) | Uint8Array (image bytes; Buffers arrive as Uint8Array
//          after structured clone),
//   opts:  plain-JSON converge options. `weightMap`, if present, is an
//          ArrayBuffer (transferred) and is rehydrated to a Float32Array here.
// }
//
// Messages posted to the parent:
//   { type: 'progress', data }  — converge onProgress events, serializable
//                                 fields only (the live `model` is stripped)
//   { type: 'result',   data }  — { svg, metrics, history }; the result's
//                                 `model` and `work` fields are NOT sent
//                                 (class instances / pixel buffers)
//   { type: 'error',    error } — converge itself threw ({ message, stack })

import { parentPort, workerData } from 'node:worker_threads';
import { converge } from './converge.js';

if (!parentPort) throw new Error('converge-worker.js must run as a worker_threads Worker');

/** Buffers cross the thread boundary as Uint8Array; sharp wants a Buffer. */
function rehydrateInput(input) {
  if (typeof input === 'string') return input;
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  throw new Error('converge-worker: unsupported input type (want path string or image bytes)');
}

// Only these onProgress fields cross back to the parent. Everything else on a
// progress event (notably `model`, a live class instance) is not cloneable or
// not needed.
const PROGRESS_FIELDS = ['phase', 'i', 'budget', 'added', 'score', 'svg', 'rmse', 'dssim', 'base', 'improved'];

function sanitizeProgress(info) {
  const data = {};
  for (const k of PROGRESS_FIELDS) {
    if (info[k] !== undefined) data[k] = info[k];
  }
  return data;
}

async function main() {
  const { input, opts } = workerData || {};
  const runOpts = { ...(opts || {}) };

  // weightMap travels as an ArrayBuffer (transferable); converge wants Float32Array.
  if (runOpts.weightMap) {
    runOpts.weightMap = runOpts.weightMap instanceof Float32Array
      ? runOpts.weightMap
      : new Float32Array(runOpts.weightMap);
  } else {
    runOpts.weightMap = null;
  }

  // Live previews: refine events carry the live model only inside this worker
  // (the whitelist strips it), so serialize a throttled SVG snapshot here —
  // this is what lets the browser watch the picture build up.
  let lastPreview = 0;
  runOpts.onProgress = (info) => {
    if (!info) return;
    const data = sanitizeProgress(info);
    if (info.phase === 'refine' && info.model && info.i != null) {
      const stride = Math.max(20, Math.floor((info.budget || 160) / 8));
      if (info.i - lastPreview >= stride) {
        try {
          data.svg = info.model.toSVG();
          lastPreview = info.i;
        } catch {
          // preview is best-effort
        }
      }
    }
    parentPort.postMessage({ type: 'progress', data });
  };

  const res = await converge(rehydrateInput(input), runOpts);
  // Ship only the serializable outcome — never `model` (class instance with
  // methods) or `work` (raw pixel canvas); the parent doesn't need them.
  parentPort.postMessage({
    type: 'result',
    data: { svg: res.svg, metrics: res.metrics, history: res.history },
  });
}

main().catch((err) => {
  parentPort.postMessage({
    type: 'error',
    error: { message: (err && err.message) || String(err), stack: err && err.stack },
  });
});
