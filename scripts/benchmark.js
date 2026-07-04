// Benchmark: agentic-svg vs raw VTracer vs imagetracerjs on all fixtures.
// Re-runnable: node scripts/benchmark.js
// Scores honest dssim/rmse at original resolution, writes out/benchmark.md
// and a side-by-side gallery out/benchmark_gallery.png.

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import ImageTracer from 'imagetracerjs';
import { convertImage, finalizeSvg } from '../src/core/pipeline.js';
import { traceImage, TRACE_PRESETS } from '../src/core/trace.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { loadImage } from '../src/core/image.js';
import { dssim, rmse } from '../src/core/metrics.js';

const FIXTURES_DIR = 'fixtures';
const OUT_DIR = 'out';
const GALLERY_FIXTURES = ['orb', 'photo', 'ui', 'logo'];

mkdirSync(OUT_DIR, { recursive: true });

const fixtures = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.png')).sort();

function score(svg, src) {
  const r = renderSvgToRgba(svg, src.width, src.height);
  return {
    dssim: dssim(src.data, r.data, src.width, src.height),
    rmse: rmse(src.data, r.data, src.width, src.height),
    bytes: Buffer.byteLength(svg),
  };
}

// Contenders. Each returns { svg, ms, variant }. `ms` covers the work the
// contender actually needed for its kept result (svgo included everywhere so
// byte counts compare like-for-like).
async function runAgentic(buf, src, quality) {
  const t = Date.now();
  const r = await convertImage(buf, { quality });
  return { svg: r.svg, ms: Date.now() - t, variant: quality };
}

async function runVtracer(buf, src) {
  // Strongest generic baseline: try both flat and poster, keep the better.
  let best = null;
  for (const name of ['flat', 'poster']) {
    const t = Date.now();
    const svg = finalizeSvg(await traceImage(buf, TRACE_PRESETS[name]));
    const ms = Date.now() - t;
    const s = score(svg, src);
    if (!best || s.dssim < best.s.dssim) best = { svg, ms, variant: name, s };
  }
  return best;
}

const IT_VARIANTS = [
  ['default', 'default'],
  ['hq32', { numberofcolors: 32, ltres: 0.5, qtres: 0.5, pathomit: 4, colorquantcycles: 3 }],
  ['hq64', { numberofcolors: 64, ltres: 0.5, qtres: 0.5, pathomit: 4, colorquantcycles: 3 }],
];

async function runImagetracer(buf, src) {
  let best = null;
  for (const [name, opts] of IT_VARIANTS) {
    const t = Date.now();
    const svg = finalizeSvg(ImageTracer.imagedataToSVG(src, opts));
    const ms = Date.now() - t;
    const s = score(svg, src);
    if (!best || s.dssim < best.s.dssim) best = { svg, ms, variant: name, s };
  }
  return best;
}

const CONTENDERS = [
  ['agentic-balanced', (buf, src) => runAgentic(buf, src, 'balanced')],
  ['agentic-high', (buf, src) => runAgentic(buf, src, 'high')],
  ['vtracer-best', runVtracer],
  ['imagetracer-best', runImagetracer],
];

const results = []; // { fixture, w, h, cells: { name: { dssim, rmse, bytes, ms, variant, svg } } }
const t0 = Date.now();

for (const file of fixtures) {
  const fixture = file.replace(/\.png$/, '');
  const buf = readFileSync(`${FIXTURES_DIR}/${file}`);
  const src = await loadImage(buf); // full original resolution
  const cells = {};
  for (const [name, run] of CONTENDERS) {
    const r = await run(buf, src);
    const s = r.s || score(r.svg, src);
    cells[name] = { ...s, ms: r.ms, variant: r.variant, svg: r.svg };
    console.log(
      `${fixture.padEnd(12)} ${name.padEnd(18)} dssim=${s.dssim.toFixed(4)} rmse=${s.rmse.toFixed(4)} ` +
      `${(s.bytes / 1024).toFixed(1).padStart(7)}KB ${String(r.ms).padStart(6)}ms (${r.variant})`
    );
  }
  results.push({ fixture, w: src.width, h: src.height, cells });
}

// ---- report ----------------------------------------------------------------

const names = CONTENDERS.map(([n]) => n);
const fmt = (c, bold) => {
  const d = c.dssim.toFixed(4);
  return `${bold ? `**${d}**` : d} / ${(c.bytes / 1024).toFixed(1)}KB / ${c.ms}ms`;
};

const lines = [];
lines.push('# Benchmark: agentic-svg vs open-source tracers');
lines.push('');
lines.push(`Date: ${new Date().toISOString().slice(0, 10)}. All outputs rendered via resvg at the`);
lines.push('original resolution and scored against the source (dssim, lower = better).');
lines.push('Baselines are per-image best-of: VTracer tries the flat and poster presets,');
lines.push('imagetracerjs tries default/hq32/hq64; the better dssim is kept. All outputs');
lines.push('pass through the same svgo cleanup, so byte counts are like-for-like.');
lines.push('');
lines.push(`Cell format: dssim / bytes / wall-clock ms. Best dssim per fixture in bold.`);
lines.push('');
lines.push(`| fixture | ${names.join(' | ')} |`);
lines.push(`|---|${names.map(() => '---').join('|')}|`);

