// Worker side of the pool. Registers named task handlers and answers messages
// from the parent with { id, ok, result } or { id, ok:false, error }.
//
// Adding a task: register a handler in HANDLERS keyed by task name. Payloads and
// results must be structured-cloneable (plain objects, typed arrays, etc.).
// Pass ArrayBuffers via the pool's `transfer` option to move pixel data without
// copying.

import { parentPort } from 'node:worker_threads';
import {
  computeColor, differencePartial, scanlineArea,
} from './raster.js';
import { SHAPE_TYPES, randomShapeIn } from './shapes.js';

if (!parentPort) throw new Error('pool-worker.js must run as a worker_threads Worker');

// --- shape-eval ------------------------------------------------------------
// Evaluate a batch of candidate shapes against a target/current canvas and
// return the best one (lowest resulting RMSE). This is the parallelizable core
// of optimizer.bestShapeIn: random sampling + local search over candidates.
//
// payload = {
//   target:   ArrayBuffer (Uint8ClampedArray RGBA, W*H*4)
//   current:  ArrayBuffer (Float32Array RGBA,     W*H*4)
//   W, H, alpha, score, maxArea,
//   type, region:{x,y,w,h}, randomTries, maxAge,
// }
// returns { score, color:[r,g,b], shape:<serialized> } | null
function shapeEval(p) {
  const target = new Uint8ClampedArray(p.target);
  const current = new Float32Array(p.current);
  const { W, H, alpha, score, type, region } = p;
  const maxArea = p.maxArea ?? Infinity;

  const energy = (shape) => {
    const lines = shape.rasterize(W, H);
    const area = scanlineArea(lines);
    if (area < 1 || area > maxArea) return { score: score + 1, color: [0, 0, 0], lines };
    const color = computeColor(target, current, lines, alpha, W);
    const s = differencePartial(target, current, lines, color, alpha, score, W, H);
    return { score: s, color, lines };
  };

  // Random sampling to seed, then hill-climb by mutation (mirrors Model).
  let start = null;
  for (let i = 0; i < (p.randomTries ?? 24); i++) {
    const shape = randomShapeIn(type, W, H, region);
    const e = energy(shape);
    if (!start || e.score < start.score) start = { shape, score: e.score, color: e.color };
  }
  if (!start) return null;

  let best = start;
  let age = 0;
  const maxAge = p.maxAge ?? 80;
  while (age < maxAge) {
    const cand = best.shape.mutate(W, H);
    const e = energy(cand);
    if (e.score < best.score) { best = { shape: cand, score: e.score, color: e.color }; age = 0; }
    else age++;
  }
  return { score: best.score, color: best.color, shape: serializeShape(best.shape) };
}

// Shapes are class instances; ship a plain descriptor back to the parent, which
// can re-hydrate via reviveShape() when committing the winner.
function serializeShape(shape) {
  for (const [name, cls] of Object.entries(SHAPE_TYPES)) {
    if (shape instanceof cls) return { kind: name, ...shape };
  }
  return { kind: 'unknown', ...shape };
}

// --- generic helpers (self-test / ad-hoc work) -----------------------------
const HANDLERS = {
  'shape-eval': shapeEval,
  ping: (p) => ({ pong: p ?? null }),
  // Evaluate a function body string with a payload. Handy for microbenchmarks
  // and the self-test; not used on any hot path.
  fn: ({ body, arg }) => {
    // eslint-disable-next-line no-new-func
    const f = new Function('x', body);
    return f(arg);
  },
};

parentPort.on('message', (msg) => {
  const { id, task, payload } = msg;
  try {
    const handler = HANDLERS[task];
    if (!handler) throw new Error(`unknown task: ${task}`);
    const result = handler(payload);
    parentPort.postMessage({ id, ok: true, result });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: { message: err.message, stack: err.stack, code: err.code } });
  }
});
