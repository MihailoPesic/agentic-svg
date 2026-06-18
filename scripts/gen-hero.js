// Build the hero comparison montage: ORIGINAL | ONE-SHOT TRACE | SVGFORGE.
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { readFileSync } from 'node:fs';
import { traceImage, TRACE_PRESETS } from '../src/core/trace.js';
import { convertImage } from '../src/core/pipeline.js';

const size = 300, gap = 8;
const renderSvg = (svg) => sharp(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng())
  .resize(size, size).flatten({ background: '#fff' }).toBuffer();

const rows = [];
for (const [name, preset] of [['gradient', 'poster'], ['scene', 'flat'], ['orb', 'poster']]) {
  const src = readFileSync(`fixtures/${name}.png`);
  const target = await sharp(src).resize(size, size).toBuffer();
  const traceImg = await renderSvg(await traceImage(src, TRACE_PRESETS[preset]));
  const conv = await convertImage(src, { quality: 'high' });
  const convImg = await renderSvg(conv.svg);
  rows.push([target, traceImg, convImg]);
  console.log(`${name}: base=${conv.metrics.base} dssim=${conv.metrics.finalDssim.toFixed(4)} ${(conv.metrics.finalBytes / 1024).toFixed(1)}KB`);
}

const W = 3 * size + 2 * gap, H = rows.length * size + (rows.length - 1) * gap;
const comp = [];
rows.forEach((cols, ri) => cols.forEach((b, ci) => comp.push({ input: b, left: ci * (size + gap), top: ri * (size + gap) })));

const lbl = (x, w, color, text) =>
  `<rect x="${x}" y="0" width="${w}" height="24" fill="${color}"/><text x="${x + 8}" y="17">${text}</text>`;
const labels = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <style>text{font:bold 15px sans-serif;fill:#fff;}</style>
  ${lbl(0, 96, '#000000aa', 'ORIGINAL')}
  ${lbl(size + gap, 168, '#000000aa', 'ONE-SHOT TRACE')}
  ${lbl(2 * (size + gap), 210, '#c44536cc', 'SVGFORGE CONVERGED')}
</svg>`;

await sharp({ create: { width: W, height: H, channels: 3, background: '#1b1d2c' } })
  .composite([...comp, { input: Buffer.from(labels), left: 0, top: 0 }])
  .png().toFile('out/hero.png');
console.log('wrote out/hero.png', `${W}x${H}`);
