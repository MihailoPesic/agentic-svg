// Build a diverse gallery of deterministic test images, rendered from SVG via
// sharp so they stay crisp. Covers the spread the converter should handle:
// flat icons, a bar chart, a cell-shaded character, a soft-shaded face, a flat
// map illustration, and a glossy sticker. Each is written to fixtures/ and
// mirrored into web/samples/. Pass a name (or names) as args to convert a
// couple through the real pipeline and print type + dssim.
import sharp from 'sharp';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertImage } from '../src/core/pipeline.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');
const samplesDir = join(root, 'web', 'samples');
mkdirSync(fixturesDir, { recursive: true });
mkdirSync(samplesDir, { recursive: true });

const S = 512;

// Small seeded PRNG so "scattered" elements are stable across runs.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

// --- flat icon set: six crisp glyphs on a tile grid, no gradients -----------
function iconSet() {
  const bg = '#eef1f5', tile = '#ffffff', line = '#d7dce3';
  const accents = ['#ef476f', '#06d6a0', '#118ab2', '#ffd166', '#8338ec', '#fb5607'];
  let s = `<rect width="${S}" height="${S}" fill="${bg}"/>`;
  const cols = 3, rows = 2, pad = 28, cell = (S - pad * (cols + 1)) / cols;
  const ch = (S - pad * (rows + 1)) / rows;
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, i++) {
      const x = pad + c * (cell + pad), y = pad + r * (ch + pad);
      const cx = x + cell / 2, cy = y + ch / 2, a = accents[i];
      s += `<rect x="${x}" y="${y}" width="${cell}" height="${ch}" rx="22" fill="${tile}" stroke="${line}" stroke-width="3"/>`;
      const u = 44;
      if (i === 0) // heart
        s += `<path d="M${cx} ${cy + u * 0.7} C ${cx - u * 1.3} ${cy - u * 0.3}, ${cx - u * 0.5} ${cy - u} , ${cx} ${cy - u * 0.2} C ${cx + u * 0.5} ${cy - u}, ${cx + u * 1.3} ${cy - u * 0.3}, ${cx} ${cy + u * 0.7} Z" fill="${a}"/>`;
      else if (i === 1) // gear
        s += gear(cx, cy, u, a);
      else if (i === 2) // bolt
        s += `<polygon points="${cx + 6},${cy - u} ${cx - u * 0.6},${cy + 6} ${cx},${cy + 6} ${cx - 6},${cy + u} ${cx + u * 0.6},${cy - 6} ${cx},${cy - 6}" fill="${a}"/>`;
      else if (i === 3) // star
        s += star(cx, cy, u, u * 0.42, 5, a);
      else if (i === 4) { // chat bubble
        s += `<rect x="${cx - u}" y="${cy - u * 0.8}" width="${u * 2}" height="${u * 1.3}" rx="16" fill="${a}"/>`;
        s += `<polygon points="${cx - u * 0.4},${cy + u * 0.5} ${cx - u * 0.1},${cy + u * 0.5} ${cx - u * 0.5},${cy + u}" fill="${a}"/>`;
      } else // check circle
        s += `<circle cx="${cx}" cy="${cy}" r="${u}" fill="${a}"/><path d="M${cx - u * 0.45} ${cy} l ${u * 0.35} ${u * 0.4} l ${u * 0.7} ${-u * 0.75}" stroke="#fff" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  }
  return s;
}
function gear(cx, cy, r, fill) {
  const teeth = 8;
  let p = '';
  for (let k = 0; k < teeth; k++) {
    const a = (k / teeth) * Math.PI * 2;
    const x = cx + Math.cos(a) * (r + 12), y = cy + Math.sin(a) * (r + 12);
    p += `<rect x="${(x - 9).toFixed(1)}" y="${(y - 9).toFixed(1)}" width="18" height="18" fill="${fill}" transform="rotate(${(a * 180 / Math.PI).toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }
  return `${p}<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/><circle cx="${cx}" cy="${cy}" r="${r * 0.4}" fill="#fff"/>`;
}
function star(cx, cy, ro, ri, points, fill) {
  let pts = [];
  for (let k = 0; k < points * 2; k++) {
    const rad = k % 2 ? ri : ro, a = (k / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    pts.push(`${(cx + Math.cos(a) * rad).toFixed(1)},${(cy + Math.sin(a) * rad).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

// --- bar chart: axes, gridlines, labelled bars ------------------------------
function barChart() {
  const bg = '#ffffff', grid = '#e6e9ef', axis = '#5a6472';
  const bars = [62, 88, 45, 100, 73, 54, 91];
  const colors = ['#118ab2', '#06d6a0', '#ffd166', '#ef476f', '#8338ec', '#fb5607', '#3a86ff'];
  const left = 64, right = 40, top = 56, bottom = 64;
  const pw = S - left - right, ph = S - top - bottom;
  let s = `<rect width="${S}" height="${S}" fill="${bg}"/>`;
  s += `<text x="${left}" y="34" font-family="Arial" font-size="24" font-weight="bold" fill="#22303f">Quarterly output</text>`;
  for (let g = 0; g <= 4; g++) {
    const y = top + (ph / 4) * g;
    s += `<line x1="${left}" y1="${y}" x2="${S - right}" y2="${y}" stroke="${grid}" stroke-width="2"/>`;
    s += `<text x="${left - 12}" y="${y + 5}" font-family="Arial" font-size="14" fill="${axis}" text-anchor="end">${100 - g * 25}</text>`;
  }
  const slot = pw / bars.length, bw = slot * 0.6;
  bars.forEach((v, i) => {
    const h = (v / 100) * ph, x = left + slot * i + (slot - bw) / 2, y = top + ph - h;
    s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="${colors[i]}"/>`;
    s += `<text x="${(x + bw / 2).toFixed(1)}" y="${S - bottom + 22}" font-family="Arial" font-size="14" fill="${axis}" text-anchor="middle">W${i + 1}</text>`;
  });
  s += `<line x1="${left}" y1="${top}" x2="${left}" y2="${top + ph}" stroke="${axis}" stroke-width="3"/>`;
  s += `<line x1="${left}" y1="${top + ph}" x2="${S - right}" y2="${top + ph}" stroke="${axis}" stroke-width="3"/>`;
  return s;
}

// --- comic / cell-shaded character: flat fills + hard shadow steps ----------
function comicChar() {
  let s = `<rect width="${S}" height="${S}" fill="#ffe3a3"/>`;
  s += `<circle cx="256" cy="256" r="210" fill="#ffcf5c"/>`;
  // hair (back)
  s += `<path d="M120 250 q-10 -150 136 -160 q146 10 136 160 q-40 -70 -136 -64 q-96 -6 -136 64 Z" fill="#3a2a1a"/>`;
  // neck + shoulders
  s += `<rect x="226" y="330" width="60" height="60" fill="#e8a76a"/>`;
  s += `<path d="M150 460 q106 -70 212 0 l0 60 l-212 0 Z" fill="#2f6690"/>`;
  // face base
  s += `<ellipse cx="256" cy="250" rx="120" ry="135" fill="#f4b878"/>`;
  // cell shadow on one side (hard step, no gradient)
  s += `<path d="M256 116 a120 135 0 0 0 0 268 q-70 -40 -70 -134 q0 -94 70 -134 Z" fill="#e09a5a"/>`;
  // hair (front swoop)
  s += `<path d="M150 196 q40 -96 150 -78 q70 14 92 86 q-50 -54 -120 -40 q-66 -6 -122 32 Z" fill="#4a3522"/>`;
  // ears
  s += `<ellipse cx="142" cy="256" rx="20" ry="30" fill="#f4b878"/><ellipse cx="370" cy="256" rx="20" ry="30" fill="#f4b878"/>`;
  // eyes
  s += `<ellipse cx="212" cy="240" rx="26" ry="20" fill="#fff"/><circle cx="216" cy="242" r="11" fill="#27313a"/>`;
  s += `<ellipse cx="300" cy="240" rx="26" ry="20" fill="#fff"/><circle cx="304" cy="242" r="11" fill="#27313a"/>`;
  // brows
  s += `<path d="M186 210 q26 -16 52 -4" stroke="#4a3522" stroke-width="8" fill="none" stroke-linecap="round"/>`;
  s += `<path d="M276 206 q26 -12 52 4" stroke="#4a3522" stroke-width="8" fill="none" stroke-linecap="round"/>`;
  // nose + mouth
  s += `<path d="M256 252 l-10 34 l18 0 Z" fill="#e09a5a"/>`;
  s += `<path d="M214 312 q42 36 84 0" stroke="#a84b32" stroke-width="9" fill="none" stroke-linecap="round"/>`;
  // cheek blush (flat)
  s += `<ellipse cx="190" cy="288" rx="20" ry="12" fill="#f08c6e" opacity="0.85"/>`;
  s += `<ellipse cx="322" cy="288" rx="20" ry="12" fill="#f08c6e" opacity="0.85"/>`;
  // bold outline pass for the comic look
  s += `<ellipse cx="256" cy="250" rx="120" ry="135" fill="none" stroke="#2a1c10" stroke-width="6"/>`;
  return s;
}

// --- soft portrait-like face: radial gradients for smooth shading -----------
function softFace() {
  const defs = `<defs>
    <radialGradient id="bg" cx="50%" cy="40%" r="75%">
      <stop offset="0%" stop-color="#fef6ef"/><stop offset="100%" stop-color="#d9c2b0"/>
    </radialGradient>
    <radialGradient id="skin" cx="46%" cy="42%" r="62%">
      <stop offset="0%" stop-color="#ffe0c4"/><stop offset="60%" stop-color="#f0b58a"/><stop offset="100%" stop-color="#c98a5e"/>
    </radialGradient>
    <radialGradient id="cheek" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#f29c8a" stop-opacity="0.8"/><stop offset="100%" stop-color="#f29c8a" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="hair" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#5a3a22"/><stop offset="100%" stop-color="#2c1c10"/>
    </linearGradient>
    <radialGradient id="iris" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#7fb2c9"/><stop offset="100%" stop-color="#2c5a73"/>
    </radialGradient>
  </defs>`;
  let s = defs + `<rect width="${S}" height="${S}" fill="url(#bg)"/>`;
  s += `<path d="M132 270 q-12 -150 124 -158 q136 8 124 158 l0 120 l-248 0 Z" fill="url(#hair)"/>`;
  s += `<ellipse cx="256" cy="262" rx="118" ry="140" fill="url(#skin)"/>`;
  s += `<ellipse cx="196" cy="300" rx="40" ry="28" fill="url(#cheek)"/>`;
  s += `<ellipse cx="316" cy="300" rx="40" ry="28" fill="url(#cheek)"/>`;
  // eyes
  for (const ex of [212, 300]) {
    s += `<ellipse cx="${ex}" cy="250" rx="26" ry="16" fill="#fbf7f2"/>`;
    s += `<circle cx="${ex}" cy="250" r="13" fill="url(#iris)"/>`;
    s += `<circle cx="${ex}" cy="250" r="6" fill="#1a1414"/>`;
    s += `<circle cx="${ex - 4}" cy="246" r="3" fill="#fff" opacity="0.9"/>`;
    s += `<path d="M${ex - 26} 250 q26 -22 52 0" stroke="#3a2418" stroke-width="3" fill="none"/>`;
  }
  s += `<path d="M184 222 q28 -14 54 -2" stroke="#3a2418" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  s += `<path d="M274 220 q28 -12 54 2" stroke="#3a2418" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  // nose with soft shadow
  s += `<path d="M256 256 q-14 30 -6 44 q10 8 24 2" stroke="#c98a5e" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  // lips
  s += `<path d="M222 330 q34 22 68 0 q-34 30 -68 0 Z" fill="#cd6b5a"/>`;
  s += `<path d="M222 330 q34 -10 68 0" stroke="#a4493c" stroke-width="3" fill="none"/>`;
  // hair front
  s += `<path d="M138 256 q4 -140 118 -144 q40 60 -10 96 q-60 -40 -108 48 Z" fill="url(#hair)"/>`;
  s += `<path d="M374 256 q-4 -140 -118 -144 q-40 60 10 96 q60 -40 108 48 Z" fill="url(#hair)"/>`;
  return s;
}

// --- flat world-map-ish illustration: ocean + abstract landmasses ----------
function worldMap() {
  const ocean = '#a9d6e5', land = '#74c69d', land2 = '#52b788', sand = '#e9d8a6';
  let s = `<rect width="${S}" height="${S}" fill="${ocean}"/>`;
  // faint lat/long grid
  for (let g = 1; g < 6; g++) {
    const p = (S / 6) * g;
    s += `<line x1="${p}" y1="0" x2="${p}" y2="${S}" stroke="#cdeaf2" stroke-width="2"/>`;
    s += `<line x1="0" y1="${p}" x2="${S}" y2="${p}" stroke="#cdeaf2" stroke-width="2"/>`;
  }
  // blobby continents (deterministic control points)
  const blob = (pts, fill) => `<path d="M${pts.map(p => p.join(' ')).join(' L')} Z" fill="${fill}"/>`;
  s += blob([[60, 120], [150, 80], [210, 140], [180, 230], [110, 250], [50, 200]], land);
  s += blob([[250, 60], [360, 90], [420, 170], [360, 230], [280, 200], [240, 130]], land2);
  s += blob([[120, 300], [220, 290], [260, 360], [200, 450], [110, 440], [70, 370]], land);
  s += blob([[300, 300], [430, 320], [460, 410], [380, 470], [300, 430], [290, 360]], land2);
  // little islands
  const r = lcg(7);
  for (let i = 0; i < 8; i++) {
    const x = 40 + r() * 432, y = 40 + r() * 432, rad = 8 + r() * 14;
    s += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${rad.toFixed(0)}" fill="${sand}"/>`;
  }
  // compass rose
  s += `<g transform="translate(440 440)"><circle r="34" fill="#fff" opacity="0.85"/><polygon points="0,-28 7,0 0,28 -7,0" fill="#ef476f"/><polygon points="-28,0 0,-7 28,0 0,7" fill="#118ab2"/></g>`;
  return s;
}

