// Image loading / resizing / saving as flat RGBA buffers.
// We keep everything as a simple { width, height, data } where data is a
// Uint8ClampedArray of length width*height*4 (RGBA, fully opaque).

import sharp from 'sharp';

/** @typedef {{ width:number, height:number, data:Uint8ClampedArray }} RGBAImage */

/**
 * Decode any image file/buffer into an RGBA buffer, optionally resized so its
 * longest side is `maxSize` (keeps aspect ratio). Background-flattened to opaque.
 * @returns {Promise<RGBAImage>}
 */
export async function loadImage(input, { maxSize = 0, allowEnlarge = false, background = { r: 255, g: 255, b: 255 } } = {}) {
  let pipeline = sharp(input).flatten({ background }); // flatten alpha onto bg -> opaque
  if (maxSize > 0) {
    // allowEnlarge upsamples small images so the tracer has more pixels per
    // glyph/edge — the difference between readable and smudged text.
    pipeline = pipeline.resize(maxSize, maxSize, { fit: 'inside', withoutEnlargement: !allowEnlarge, kernel: 'cubic' });
  }
  const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
}

/** Compute the average color of an image (used for the SVG background fill). */
export function averageColor(img) {
  const { data } = img;
  let r = 0, g = 0, b = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) };
}

/** Create a solid-color RGBA image. */
export function solidImage(width, height, { r, g, b }) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
  }
  return { width, height, data };
}

/** Encode an RGBA buffer to a PNG buffer. */
export async function toPng(img) {
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  }).png().toBuffer();
}
