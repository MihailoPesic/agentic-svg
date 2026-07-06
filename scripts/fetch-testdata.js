// Fetch real-world test images from Wikimedia Commons into testdata/,
// then synthesize text-heavy cases the web can't reliably provide.
// Usage: node scripts/fetch-testdata.js

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { Resvg } from '@resvg/resvg-js';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'testdata');
fs.mkdirSync(DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const FETCHES = [
  ['https://commons.wikimedia.org/wiki/Special:FilePath/Hopetoun_falls.jpg?width=1100', 'photo-landscape.jpg'],
  ['https://commons.wikimedia.org/wiki/Special:FilePath/Albert_Einstein_Head.jpg?width=900', 'photo-face.jpg'],
  ['https://commons.wikimedia.org/wiki/Special:FilePath/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg?width=1100', 'painting.jpg'],
  ['https://commons.wikimedia.org/wiki/Special:FilePath/Times_Square_1-2.JPG?width=1100', 'photo-signage.jpg'],
  ['https://commons.wikimedia.org/wiki/Special:FilePath/Flag_of_Mexico.svg?width=1000', 'flat-flag.png'],
  ['https://commons.wikimedia.org/wiki/Special:FilePath/United_States_Declaration_of_Independence.jpg?width=1000', 'document-scan.jpg'],
  ['https://commons.wikimedia.org/wiki/Special:FilePath/Wikipedia-logo-v2.svg?width=900', 'logo-detail.png'],
  ['https://commons.wikimedia.org/wiki/Special:FilePath/Color_circle_(hue-sat).png?width=800', 'gradient-wheel.png'],
];

async function fetchOne(url, name) {
  const dest = path.join(DIR, name);
  try {
    const { stdout } = await execFileP('curl', [
      '-L', '-sS', '--max-time', '30', '-A', UA, '-o', dest, '-w', '%{http_code}', url,
    ], { timeout: 35000 });
    const code = stdout.trim();
    if (code !== '200') throw new Error(`HTTP ${code}`);
    const meta = await sharp(dest).metadata();
    if (!meta.width || !meta.height) throw new Error('not an image');
    console.log(`OK   ${name}  ${meta.width}x${meta.height} ${meta.format}`);
    return true;
  } catch (err) {
    console.log(`FAIL ${name}  ${url}  (${err.message.split('\n')[0]})`);
    try { fs.unlinkSync(dest); } catch {}
    return false;
  }
}

// Render an SVG string to a PNG file using resvg with system fonts (Windows
// has Impact / Consolas / Georgia etc.), so text actually rasterizes.
function svgToPngFile(svg, dest, { transparent = false } = {}) {
  const r = new Resvg(svg, {
    font: { loadSystemFonts: true },
    ...(transparent ? {} : { background: 'rgb(255,255,255)' }),
  });
  const img = r.render();
  return sharp(Buffer.from(img.pixels), { raw: { width: img.width, height: img.height, channels: 4 } })
    .png()
    .toFile(dest);
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function makeMeme(photoName) {
  const src = path.join(DIR, photoName);
  const base = await sharp(src).resize(900, null, { fit: 'inside' }).toBuffer();
  const meta = await sharp(base).metadata();
  const W = meta.width, H = meta.height;
  const textSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <style>text{font-family:Impact,'Arial Black',Arial,sans-serif;font-weight:900;font-size:64px;fill:#fff;stroke:#000;stroke-width:6;paint-order:stroke;text-anchor:middle;letter-spacing:2px;}</style>
    <text x="${W / 2}" y="80">WHEN THE TRACE</text>
    <text x="${W / 2}" y="${H - 30}">FINALLY CONVERGES</text>
  </svg>`;
  const r = new Resvg(textSvg, { font: { loadSystemFonts: true } });
  const overlay = r.render();
  const overlayPng = await sharp(Buffer.from(overlay.pixels), { raw: { width: overlay.width, height: overlay.height, channels: 4 } }).png().toBuffer();
  await sharp(base)
    .composite([{ input: overlayPng, top: 0, left: 0 }])
    .png()
    .toFile(path.join(DIR, 'meme.png'));
  console.log(`GEN  meme.png  ${W}x${H}`);
}

async function makeCodeEditor() {
  const W = 1000, H = 640, lineH = 26, fs14 = 14, gutter = 56;
  const kw = '#569cd6', kw2 = '#c586c0', str = '#ce9178', com = '#6a9955', fn = '#dcdcaa', ty = '#4ec9b0', num = '#b5cea8', txt = '#d4d4d4';
  const lines = [
    [[com, '// converge.js — iterative shape refinement loop']],
    [[kw2, 'import'], [txt, ' { renderSvgToRgba } '], [kw2, 'from'], [str, " './render.js'"], [txt, ';']],
    [[kw2, 'import'], [txt, ' { dssim, errorMap } '], [kw2, 'from'], [str, " './metrics.js'"], [txt, ';']],
    [[txt, '']],
    [[kw, 'const'], [txt, ' MAX_PASSES = '], [num, '48'], [txt, ';']],
    [[kw, 'const'], [txt, ' PLATEAU_EPS = '], [num, '0.0004'], [txt, ';']],
    [[txt, '']],
    [[com, '// Score a candidate mutation against the target raster.']],
    [[kw2, 'export'], [kw, ' async function'], [fn, ' scoreCandidate'], [txt, '(svg, target, W, H) {']],
    [[kw, '  const'], [txt, ' px = '], [fn, 'renderSvgToRgba'], [txt, '(svg, W, H);']],
    [[kw2, '  return'], [fn, ' dssim'], [txt, '(px.data, target.data, W, H);']],
    [[txt, '}']],
    [[txt, '']],
    [[kw2, 'export'], [kw, ' async function'], [fn, ' refine'], [txt, '(shapes, target, opts = {}) {']],
    [[kw, '  let'], [txt, ' best = '], [kw, 'await'], [fn, ' scoreCandidate'], [txt, '(shapes.toSvg(), target);']],
    [[kw2, '  for'], [txt, ' ('], [kw, 'let'], [txt, ' pass = '], [num, '0'], [txt, '; pass < MAX_PASSES; pass++) {']],
    [[kw, '    const'], [txt, ' cells = '], [fn, 'errorMap'], [txt, '(target, current, W, H, '], [num, '16'], [txt, ');']],
    [[kw, '    const'], [txt, ' worst = cells.'], [fn, 'sort'], [txt, '((a, b) => b.err - a.err)['], [num, '0'], [txt, '];']],
    [[com, '    // Try nudging each control point toward the gradient.']],
    [[kw2, '    for'], [txt, ' ('], [kw, 'const'], [txt, ' shape '], [kw2, 'of'], [txt, ' shapes.'], [fn, 'near'], [txt, '(worst)) {']],
    [[kw, '      const'], [txt, ' trial = shape.'], [fn, 'perturb'], [txt, '(opts.step ?? '], [num, '1.5'], [txt, ');']],
    [[kw, '      const'], [txt, ' score = '], [kw, 'await'], [fn, ' scoreCandidate'], [txt, '(trial, target);']],
    [[kw2, '      if'], [txt, ' (score < best - PLATEAU_EPS) { best = score; shapes.'], [fn, 'commit'], [txt, '(trial); }']],
    [[txt, '    }']],
    [[txt, '  }']],
    [[kw2, '  return'], [txt, ' { shapes, best };']],
    [[txt, '}']],
  ];
  let body = '';
  lines.forEach((segs, i) => {
    const y = 34 + i * lineH * 0.85;
    body += `<text x="${gutter - 14}" y="${y}" fill="#858585" text-anchor="end">${i + 1}</text>`;
    let spans = '';
    for (const [color, t] of segs) {
      if (!t) continue;
      spans += `<tspan fill="${color}" xml:space="preserve">${esc(t)}</tspan>`;
    }
    body += `<text x="${gutter + 8}" y="${y}" xml:space="preserve">${spans}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#1e1e1e"/>
    <rect width="${gutter}" height="${H}" fill="#252526"/>
    <g style="font-family:Consolas,'Courier New',monospace;font-size:${fs14}px;">${body}</g>
  </svg>`;
  await svgToPngFile(svg, path.join(DIR, 'code-editor.png'));
  console.log(`GEN  code-editor.png  ${W}x${H}`);
}

async function makeFinePrint() {
  const W = 900, H = 700;
  const sentences = [
    'The undersigned party agrees that all vector output shall be delivered in a timely fashion and',
    'without material defect, subject to the tolerances described in Schedule B of this agreement.',
    'Any curve whose deviation from the source raster exceeds two device pixels at native resolution',
    'shall be deemed nonconforming and must be refined at no additional cost to the receiving party.',
    'Delivery of scalable assets does not constitute transfer of the underlying artwork copyright.',
    'The provider retains the right to publish anonymized quality metrics derived from conversions,',
    'provided that no source imagery or identifying metadata is disclosed to any third party entity.',
    'Structural similarity scores are computed on the luminance channel using a windowed estimator',
    'and are reported to four decimal places in the accompanying certificate of conformance sheet.',
    'Where the source material contains embedded typography, the provider shall make a reasonable',
    'effort to preserve legibility at all display scales not exceeding four times native resolution.',
    'The receiving party acknowledges that photographic gradients may be approximated by layered',
    'geometric primitives and that such approximation is inherent to the vectorization process.',
    'Invoices are payable within thirty days of receipt; disputed line items must be raised within',
    'ten business days and shall not delay payment of the undisputed balance of the invoice total.',
    'Either party may terminate this agreement with sixty days written notice, whereupon all works',
    'in progress shall be delivered in their current state together with a pro rata final invoice.',
    'No amendment to these terms shall be effective unless made in writing and signed by officers',
    'of both parties, and no failure to enforce any provision shall constitute a waiver thereof.',
    'This agreement is governed by the laws of the jurisdiction named on the signature page below,',
    'without regard to its conflict of law rules, and any dispute shall be resolved by arbitration.',
    'Severability: if any clause herein is found unenforceable, the remainder continues in force.',
    'The parties confirm that they have read and understood the entirety of the present document.',
    'Vector deliverables are provided in the SVG 1.1 profile unless otherwise agreed in writing.',
    'Rasterized proofs accompany each deliverable at one hundred percent and four hundred percent.',
    'Color values are encoded as eight bit sRGB triplets; wide gamut sources are tone mapped first.',
    'The provider warrants that deliverables contain no external references, scripts, or fonts.',
    'Acceptance testing must complete within fourteen days; silence constitutes deemed acceptance.',
    'All notices under this agreement shall be sent to the addresses listed in Schedule A hereof.',
    'Neither party shall be liable for delays caused by events beyond its reasonable control.',
    'Nothing in this agreement creates any partnership, agency, or employment relationship.',
    'Headings are for convenience only and do not affect the interpretation of these clauses.',
  ];
  let body = `<text x="60" y="64" style="font-size:24px;font-weight:bold;">TERMS AND CONDITIONS OF VECTOR CONVERSION SERVICE</text>`;
  sentences.forEach((s, i) => {
    body += `<text x="60" y="${100 + i * 17.4}" style="font-size:11px;">${esc(s)}</text>`;
  });
  body += `<text x="60" y="${H - 18}" style="font-size:8px;">1. Definitions of terms used above appear in the master services agreement, revision 7, filed with the registrar of standard form contracts, document number 2214-B, page 44, line 9.</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" fill="#ffffff"/>
    <g style="font-family:Georgia,'Times New Roman',serif;fill:#111;">${body}</g>
  </svg>`;
  await svgToPngFile(svg, path.join(DIR, 'fine-print.png'));
  console.log(`GEN  fine-print.png  ${W}x${H}`);
}

async function makeSignGradient() {
  const W = 900, H = 500;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="sunset" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2b1055"/>
        <stop offset="0.35" stop-color="#7b2d8b"/>
        <stop offset="0.65" stop-color="#e5533c"/>
        <stop offset="0.85" stop-color="#f79d3c"/>
        <stop offset="1" stop-color="#ffd166"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#sunset)"/>
    <g text-anchor="middle" style="font-family:Arial,Helvetica,sans-serif;">
      <text x="${W / 2}" y="230" style="font-size:72px;font-weight:bold;fill:#ffffff;">GRAND OPENING</text>
      <text x="${W / 2}" y="310" style="font-size:36px;font-weight:bold;fill:#ffe24a;">EVERY SUNSET DESERVES A BANNER</text>
    </g>
  </svg>`;
  await svgToPngFile(svg, path.join(DIR, 'sign-gradient.png'));
  console.log(`GEN  sign-gradient.png  ${W}x${H}`);
}

const results = {};
for (const [url, name] of FETCHES) results[name] = await fetchOne(url, name);

const memePhoto = results['photo-landscape.jpg'] ? 'photo-landscape.jpg'
  : results['photo-face.jpg'] ? 'photo-face.jpg'
  : results['painting.jpg'] ? 'painting.jpg' : null;
if (memePhoto) await makeMeme(memePhoto);
else console.log('SKIP meme.png (no photo fetched)');

await makeCodeEditor();
await makeFinePrint();
await makeSignGradient();
console.log('done');
