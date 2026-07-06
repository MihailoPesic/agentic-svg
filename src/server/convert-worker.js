// Worker entry for one conversion job. Runs convertImage off the server's
// main thread and forwards progress as plain serializable messages. Refine
// previews arrive already serialized (the converge workers render throttled
// SVG snapshots); events from non-primary candidate runs have their previews
// stripped upstream, so what lands here is safe to forward as-is.

import { parentPort, workerData } from 'node:worker_threads';
import { convertImage } from '../core/pipeline.js';

const { input, quality, saliency } = workerData;
const post = (event, data) => parentPort.postMessage({ event, data });

try {
  const result = await convertImage(Buffer.from(input.buffer, input.byteOffset, input.byteLength), {
    quality,
    optimize: true,
    overrides: typeof saliency === 'boolean' ? { saliency } : {},
    onProgress: (p) => {
      if (p.phase === 'analysis') {
        post('analysis', { analysis: p.analysis, plan: p.plan });
      } else if (p.phase === 'trace') {
        if (p.run === undefined || p.run === 'A') post('trace', { svg: p.svg, rmse: p.rmse, dssim: p.dssim });
      } else if (p.phase === 'refine') {
        const ev = { i: p.i, budget: p.budget, added: p.added, score: p.score };
        if (p.svg) ev.svg = p.svg;
        post('refine', ev);
      }
    },
  });
  post('done', {
    svg: result.svg,
    analysis: result.analysis,
    plan: result.plan,
    metrics: result.metrics,
    history: result.history,
  });
} catch (e) {
  post('error', { message: String(e && e.message || e) });
}
// No listeners keep the event loop alive — the worker exits on its own here.
