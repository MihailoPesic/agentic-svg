// Worker entry for one conversion job. Runs convertImage off the server's
// main thread and forwards progress as plain serializable messages —
// no Model instance ever crosses the thread boundary; svg previews are
// rendered to strings here, with the same throttling the server used to do.

import { parentPort, workerData } from 'node:worker_threads';
import { convertImage } from '../core/pipeline.js';

const { input, quality, saliency } = workerData;
const post = (event, data) => parentPort.postMessage({ event, data });

let lastPreview = 0;
try {
  const result = await convertImage(Buffer.from(input.buffer, input.byteOffset, input.byteLength), {
    quality,
    optimize: true,
    overrides: typeof saliency === 'boolean' ? { saliency } : {},
    onProgress: (p) => {
      if (p.phase === 'analysis') {
        post('analysis', { analysis: p.analysis, plan: p.plan });
      } else if (p.phase === 'trace') {
        post('trace', { svg: p.svg, rmse: p.rmse, dssim: p.dssim });
      } else if (p.phase === 'refine') {
        const ev = { i: p.i, budget: p.budget, added: p.added, score: p.score };
        // Cap previews to ~8 over the whole run regardless of budget — injecting
        // a large SVG too often can stall the browser renderer.
        const stride = Math.max(20, Math.floor(p.budget / 8));
        if (p.i - lastPreview >= stride && p.model) { ev.svg = p.model.toSVG(); lastPreview = p.i; }
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
