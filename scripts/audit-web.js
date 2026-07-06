// Audit the converter against every image in testdata/.
// For each image: convertImage at quality 'high', render the SVG at source
// resolution, compute dssim, and write an out/web_<name>.png side-by-side
// (original left, SVG render right, max side ~1000px).
//
// Each conversion runs in a child process (this same file with --one) so a
// crash or a hang (>120s) is recorded in the table instead of ending the run.
//
// Usage: node scripts/audit-web.js

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { convertImage } from '../src/core/pipeline.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim } from '../src/core/metrics.js';
import { loadImage } from '../src/core/image.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTDATA = path.join(ROOT, 'testdata');
const OUT = path.join(ROOT, 'out');
const TIMEOUT_MS = 120_000;
const MARK = '@@RESULT@@';

// ---------------------------------------------------------------- child mode
async function runOne(file) {
  const name = path.basename(file).replace(/\.[^.]+$/, '');
  const original = await loadImage(file);
  const { width: W, height: H } = original;

  const t0 = Date.now();
  const { svg, analysis } = await convertImage(file, { quality: 'high' });
  const seconds = (Date.now() - t0) / 1000;

  const rendered = renderSvgToRgba(svg, W, H);
  const score = dssim(original.data, rendered.data, W, H);
  const kb = Buffer.byteLength(svg) / 1024;

  // Side-by-side: original | render, scaled so max(2*w, h) <= ~1000px.
  const scale = Math.min(1, 1000 / Math.max(2 * W, H));
  const pw = Math.max(1, Math.round(W * scale));
  const ph = Math.max(1, Math.round(H * scale));
  const left = await sharp(file).flatten({ background: '#fff' }).resize(pw, ph, { fit: 'fill' }).png().toBuffer();
  const right = await sharp(Buffer.from(rendered.data.buffer, rendered.data.byteOffset, rendered.data.byteLength), {
    raw: { width: W, height: H, channels: 4 },
  }).resize(pw, ph, { fit: 'fill' }).png().toBuffer();
  await sharp({ create: { width: pw * 2, height: ph, channels: 3, background: '#fff' } })
    .composite([{ input: left, left: 0, top: 0 }, { input: right, left: pw, top: 0 }])
    .png()
    .toFile(path.join(OUT, `web_${name}.png`));

  console.log(MARK + JSON.stringify({
    name: path.basename(file),
    type: analysis?.type ?? '?',
    dssim: score,
    kb,
    seconds,
  }));
}

// --------------------------------------------------------------- parent mode
function spawnOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--one', file], {
      cwd: ROOT,
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let out = '', err = '';
    const t0 = Date.now();
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code, signal) => {
      const elapsed = (Date.now() - t0) / 1000;
      const line = out.split('\n').find((l) => l.startsWith(MARK));
      if (line) return resolve(JSON.parse(line.slice(MARK.length)));
      const name = path.basename(file);
      if (elapsed >= TIMEOUT_MS / 1000 - 1) {
        return resolve({ name, type: '?', error: `TIMEOUT >${TIMEOUT_MS / 1000}s`, seconds: elapsed });
      }
      const detail = (err.trim().split('\n').filter(Boolean).slice(-3).join(' | ') || `exit ${code ?? signal}`).slice(0, 160);
      resolve({ name, type: '?', error: `CRASH: ${detail}`, seconds: elapsed });
    });
    child.on('error', (e) => resolve({ name: path.basename(file), type: '?', error: `SPAWN: ${e.message}` }));
  });
}

function printTable(rows) {
  const cols = [
    ['name', (r) => r.name],
    ['type', (r) => r.type ?? '?'],
    ['dssim', (r) => (r.dssim != null ? r.dssim.toFixed(4) : '-')],
    ['KB', (r) => (r.kb != null ? r.kb.toFixed(1) : '-')],
    ['seconds', (r) => (r.seconds != null ? r.seconds.toFixed(1) : '-')],
    ['status', (r) => r.error || 'ok'],
  ];
  const widths = cols.map(([h, f]) => Math.max(h.length, ...rows.map((r) => String(f(r)).length)));
  const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');
  console.log(line(cols.map(([h]) => h)));
  console.log(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) console.log(line(cols.map(([, f]) => f(r))));
}

async function main() {
  const oneIdx = process.argv.indexOf('--one');
  if (oneIdx !== -1) {
    await runOne(process.argv[oneIdx + 1]);
    return;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(TESTDATA)
    .filter((f) => /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(f))
    .sort()
    .map((f) => path.join(TESTDATA, f));
  if (!files.length) {
    console.error('no images in testdata/ — run scripts/fetch-testdata.js first');
    process.exit(1);
  }

  const rows = [];
  for (const file of files) {
    process.stderr.write(`converting ${path.basename(file)} ...\n`);
    rows.push(await spawnOne(file));
  }
  printTable(rows);
}

main().catch((e) => { console.error(e); process.exit(1); });
