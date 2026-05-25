/**
 * Slice B2b unit tests for `src/extraction/brand-palette.ts`.
 *
 * Why this matters:
 *   B2a returns CSS-var-sourced primary_colors when sites declare them in
 *   custom properties. Many real sites don't — they inline brand colors
 *   in compiled stylesheets, attribute styles, or only as raster bytes
 *   inside the logo. Without an image fallback, `mode: 'brand'` returns
 *   no colors at all on a meaningful fraction of the ecosystem and the
 *   downstream agent has no signal to work with.
 *
 *   These tests pin the contract for the image-extraction path:
 *     - quantization returns ≥2 perceptually-distinct colors when the
 *       source bitmap has them,
 *     - near-monochrome inputs (a logo that is mostly white) still
 *       surface the accent rather than dropping to a single color,
 *     - oversized payloads (>2MB) are rejected up front to enforce the
 *       2s round-trip budget,
 *     - decode failures are not allowed to crash the extractor; they
 *       must return null and let the caller fall back to provenance
 *       `'unknown'`.
 *
 *   Generating fixtures at runtime via sharp keeps the suite hermetic
 *   and avoids committing binary blobs that would obscure intent in
 *   code review. The colors used in each fixture are intentional and
 *   load-bearing — they are what the test asserts against.
 */
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  extractPaletteFromBuffer,
  MAX_IMAGE_BYTES,
  __internal,
} from '../../../src/extraction/brand-palette.js';