// --- glossy sticker / emoji: smiley with a thick die-cut border ------------
function sticker() {
  const defs = `<defs>
    <radialGradient id="face" cx="42%" cy="35%" r="75%">
      <stop offset="0%" stop-color="#fff3b0"/><stop offset="55%" stop-color="#ffd23f"/><stop offset="100%" stop-color="#f0a500"/>
    </radialGradient>
    <radialGradient id="gloss" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>`;
  let s = defs + `<rect width="${S}" height="${S}" fill="#ff6b6b"/>`;
  // die-cut white border ring then face
  s += `<circle cx="256" cy="256" r="210" fill="#ffffff"/>`;
  s += `<circle cx="256" cy="256" r="186" fill="url(#face)"/>`;
  // eyes
  s += `<ellipse cx="196" cy="226" rx="26" ry="34" fill="#3a2c00"/>`;
  s += `<ellipse cx="316" cy="226" rx="26" ry="34" fill="#3a2c00"/>`;
  s += `<circle cx="188" cy="214" r="9" fill="#fff"/><circle cx="308" cy="214" r="9" fill="#fff"/>`;
  // big smile
  s += `<path d="M168 300 q88 110 176 0 q-88 50 -176 0 Z" fill="#7a1f1f"/>`;
  s += `<path d="M180 308 q76 40 152 0" fill="#ff8fa3"/>`;
  // gloss highlight
  s += `<ellipse cx="206" cy="170" rx="86" ry="54" fill="url(#gloss)"/>`;
  // tiny sparkles
  for (const [x, y, r] of [[392, 150, 10], [120, 330, 8], [380, 360, 7]])
    s += star(x, y, r * 2, r * 0.8, 4, '#fff');
  return s;
}

