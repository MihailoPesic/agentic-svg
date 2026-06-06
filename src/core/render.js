// Render an SVG string to an RGBA buffer at a target size, via resvg-js.
// resvg is synchronous; for the inner loop we call it directly (a worker pool
// can be layered on later for parallel candidate evaluation).

import { Resvg } from '@resvg/resvg-js';

/**
 * @param {string} svg
 * @param {number} width   target raster width
 * @param {number} height  target raster height
 * @param {{r,g,b}} [background]  flatten transparent areas onto this color
 * @returns {{ width:number, height:number, data:Uint8ClampedArray }}
 */
export function renderSvgToRgba(svg, width, height, background = { r: 255, g: 255, b: 255 }) {
  const r = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: `rgb(${background.r},${background.g},${background.b})`,
    font: { loadSystemFonts: false }, // determinism: never silently fall back to a system font
  });
  const img = r.render();
  const px = img.pixels; // RGBA Uint8Array, premultiplied=false
  const data = new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength);
  // resvg renders at width with proportional height; assert/resample if needed.
  if (img.width === width && img.height === height) {
    return { width, height, data: new Uint8ClampedArray(data) };
  }
  // Nearest-neighbor resample to the exact requested HxW (rarely needed).
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
      const si = (sy * img.width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3];
    }
  }
  return { width, height, data: out };
}
