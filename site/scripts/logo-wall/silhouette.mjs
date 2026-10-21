// Turn any raster logo into a black glyph on transparent, cropped to its
// bounds. The site renders every logo as a CSS mask filled with the text
// colour, so a white-background PNG, a coloured tile and a transparent icon
// all end up in the same monochrome treatment as the SVG logos.

const cornerSamples = (data, w, h) => {
  const at = (x, y) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2], data[i + 3]];
  };
  return [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)];
};

/** Background = the corner colour, or "transparent" when the corners are. */
export function detectBackground(data, w, h) {
  const corners = cornerSamples(data, w, h);
  if (corners.every((c) => c[3] < 16)) return null;
  const avg = [0, 1, 2].map((k) => corners.reduce((s, c) => s + c[k], 0) / corners.length);
  return avg;
}

/**
 * RGBA in, RGBA out (same size). Alpha of the result is the glyph coverage:
 * the source alpha when the background is transparent, otherwise the colour
 * distance from the background (so light-on-dark tiles and dark-on-white
 * marks both come out as the mark itself).
 */
export function toSilhouette(data, w, h) {
  const bg = detectBackground(data, w, h);
  const out = new Uint8Array(w * h * 4);
  // A full-scale RGB distance (black vs white) is ~441; 160 already reads as
  // "clearly not background" for anti-aliased edges.
  const FULL = 160;
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    let coverage;
    if (!bg) {
      coverage = a / 255;
    } else {
      const d = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
      coverage = Math.min(1, d / FULL) * (a / 255);
    }
    out[i * 4 + 3] = Math.round(coverage * 255);
  }
  return out;
}

/** Bounding box of pixels with alpha above `threshold`, or null when empty. */
export function alphaBounds(data, w, h, threshold = 24) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function crop(data, w, box) {
  const out = new Uint8Array(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    const src = ((box.y + y) * w + box.x) * 4;
    out.set(data.subarray(src, src + box.w * 4), y * box.w * 4);
  }
  return out;
}