const gallery = {
  'icon-set': iconSet(),
  'bar-chart': barChart(),
  'comic-char': comicChar(),
  'soft-face': softFace(),
  'world-map': worldMap(),
  sticker: sticker(),
};

async function build() {
  for (const [name, body] of Object.entries(gallery)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${body}</svg>`;
    const out = join(fixturesDir, `${name}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    copyFileSync(out, join(samplesDir, `${name}.png`));
    console.log('wrote', name);
  }
  console.log('\ngallery ->', fixturesDir, '(mirrored to web/samples)');
}

async function convertSamples(names) {
  console.log('\n--- conversion check (quality: balanced) ---');
  for (const name of names) {
    const file = join(fixturesDir, `${name}.png`);
    const t0 = Date.now();
    const { analysis, metrics } = await convertImage(file, { quality: 'balanced' });
    console.log(
      `${name.padEnd(11)} type=${analysis.type.padEnd(12)} dssim=${metrics.finalDssim.toFixed(4)} ` +
      `colors=${analysis.colors} bytes=${metrics.finalBytes} (${Date.now() - t0}ms)`,
    );
  }
}

await build();

// Convert whichever samples were requested; default to a representative trio.
const requested = process.argv.slice(2).filter(a => gallery[a]);
const toConvert = requested.length ? requested : ['icon-set', 'comic-char', 'soft-face'];
await convertSamples(toConvert);
