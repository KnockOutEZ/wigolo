/**
 * The image decoder behind `extract mode: 'brand'` is a native module with
 * per-platform prebuilt binaries. It goes missing for real reasons — a musl or
 * arm64 gap, a blocked postinstall, a bundler that drops it from the packaged
 * binary.
 *
 * Before this was fixed the decoder was a TOP-LEVEL static import in
 * brand-palette.ts AND was not declared in package.json at all; it resolved
 * only because @huggingface/transformers requires it and npm hoisted it. That
 * combination is why the absent path matters: a top-level import means an
 * unresolvable decoder throws while the MODULE is being evaluated, so the
 * failure is not "no palette" — it is `extract` failing to load at all, taking
 * tables, metadata and schema extraction down with it.
 *
 * These tests pin the degrade: importing the module must never throw, and the
 * palette call must return null so the caller falls back to its `unknown`
 * provenance branch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const MODULE = '../../../src/extraction/brand-palette.js';

/** A one-pixel PNG — real bytes, so nothing short-circuits on validation. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('brand palette: image decoder absent', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('sharp');
    vi.resetModules();
  });

  it('imports the module without throwing when the decoder cannot resolve', async () => {
    vi.doMock('sharp', () => {
      throw new Error("Cannot find module 'sharp'");
    });

    // The assertion IS that this resolves. A static top-level import would
    // reject here, which is the regression this guards.
    const mod = await import(MODULE);
    expect(typeof mod.extractPaletteFromBuffer).toBe('function');
  });

  it('returns null instead of throwing when the decoder cannot resolve', async () => {
    vi.doMock('sharp', () => {
      throw new Error("Cannot find module 'sharp'");
    });

    const { extractPaletteFromBuffer } = await import(MODULE);
    await expect(
      extractPaletteFromBuffer(ONE_PIXEL_PNG, 'image/png'),
    ).resolves.toBeNull();
  });

  it('does not retry the failed resolution on every image', async () => {
    let attempts = 0;
    vi.doMock('sharp', () => {
      attempts += 1;
      throw new Error("Cannot find module 'sharp'");
    });

    const { extractPaletteFromBuffer } = await import(MODULE);
    await extractPaletteFromBuffer(ONE_PIXEL_PNG, 'image/png');
    await extractPaletteFromBuffer(ONE_PIXEL_PNG, 'image/png');
    await extractPaletteFromBuffer(ONE_PIXEL_PNG, 'image/png');

    // Memoized: a missing native binary costs one resolution attempt for the
    // life of the process, not one per image on a crawl of 500 pages.
    expect(attempts).toBe(1);
  });

  it('still produces a palette when the decoder is present', async () => {
    // Control: proves the three tests above fail for the reason claimed
    // (decoder missing) and not because the fixture or MIME gate rejects.
    const { extractPaletteFromBuffer } = await import(MODULE);
    const result = await extractPaletteFromBuffer(ONE_PIXEL_PNG, 'image/png');
    expect(result).not.toBeNull();
    expect(result!.colors.length).toBeGreaterThan(0);
  });
});
