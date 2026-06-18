// A UI-screenshot fixture: flat window chrome + small high-contrast text +
// controls. This is the hardest case for vectorize+refine (text + flat fills),
// and the one that exposes oversized-shape artifacts.
import sharp from 'sharp';

const W = 640, H = 420;
const rows = [
  'Blackmagic RAW Player', 'Fairlight Audio Accelerator Utility', 'Pre Installation Cleanup',
  'DaVinci Resolve 20.3.2.0009', 'Visual C++ 2015-2022 x64 Redistributable', 'Visual C++ 2015-2022 x86 Redistributable',
];
let body = '';
rows.forEach((t, i) => {
  const y = 150 + i * 26;
  body += `<rect x="232" y="${y - 11}" width="13" height="13" rx="2" fill="#ffffff" stroke="#7a7a7a"/>`;
  if (i !== 1) body += `<path d="M234 ${y - 5} l3 4 l6 -8" stroke="#2b7fff" stroke-width="2" fill="none"/>`;
  body += `<text x="252" y="${y}" font-family="Segoe UI, sans-serif" font-size="13" fill="#1a1a1a">${t}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="#3b4a5a"/>
  <rect x="60" y="40" width="520" height="340" rx="6" fill="#f0f0f0" stroke="#d0d0d0"/>
  <rect x="60" y="40" width="520" height="34" rx="6" fill="#ffffff"/>
  <text x="84" y="62" font-family="Segoe UI, sans-serif" font-size="13" fill="#222">DaVinci Resolve Installer</text>
  <text x="540" y="62" font-family="Segoe UI, sans-serif" font-size="15" fill="#444">×</text>
  <rect x="84" y="120" width="120" height="120" rx="8" fill="#2b2f3a"/>
  <circle cx="144" cy="180" r="34" fill="none" stroke="#e85b4a" stroke-width="6"/>
  <circle cx="144" cy="180" r="16" fill="#3bb0d6"/>
  <text x="232" y="108" font-family="Segoe UI, sans-serif" font-size="13" fill="#222">In order to install Resolve you must install these components:</text>
  ${body}
  <rect x="430" y="330" width="64" height="26" rx="4" fill="#e8e8e8" stroke="#bbb"/>
  <text x="446" y="347" font-family="Segoe UI, sans-serif" font-size="12" fill="#222">Install</text>
  <rect x="500" y="330" width="64" height="26" rx="4" fill="#0a64d6"/>
  <text x="518" y="347" font-family="Segoe UI, sans-serif" font-size="12" fill="#fff">Close</text>
  <text x="84" y="368" font-family="Segoe UI, sans-serif" font-size="11" fill="#666">Windows 10 (x64)</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('fixtures/ui.png');
console.log('wrote fixtures/ui.png');
