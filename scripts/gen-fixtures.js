// Generate test images covering the cases that matter: flat logo, gradients,
// and a busier illustration. Rendered from SVG via sharp so they are crisp.
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
mkdirSync(dir, { recursive: true });

const fixtures = {
  logo: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <rect width="400" height="400" fill="#f4f1de"/>
    <circle cx="200" cy="170" r="110" fill="#e07a5f"/>
    <polygon points="200,70 290,250 110,250" fill="#3d405b"/>
    <rect x="150" y="250" width="100" height="90" fill="#81b29a"/>
    <circle cx="200" cy="170" r="45" fill="#f2cc8f"/>
  </svg>`,
  gradient: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <defs>
      <radialGradient id="g" cx="40%" cy="35%" r="75%">
        <stop offset="0%" stop-color="#ffd166"/>
        <stop offset="50%" stop-color="#ef476f"/>
        <stop offset="100%" stop-color="#073b4c"/>
      </radialGradient>
    </defs>
    <rect width="400" height="400" fill="url(#g)"/>
  </svg>`,
  scene: `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2b2d42"/>
        <stop offset="100%" stop-color="#ee9b00"/>
      </linearGradient>
    </defs>
    <rect width="400" height="400" fill="url(#sky)"/>
    <circle cx="300" cy="110" r="50" fill="#ffe8a3"/>
    <polygon points="0,300 120,180 240,300" fill="#264653"/>
    <polygon points="160,300 300,160 400,300" fill="#1d3557"/>
    <rect x="0" y="300" width="400" height="100" fill="#0b132b"/>
  </svg>`,
};

for (const [name, svg] of Object.entries(fixtures)) {
  await sharp(Buffer.from(svg)).png().toFile(join(dir, `${name}.png`));
  console.log('wrote', name);
}
console.log('fixtures in', dir);
