// Routing battery: run analyze() on every fixture and print type + signals,
// side by side with the previous classifier logic (frozen copy below) so
// routing changes are visible at a glance.
//
//   node scripts/test-routing.js

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { analyze } from '../src/core/classify.js';
import { loadImage } from '../src/core/image.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');

// ---------------------------------------------------------------------------
// Frozen copy of the OLD analyze() (pre smooth-gradient routing) for the
// before column. Do not "fix" this — it exists to show what changed.
async function oldAnalyze(input) {
  const img = await loadImage(input, { maxSize: 128 });
  const { data, width: W, height: H } = img;

  const seen = new Set();
  for (let i = 0; i < data.length; i += 4) {
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    seen.add(k);
  }
  const colors = seen.size;

  let edges = 0, n = 0, gradSum = 0;
  const luma = (o) => 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const o = (y * W + x) * 4;
      const g = Math.abs(luma(o + 4) - luma(o - 4)) + Math.abs(luma(o + W * 4) - luma(o - W * 4));
      gradSum += g;
      if (g > 40) edges++;
      n++;
    }
  }
  const edgeDensity = edges / n;
  const smoothness = 1 - Math.min(1, gradSum / n / 40);

  const text = edgeDensity >= 0.15 && edgeDensity < 0.42 && colors <= 200;

  let type;
  if (text) type = 'text';
  else if (colors <= 24 && edgeDensity < 0.18) type = 'flat';
  else if (colors <= 400 && edgeDensity < 0.32) type = 'illustration';
  else type = 'photo';

  return { type, colors, edgeDensity: +edgeDensity.toFixed(3), smoothness: +smoothness.toFixed(3) };
}
// ---------------------------------------------------------------------------

const fixtures = readdirSync(fixturesDir).filter((f) => f.endsWith('.png')).sort();

const pad = (s, w) => String(s).padEnd(w);
console.log(pad('fixture', 14) + pad('old type', 14) + pad('new type', 14)
  + pad('colors', 8) + pad('edge', 8) + pad('smooth', 8) + pad('smoothShare', 13) + pad('texture', 9) + pad('thinInk', 9) + 'changed');
console.log('-'.repeat(105));

for (const f of fixtures) {
  const path = join(fixturesDir, f);
  const before = await oldAnalyze(path);
  const after = await analyze(path);
  const changed = before.type !== after.type ? '  <-- ' + before.type + ' -> ' + after.type : '';
  console.log(
    pad(f.replace(/\.png$/, ''), 14)
    + pad(before.type, 14)
    + pad(after.type, 14)
    + pad(after.colors, 8)
    + pad(after.edgeDensity, 8)
    + pad(after.smoothness, 8)
    + pad(after.smoothShare ?? '-', 13)
    + pad(after.texture ?? '-', 9)
    + pad(after.thinInkFrac ?? '-', 9)
    + changed,
  );
}
