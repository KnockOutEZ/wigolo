import { test } from "node:test";
import assert from "node:assert/strict";
import { toSilhouette, alphaBounds, crop, detectBackground } from "./silhouette.mjs";

// 4×4 image: `fill` everywhere, `mark` on the centre 2×2.
function image(fill, mark) {
  const d = new Uint8Array(16 * 4);
  for (let i = 0; i < 16; i++) {
    const x = i % 4;
    const y = Math.floor(i / 4);
    const c = x >= 1 && x <= 2 && y >= 1 && y <= 2 ? mark : fill;
    d.set(c, i * 4);
  }
  return d;
}
const alphaAt = (d, x, y) => d[(y * 4 + x) * 4 + 3];

test("dark mark on white: the mark is kept and the white background disappears", () => {
  const s = toSilhouette(image([255, 255, 255, 255], [0, 0, 0, 255]), 4, 4);
  assert.equal(alphaAt(s, 0, 0), 0);
  assert.equal(alphaAt(s, 1, 1), 255);
});

test("light text on a coloured tile: the text is kept, not the tile", () => {
  // Without this the Tencent tile would render as a solid grey square.
  const s = toSilhouette(image([0, 82, 217, 255], [255, 255, 255, 255]), 4, 4);
  assert.equal(alphaAt(s, 0, 0), 0);
  assert.equal(alphaAt(s, 2, 2), 255);
});

test("transparent icon: source alpha is the glyph", () => {
  const src = image([0, 0, 0, 0], [240, 80, 30, 255]);
  assert.equal(detectBackground(src, 4, 4), null);
  const s = toSilhouette(src, 4, 4);
  assert.equal(alphaAt(s, 0, 0), 0);
  assert.equal(alphaAt(s, 1, 2), 255);
});

test("cropping trims padding so every logo sizes by its glyph, not its canvas", () => {
  const s = toSilhouette(image([255, 255, 255, 255], [0, 0, 0, 255]), 4, 4);
  const box = alphaBounds(s, 4, 4);
  assert.deepEqual(box, { x: 1, y: 1, w: 2, h: 2 });
  const c = crop(s, 4, box);
  assert.equal(c.length, 2 * 2 * 4);
  assert.ok([...c].filter((_, i) => i % 4 === 3).every((a) => a === 255));
});

test("an image that is all background has no bounds", () => {
  const s = toSilhouette(image([255, 255, 255, 255], [255, 255, 255, 255]), 4, 4);
  assert.equal(alphaBounds(s, 4, 4), null);
});
