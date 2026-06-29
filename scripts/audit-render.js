// Render every fixture through the pipeline and build an original|output
// side-by-side PNG for visual auditing, plus a metrics line per image.
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { convertImage } from '../src/core/pipeline.js';
import { loadImage } from '../src/core/image.js';
import { renderSvgToRgba } from '../src/core/render.js';
import { dssim, rmse } from '../src/core/metrics.js';

mkdirSync('out', { recursive: true });
const quality = process.argv[2] || 'high';
const names = readdirSync('fixtures').filter((f) => f.endsWith('.png')).map((f) => f.replace('.png', ''));

const PANEL = 460;
for (const name of names) {
  const src = `fixtures/${name}.png`;
  const t0 = performance.now();
  const res = await convertImage(src, { quality });
  const ms = performance.now() - t0;
  writeFileSync(`out/audit_${name}.svg`, res.svg);

  const full = await loadImage(src);
  const rendered = renderSvgToRgba(res.svg, full.width, full.height);
  const d = dssim(full.data, rendered.data, full.width, full.height);
  const r = rmse(full.data, rendered.data, full.width, full.height);

  const renderPng = new Resvg(res.svg, { fitTo: { mode: 'width', value: PANEL }, background: 'white' }).render().asPng();
  const out = await sharp(renderPng).resize(PANEL, PANEL, { fit: 'contain', background: 'white' }).flatten({ background: 'white' }).toBuffer();
  const orig = await sharp(src).resize(PANEL, PANEL, { fit: 'contain', background: 'white' }).flatten({ background: 'white' }).toBuffer();
  await sharp({ create: { width: PANEL * 2 + 6, height: PANEL, channels: 3, background: '#999' } })
    .composite([{ input: orig, left: 0, top: 0 }, { input: out, left: PANEL + 6, top: 0 }])
    .png().toFile(`out/audit_${name}.png`);

  const kb = (Buffer.byteLength(res.svg) / 1024).toFixed(1);
  console.log(`${name.padEnd(12)} type=${res.analysis.type.padEnd(12)} dssim=${d.toFixed(4)} rmse=${r.toFixed(4)} shapes=${String(res.metrics.shapesTotal).padStart(3)} ${kb.padStart(7)}KB ${(ms / 1000).toFixed(1)}s`);
}
console.log('\nwrote out/audit_<name>.png (original | output) for visual audit');
