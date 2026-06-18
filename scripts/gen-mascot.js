// A demonstrative fixture for saliency: a crisp central face emblem (small,
// perceptually-critical features) on a busy noise background. Without saliency
// weighting, error-targeted refinement wastes shapes on the noisy background;
// with it, the face stays crisp.
import sharp from 'sharp';

const W = 512, H = 512;
let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pal = ['#3a506b', '#5bc0be', '#6fffe9', '#1c2541', '#0b132b', '#e0a96d', '#c44536', '#283845'];

let r = '';
const t = 16;
for (let y = 0; y < H; y += t) {
  for (let x = 0; x < W; x += t) {
    const c = pal[Math.floor(rand() * pal.length)];
    r += `<rect x="${x}" y="${y}" width="${t}" height="${t}" fill="${c}"/>`;
  }
}
// central subject: face with small critical details (eyes, brows, smile)
r += '<circle cx="256" cy="256" r="120" fill="#ffd6a5"/>';
r += '<circle cx="256" cy="256" r="120" fill="none" stroke="#7a4a2b" stroke-width="6"/>';
r += '<ellipse cx="214" cy="232" rx="18" ry="24" fill="#ffffff"/><circle cx="214" cy="236" r="9" fill="#1c1c1c"/>';
r += '<ellipse cx="298" cy="232" rx="18" ry="24" fill="#ffffff"/><circle cx="298" cy="236" r="9" fill="#1c1c1c"/>';
r += '<path d="M214 200 q14 -16 36 -6" stroke="#7a4a2b" stroke-width="6" fill="none"/>';
r += '<path d="M262 194 q22 -10 36 6" stroke="#7a4a2b" stroke-width="6" fill="none"/>';
r += '<path d="M212 300 q44 40 88 0" stroke="#c44536" stroke-width="8" fill="none"/>';
r += '<circle cx="256" cy="276" r="10" fill="#e09a78"/>';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${r}</svg>`;
await sharp(Buffer.from(svg)).png().toFile('fixtures/mascot.png');
console.log('wrote fixtures/mascot.png');