for (const r of results) {
  const bestD = Math.min(...names.map((n) => r.cells[n].dssim));
  const row = names.map((n) => fmt(r.cells[n], r.cells[n].dssim === bestD));
  lines.push(`| ${r.fixture} (${r.w}x${r.h}) | ${row.join(' | ')} |`);
}

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const agg = {};
for (const n of names) {
  const ds = results.map((r) => r.cells[n].dssim);
  const kbs = results.map((r) => r.cells[n].bytes / 1024);
  const ms = results.map((r) => r.cells[n].ms);
  const wins = results.filter((r) => r.cells[n].dssim === Math.min(...names.map((m) => r.cells[m].dssim))).length;
  // Fidelity-per-size: dssim x KB, lower = better fidelity for fewer bytes.
  const fps = mean(results.map((r) => r.cells[n].dssim * (r.cells[n].bytes / 1024)));
  agg[n] = { meanD: mean(ds), medD: median(ds), meanKB: mean(kbs), meanMs: mean(ms), wins, fps };
}

lines.push('');
lines.push('## Aggregate');
lines.push('');
lines.push(`| metric | ${names.join(' | ')} |`);
lines.push(`|---|${names.map(() => '---').join('|')}|`);
const aggRow = (label, f) => lines.push(`| ${label} | ${names.map((n) => f(agg[n])).join(' | ')} |`);
aggRow('mean dssim', (a) => a.meanD.toFixed(4));
aggRow('median dssim', (a) => a.medD.toFixed(4));
aggRow('mean bytes', (a) => `${a.meanKB.toFixed(1)}KB`);
aggRow('mean ms', (a) => Math.round(a.meanMs));
aggRow(`wins (best dssim, of ${results.length})`, (a) => a.wins);
aggRow('dssim x KB (fidelity-per-size, lower better)', (a) => a.fps.toFixed(2));

lines.push('');
lines.push('## Losses');
lines.push('');
const losses = results.filter((r) => {
  const bestD = Math.min(...names.map((n) => r.cells[n].dssim));
  return r.cells['agentic-high'].dssim > bestD;
});
if (losses.length === 0) {
  lines.push('agentic-high holds the best dssim on every fixture.');
} else {
  for (const r of losses) {
    const winner = names.reduce((a, b) => (r.cells[a].dssim <= r.cells[b].dssim ? a : b));
    const w = r.cells[winner], us = r.cells['agentic-high'];
    lines.push(
      `- ${r.fixture}: ${winner} (${w.variant}) wins at dssim ${w.dssim.toFixed(4)} vs agentic-high ` +
      `${us.dssim.toFixed(4)} (${(w.bytes / 1024).toFixed(1)}KB vs ${(us.bytes / 1024).toFixed(1)}KB).`
    );
  }
}
const fatter = results.filter((r) => r.cells['agentic-high'].bytes > Math.min(r.cells['vtracer-best'].bytes, r.cells['imagetracer-best'].bytes));
lines.push('');
lines.push(`Byte-size note: agentic-high emits more bytes than the smaller baseline on ${fatter.length}/${results.length} fixtures` +
  (fatter.length ? ` (${fatter.map((r) => r.fixture).join(', ')}).` : '.'));

const md = lines.join('\n') + '\n';
writeFileSync(`${OUT_DIR}/benchmark.md`, md);
console.log('\n' + md);

// ---- gallery ----------------------------------------------------------------

const TILE = 300, GAP = 8, LABEL_H = 24;
const cols = ['original', 'agentic-high', 'vtracer-best', 'imagetracer-best'];

const tileFromSvg = (svg, w, h) => {
  const rw = TILE * 2, rh = Math.round((rw * h) / w); // keep source aspect
  return sharp(Buffer.from(renderSvgToRgba(svg, rw, rh).data.buffer), {
    raw: { width: rw, height: rh, channels: 4 },
  }).resize(TILE, TILE, { fit: 'contain', background: '#fff' }).flatten({ background: '#fff' }).png().toBuffer();
};

const galleryRows = [];
for (const name of GALLERY_FIXTURES) {
  const r = results.find((x) => x.fixture === name);
  if (!r) continue;
  const orig = await sharp(`${FIXTURES_DIR}/${name}.png`)
    .resize(TILE, TILE, { fit: 'contain', background: '#fff' }).flatten({ background: '#fff' }).png().toBuffer();
  const tiles = [orig];
  for (const c of cols.slice(1)) tiles.push(await tileFromSvg(r.cells[c].svg, r.w, r.h));
  galleryRows.push({ name, tiles, cells: r.cells });
}

const GW = cols.length * TILE + (cols.length - 1) * GAP;
const GH = galleryRows.length * (TILE + LABEL_H) + (galleryRows.length - 1) * GAP;
const comps = [];
galleryRows.forEach((row, ri) => {
  const top = ri * (TILE + LABEL_H + GAP) + LABEL_H;
  row.tiles.forEach((buf, ci) => comps.push({ input: buf, left: ci * (TILE + GAP), top }));
});

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GW}" height="${GH}">` +
  `<style>text{font:bold 13px sans-serif;fill:#e8e8ee;}</style>`;
galleryRows.forEach((row, ri) => {
  const y = ri * (TILE + LABEL_H + GAP) + 16;
  cols.forEach((c, ci) => {
    const x = ci * (TILE + GAP);
    let text = c === 'original' ? `${row.name} - original` : c;
    if (c !== 'original') {
      const cell = row.cells[c];
      text += ` (${cell.variant}) d=${cell.dssim.toFixed(4)} ${(cell.bytes / 1024).toFixed(0)}KB`;
    }
    labelSvg += `<text x="${x + 4}" y="${y}">${esc(text)}</text>`;
  });
});
labelSvg += '</svg>';

await sharp({ create: { width: GW, height: GH, channels: 3, background: '#1b1d2c' } })
  .composite([...comps, { input: Buffer.from(labelSvg), left: 0, top: 0 }])
  .png().toFile(`${OUT_DIR}/benchmark_gallery.png`);

console.log(`wrote ${OUT_DIR}/benchmark.md and ${OUT_DIR}/benchmark_gallery.png (${GW}x${GH})`);
console.log(`total ${(Date.now() - t0) / 1000 | 0}s`);
