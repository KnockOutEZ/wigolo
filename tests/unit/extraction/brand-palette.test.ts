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

/**
 * Sharp decode-options hardening (PR #72 security review).
 *
 * The default sharp call shape was `sharp(buffer, { failOn: 'none' })` —
 * which leaves multi-frame / animated images decoding their full frame
 * stack (memory amplification) and accepts arbitrarily large input
 * resolutions (pixel-bomb amplification, libvips default cap is 0x7FFF^2
 * ≈ 1B pixels).
 *
 * The fix pins:
 *   - `pages: 1` + `animated: false` — only the first frame of a GIF/
 *     WebP/AVIF animation is decoded; remaining frames cost nothing.
 *   - `limitInputPixels: 50_000_000` — 50M pixels is comfortably above
 *     the 5000×10000 case any real logo could need, well below the
 *     pixel-bomb threshold a malicious server might serve.
 */
describe('extractPaletteFromBuffer — sharp options hardening', () => {
  it('only decodes frame 1 of a multi-frame GIF — frame 2 pixels must not leak into palette', async () => {
    // Construct a real 2-frame GIF89a: 16×16 canvas, global palette
    // [red=(220,30,30), blue=(30,30,220)]. Frame 1 = all palette idx 0
    // (red), Frame 2 = all palette idx 1 (blue).
    //
    // Why this is the right shape: when `animated: true` is enabled,
    // sharp returns a buffer of height H×N (frames stacked vertically),
    // exposing pixels from every frame to k-means. The palette then
    // contains blue. With our pinned `pages: 1, animated: false`, only
    // frame 1 pixels are exposed — palette must contain red and MUST
    // NOT contain blue. We verified this test fails when the opts are
    // reverted; it is load-bearing.
    function lzwEncode(indices: number[], codeSize: number): number[] {
      const clear = 1 << codeSize;
      const eoi = clear + 1;
      const codes = [clear, ...indices, eoi];
      const bits = codeSize + 1;
      const buf: number[] = [];
      let cur = 0;
      let curBits = 0;
      for (const c of codes) {
        cur |= c << curBits;
        curBits += bits;
        while (curBits >= 8) {
          buf.push(cur & 0xff);
          cur >>= 8;
          curBits -= 8;
        }
      }
      if (curBits > 0) buf.push(cur & 0xff);
      return buf;
    }
    function subBlocks(data: number[]): number[] {
      const out: number[] = [];
      let i = 0;
      while (i < data.length) {
        const chunk = data.slice(i, i + 255);
        out.push(chunk.length, ...chunk);
        i += 255;
      }
      out.push(0);
      return out;
    }
    const w = 16;
    const h = 16;
    const n = w * h;
    const frame1 = lzwEncode(new Array(n).fill(0), 2);
    const frame2 = lzwEncode(new Array(n).fill(1), 2);
    const gif = Buffer.from([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
      w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff,
      0xf0, 0x00, 0x00,
      220, 30, 30,
      30, 30, 220,
      0x21, 0xff, 0x0b,
      0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
      0x03, 0x01, 0x00, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x64, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00,
      w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff, 0x00,
      0x02,
      ...subBlocks(frame1),
      0x21, 0xf9, 0x04, 0x00, 0x64, 0x00, 0x00, 0x00,
      0x2c, 0x00, 0x00, 0x00, 0x00,
      w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff, 0x00,
      0x02,
      ...subBlocks(frame2),
      0x3b,
    ]);

    // Sanity check that the GIF is truly multi-frame at the format
    // level — if the fixture broke, the rest of the assertion is moot.
    const meta = await sharp(gif).metadata();
    expect(meta.pages).toBe(2);

    const result = await extractPaletteFromBuffer(gif, 'image/gif');
    expect(result).not.toBeNull();
    const colors = result!.colors;
    // Dominant color must be red-family (frame 1).
    const dom = __internal.hexToRgb(colors[0])!;
    expect(dom.r).toBeGreaterThan(150);
    expect(dom.b).toBeLessThan(80);
    // Blue (frame 2) MUST NOT appear in any cluster. A blue cluster here
    // would indicate the decoder picked up frame 2 — the regression
    // class this test guards against.
    for (const hex of colors) {
      const rgb = __internal.hexToRgb(hex)!;
      const isBlueDominant = rgb.b > 150 && rgb.b > rgb.r + 30;
      expect(isBlueDominant).toBe(false);
    }
  });

  it('rejects oversized pixel-bomb inputs (limitInputPixels guard)', async () => {
    // sharp's default `limitInputPixels` cap is ~1B; the brand extractor
    // ratchets it down to 50M. A buffer that declares a 10000×10000
    // canvas (100M pixels) must trigger sharp's input-pixel guard and
    // produce null. We construct via the `create` shape which writes a
    // proper PNG header sharp can read.
    //
    // The image bytes themselves are small (PNG compresses a solid
    // background extremely well), but the declared dimensions are over
    // the cap — the cap is dimension-based, not byte-based.
    let bomb: Buffer;
    try {
      bomb = await sharp({
        create: {
          width: 10000,
          height: 10000,
          channels: 3,
          background: { r: 128, g: 128, b: 128 },
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch {
      // Some sharp builds cap `create` independently. If we can't even
      // synthesize the bomb, the test is moot — skip.
      return;
    }
    // Buffer must be under MAX_IMAGE_BYTES so the byte-cap doesn't fire
    // first; we want to verify the pixel-cap path.
    if (bomb.length > MAX_IMAGE_BYTES) {
      // Could happen on some sharp builds. Document the choice and skip.
      return;
    }
    const result = await extractPaletteFromBuffer(bomb, 'image/png');
    expect(result).toBeNull();
  });
});
