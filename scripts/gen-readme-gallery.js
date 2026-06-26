// Build a README results montage: per fixture, ORIGINAL | SVGFORGE side by side.
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { convertImage } from '../src/core/pipeline.js';

const cell = 240;          // image square
const gap = 10;            // gutter between cells
const labelH = 26;         // label strip height
const pad = 20;            // outer padding
const titleH = 64;         // header band
const bg = '#1b1d2c';
const accent = '#ff7a59';

const fixtures = ['logo', 'scene', 'gradient', 'ui'].filter(n => existsSync(`fixtures/${n}.png`));

const renderSvg = (svg) =>
  sharp(new Resvg(svg, { fitTo: { mode: 'width', value: cell } }).render().asPng())
    .resize(cell, cell).flatten({ background: '#ffffff' }).toBuffer();

const rows = [];
for (const name of fixtures) {
  const src = readFileSync(`fixtures/${name}.png`);
  const orig = await sharp(src).resize(cell, cell, { fit: 'cover' }).flatten({ background: '#ffffff' }).toBuffer();
  const conv = await convertImage(src, { quality: 'high' });
  const result = await renderSvg(conv.svg);
  const kb = (conv.metrics.finalBytes / 1024).toFixed(1);
  const dssim = conv.metrics.finalDssim.toFixed(4);
  rows.push({ name, orig, result, kb, dssim });
  console.log(`${name}: dssim=${dssim} ${kb}KB base=${conv.metrics.base}`);
}

const rowW = 2 * cell + gap;
const rowH = cell + labelH;
const W = pad * 2 + rowW;
const H = pad * 2 + titleH + rows.length * rowH + (rows.length - 1) * gap;

const comp = [];
rows.forEach((r, i) => {
  const top = pad + titleH + i * (rowH + gap) + labelH;
  comp.push({ input: r.orig, left: pad, top });
  comp.push({ input: r.result, left: pad + cell + gap, top });
});

// Text overlay: title + per-row labels, all in one SVG layer.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
let svgLabels = '';
rows.forEach((r, i) => {
  const y = pad + titleH + i * (rowH + gap);
  svgLabels += `<text x="${pad + 6}" y="${y + 18}" class="lab">ORIGINAL</text>`;
  svgLabels += `<text x="${pad + cell + gap + 6}" y="${y + 18}" class="lab accent">SVGFORGE</text>`;
  svgLabels += `<text x="${pad + cell + gap + cell - 6}" y="${y + 18}" text-anchor="end" class="meta">${esc(r.name)} · ${r.kb}KB · dssim ${r.dssim}</text>`;
});

const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <style>
    .lab{font:700 14px 'Segoe UI',system-ui,sans-serif;fill:#fff;}
    .accent{fill:${accent};}
    .meta{font:500 12px 'Segoe UI',system-ui,sans-serif;fill:#a7a9b8;}
    .brand{font:700 30px 'Segoe UI',system-ui,sans-serif;fill:#fff;}
    .brandb{fill:${accent};}
    .tag{font:500 14px 'Segoe UI',system-ui,sans-serif;fill:#a7a9b8;}
  </style>
  <polygon points="${pad + 16},${pad + 10} ${pad + 36},${pad + 46} ${pad - 4},${pad + 46}" fill="${accent}"/>
  <circle cx="${pad + 16}" cy="${pad + 36}" r="9" fill="${bg}"/>
  <text x="${pad + 50}" y="${pad + 44}" class="brand">SVG<tspan class="brandb">Forge</tspan></text>
  <text x="${W - pad}" y="${pad + 44}" text-anchor="end" class="tag">trace → render → measure → refine</text>
  ${svgLabels}
</svg>`;

if (!existsSync('out')) mkdirSync('out', { recursive: true });
await sharp({ create: { width: W, height: H, channels: 3, background: bg } })
  .composite([...comp, { input: Buffer.from(overlay), left: 0, top: 0 }])
  .png().toFile('out/gallery.png');

console.log(`wrote out/gallery.png ${W}x${H} (${rows.length} rows)`);
