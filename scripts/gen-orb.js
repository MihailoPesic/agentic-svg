import sharp from 'sharp';
const W=512,H=512; let seed=999; const rand=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
const pal=['#3a506b','#5bc0be','#1c2541','#0b132b','#e0a96d','#c44536'];
let r=''; const t=14;
for(let y=0;y<H;y+=t)for(let x=0;x<W;x+=t){r+=`<rect x="${x}" y="${y}" width="${t}" height="${t}" fill="${pal[Math.floor(rand()*pal.length)]}"/>`;}
// smoothly shaded orb (trace flattens this -> refinement recovers it)
const defs='<defs><radialGradient id="o" cx="38%" cy="32%" r="75%"><stop offset="0%" stop-color="#fff6e0"/><stop offset="35%" stop-color="#ffb703"/><stop offset="75%" stop-color="#fb5607"/><stop offset="100%" stop-color="#6a040f"/></radialGradient></defs>';
r+='<circle cx="256" cy="256" r="130" fill="url(#o)"/>';
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${defs}${r}</svg>`;
await sharp(Buffer.from(svg)).png().toFile('fixtures/orb.png');
console.log('wrote fixtures/orb.png');
