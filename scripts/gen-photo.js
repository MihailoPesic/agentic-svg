// A large, complex, photographic-ish landscape to stress photo handling:
// gradient sky, sun glow, layered mountains with shading, textured foreground.
import sharp from 'sharp';
const W=1280,H=800; let seed=7; const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
let s=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
s+=`<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1b3a6b"/><stop offset="45%" stop-color="#6e7fa6"/><stop offset="70%" stop-color="#e6a86b"/><stop offset="100%" stop-color="#f4d9a6"/></linearGradient>
<radialGradient id="sun" cx="72%" cy="34%" r="22%"><stop offset="0%" stop-color="#fff6e0"/><stop offset="100%" stop-color="#fff6e000"/></radialGradient>
<linearGradient id="m1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5a6b86"/><stop offset="100%" stop-color="#33405a"/></linearGradient>
<linearGradient id="m2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3e5236"/><stop offset="100%" stop-color="#22301c"/></linearGradient>
<linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2e3a22"/><stop offset="100%" stop-color="#10160c"/></linearGradient>
</defs>`;
s+=`<rect width="${W}" height="${H}" fill="url(#sky)"/><circle cx="${0.72*W}" cy="${0.34*H}" r="${0.32*W}" fill="url(#sun)"/>`;
// distant mountains
s+=`<path d="M0 420 L180 300 L360 380 L560 250 L760 360 L980 270 L1180 350 L1280 320 L1280 800 L0 800 Z" fill="url(#m1)"/>`;
s+=`<path d="M0 520 L220 430 L430 500 L640 400 L900 490 L1120 420 L1280 470 L1280 800 L0 800 Z" fill="url(#m2)"/>`;
// foreground hills
s+=`<path d="M0 600 L300 540 L650 610 L1000 550 L1280 600 L1280 800 L0 800 Z" fill="url(#fg)"/>`;
// scattered trees / texture in foreground
for(let i=0;i<260;i++){const x=rnd()*W,y=560+rnd()*220,r=2+rnd()*5;const g=20+rnd()*40;s+=`<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="rgb(${(20+g).toFixed(0)},${(40+g).toFixed(0)},${(18+g/2).toFixed(0)})"/>`;}
// a few birds
for(let i=0;i<6;i++){const x=200+rnd()*700,y=120+rnd()*120;s+=`<path d="M${x} ${y} q8 -6 16 0 q8 -6 16 0" stroke="#22303f" stroke-width="2" fill="none"/>`;}
s+=`</svg>`;
await sharp(Buffer.from(s)).png().toFile('fixtures/photo.png');
console.log('wrote fixtures/photo.png', W+'x'+H);