// Build a small PNG by tiling solid rectangles of known colors.
// `regions` is an array of `[r, g, b, weight]` where weight controls how
// many pixels of that color the image carries (proportional dominance).
async function makeTestPng(
  regions: Array<[number, number, number, number]>,
  size = 64,
): Promise<Buffer> {
  const totalWeight = regions.reduce((s, r) => s + r[3], 0);
  const totalPx = size * size;
  const data = Buffer.alloc(totalPx * 3);
  let cursor = 0;
  for (const [r, g, b, weight] of regions) {
    const count = Math.floor((weight / totalWeight) * totalPx);
    for (let i = 0; i < count; i++) {
      data[cursor++] = r;
      data[cursor++] = g;
      data[cursor++] = b;
    }
  }
  // Fill any remaining pixels with the last region's color so we don't
  // surface a zero-valued cluster.
  if (cursor < data.length) {
    const last = regions[regions.length - 1];
    while (cursor < data.length) {
      data[cursor++] = last[0];
      data[cursor++] = last[1];
      data[cursor++] = last[2];
    }
  }
  return sharp(data, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

describe('extractPaletteFromBuffer — happy path', () => {
  it('returns the two dominant colors of a two-region image as hex codes', async () => {
    // Stripe-purple + cyan accent, 70/30 split. We expect the dominant
    // cluster to be the purple. Both colors must surface — failure to
    // return ≥2 colors means the spec's "≥2 hex codes" contract broke.
    const png = await makeTestPng([
      [99, 91, 255, 70],
      [0, 212, 255, 30],
    ]);
    const result = await extractPaletteFromBuffer(png, 'image/png');
    expect(result).not.toBeNull();
    expect(result!.colors.length).toBeGreaterThanOrEqual(2);
    // First (dominant) hex should be the purple region. Allow small
    // quantization drift: compare in RGB space within tolerance.
    const dom = __internal.hexToRgb(result!.colors[0])!;
    expect(Math.abs(dom.r - 99)).toBeLessThanOrEqual(8);
    expect(Math.abs(dom.g - 91)).toBeLessThanOrEqual(8);
    expect(Math.abs(dom.b - 255)).toBeLessThanOrEqual(8);
  });

  it('returns the brand color even when white dominates the canvas', async () => {
    // Real logos are mostly white/transparent with a small brand mark.
    // Without filtering, k-means would surface only "#ffffff" and we'd
    // miss the actual brand color entirely.
    const png = await makeTestPng([
      [255, 255, 255, 90],
      [99, 91, 255, 10],
    ]);
    const result = await extractPaletteFromBuffer(png, 'image/png');
    expect(result).not.toBeNull();
    // After filtering near-white, the brand color must be present.
    const hexes = result!.colors;
    const hasBrand = hexes.some((h) => {
      const rgb = __internal.hexToRgb(h);
      return rgb && Math.abs(rgb.r - 99) <= 12 && Math.abs(rgb.g - 91) <= 12 && Math.abs(rgb.b - 255) <= 12;
    });
    expect(hasBrand).toBe(true);
  });

  it('returns the brand color even when black dominates the canvas', async () => {
    // Same regression — a logo on a dark background must not return
    // only "#000000".
    const png = await makeTestPng([
      [0, 0, 0, 90],
      [255, 100, 50, 10],
    ]);
    const result = await extractPaletteFromBuffer(png, 'image/png');
    expect(result).not.toBeNull();
    const hexes = result!.colors;
    const hasBrand = hexes.some((h) => {
      const rgb = __internal.hexToRgb(h);
      return rgb && Math.abs(rgb.r - 255) <= 20 && Math.abs(rgb.g - 100) <= 20 && Math.abs(rgb.b - 50) <= 20;
    });
    expect(hasBrand).toBe(true);
  });

  it('returns at least 2 colors on a 3-region image', async () => {
    const png = await makeTestPng([
      [200, 30, 30, 40], // red
      [30, 100, 200, 35], // blue
      [240, 200, 60, 25], // gold
    ]);
    const result = await extractPaletteFromBuffer(png, 'image/png');
    expect(result).not.toBeNull();
    expect(result!.colors.length).toBeGreaterThanOrEqual(2);
  });

  it('emits hex codes in #rrggbb form, lowercase, length 7', async () => {
    const png = await makeTestPng([
      [99, 91, 255, 60],
      [0, 212, 255, 40],
    ]);
    const result = await extractPaletteFromBuffer(png, 'image/png');
    expect(result).not.toBeNull();
    for (const hex of result!.colors) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('extractPaletteFromBuffer — input validation + downsampling', () => {
  it('rejects oversized buffers (>2MB) with null + log signal', async () => {
    // Hard cap on input bytes — the 2s round-trip budget is unforgiving.
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    const result = await extractPaletteFromBuffer(big, 'image/png');
    expect(result).toBeNull();
  });

  it('rejects SVG MIME types — palette algorithms expect raster data', async () => {
    // SVG bytes are XML, not pixels. Running k-means over them would
    // either crash or return garbage. We document the choice to reject
    // SVG up front rather than parse <fill> attrs — that's a separate
    // (smaller) optimization a future slice can add.
    const fakeSvg = Buffer.from('<svg><circle fill="#635bff"/></svg>');
    const result = await extractPaletteFromBuffer(fakeSvg, 'image/svg+xml');
    expect(result).toBeNull();
  });

  it('returns null on a corrupt/non-image buffer rather than throwing', async () => {
    // Decode failures must not crash the extractor. The caller's
    // contract is "I get null and I set provenance to unknown" — if
    // we throw here, the entire extract call dies.
    const corrupt = Buffer.from('not an image at all');
    const result = await extractPaletteFromBuffer(corrupt, 'image/png');
    expect(result).toBeNull();
  });

  it('downsamples large images before quantization (no crash on 2000x2000)', async () => {
    // The constraint says "operate on a downsampled bitmap — never run
    // k-means over a full 2000x2000 logo." We validate that the call
    // returns under our normal timeout budget even when given a big
    // canvas. The exact resize ratio is an implementation detail; we
    // only assert that the call completes and returns ≥2 colors.
    const big = await sharp({
      create: {
        width: 1500,
        height: 1500,
        channels: 3,
        background: { r: 99, g: 91, b: 255 },
      },
    })
      .composite([
        {
          input: {
            create: {
              width: 500,
              height: 500,
              channels: 3,
              background: { r: 0, g: 212, b: 255 },
            },
          },
          top: 0,
          left: 0,
        },
      ])
      .png()
      .toBuffer();
    const t0 = Date.now();
    const result = await extractPaletteFromBuffer(big, 'image/png');
    const elapsed = Date.now() - t0;
    expect(result).not.toBeNull();
    expect(result!.colors.length).toBeGreaterThanOrEqual(2);
    // Per-image budget. Total brand extraction ≤2s; the image step
    // alone must be comfortably under that.
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('extractPaletteFromBuffer — color quality heuristics', () => {
  it('filters out near-grey clusters when sufficient saturated alternatives exist', async () => {
    // Greys are rarely brand colors — they're chrome. When the bitmap
    // has both a saturated color and a grey, we should prefer the
    // saturated one in the dominant slot.
    const png = await makeTestPng([
      [128, 128, 128, 50], // pure grey
      [200, 30, 30, 50], // red
    ]);
    const result = await extractPaletteFromBuffer(png, 'image/png');
    expect(result).not.toBeNull();
    const dom = __internal.hexToRgb(result!.colors[0])!;
    // Dominant should be the red, not the grey. Use RGB-spread to
    // distinguish: high spread → saturated, low spread → grey.
    const spread = Math.max(dom.r, dom.g, dom.b) - Math.min(dom.r, dom.g, dom.b);
    expect(spread).toBeGreaterThan(50);
  });

  it('produces distinct hex codes (no duplicate clusters)', async () => {
    // Two clusters collapsing to the same hex would mean a useless
    // "palette" of `["#635bff", "#635bff"]` — the caller would assume
    // dual-tone branding when there is only one color.
    const png = await makeTestPng([
      [99, 91, 255, 50],
      [50, 200, 100, 50],
    ]);
    const result = await extractPaletteFromBuffer(png, 'image/png');
    expect(result).not.toBeNull();
    const unique = new Set(result!.colors);
    expect(unique.size).toBe(result!.colors.length);
  });
});

describe('hexToRgb / rgbToHex internals', () => {
  it('round-trips through hexToRgb and rgbToHex without loss', () => {
    const hex = '#635bff';
    const rgb = __internal.hexToRgb(hex)!;
    const back = __internal.rgbToHex(rgb.r, rgb.g, rgb.b);
    expect(back).toBe(hex);
  });

  it('clamps out-of-range RGB inputs to 00-ff hex bytes', () => {
    expect(__internal.rgbToHex(-10, 300, 128)).toBe('#00ff80');
  });
});
