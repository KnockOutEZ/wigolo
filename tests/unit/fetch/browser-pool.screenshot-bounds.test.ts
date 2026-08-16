import { describe, it, expect, vi } from 'vitest';
import {
  captureBoundedScreenshot,
  MAX_SHOT_PX,
  MAX_SHOT_B64_BYTES,
} from '../../../src/fetch/browser-pool.js';

/**
 * WHY these bounds exist, measured rather than assumed.
 *
 * The capture used to be `page.screenshot({ fullPage: true })` with no dimension cap
 * and no byte cap, on a response where every other auxiliary field IS budgeted
 * (`capAuxFields` in src/tools/fetch.ts clips links/images). Measured live at the
 * pool's 1280x720 viewport:
 *
 *   en.wikipedia.org/wiki/World_War_II  59,358px tall -> 27,298,952 b64 bytes
 *   nodejs.org/api/fs.html             153,311px tall -> 23,600,496 b64 bytes
 *   viewport-only equivalents                         ->    390,372 / 122,684
 *
 * Page height — which the PAGE controls — was the sole size determinant.
 *
 * The byte cap is DERIVED from the clamp (MAX_SHOT_PX^2 x bytes/px), not chosen beside
 * it: an independent cap contradicts the clamp by refusing captures the clamp admits.
 * A flat 16 MiB did exactly that — flickr.com/explore was delivered on a 4K window but
 * refused on a 5K iMac, a Pro Display XDR, and at 4096x4096.
 *
 * The bytes/px budget is anchored to the INCOMPRESSIBLE CEILING (PNG cannot beat raw
 * storage, base64 expands 4/3) rather than to a sample maximum. That ceiling is
 * ENGINE-dependent: ~4.0 on Chromium (RGB) but ~5.33 on firefox/webkit (RGBA), both of
 * which WIGOLO_BROWSER_TYPES can select, so 5.33 is the one that binds.
 * Sample-derived constants failed three times, always because the sample set was
 * thumbnail GRIDS — which downscale, and downscaling is a low-pass filter. A full-bleed
 * hero photograph reaches 2.036 bytes/px at an ordinary 2560x1440 window, above the 2.0
 * a grid-derived constant would have set.
 */

type ShotOpts = {
  type?: string;
  scale?: string;
  fullPage?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
};

function fakePage(opts: {
  viewport?: { width: number; height: number } | null;
  innerSize?: { width: number; height: number };
  bytes?: number;
  throws?: boolean;
  omitViewportSize?: boolean;
}) {
  const calls: ShotOpts[] = [];
  const page: Record<string, unknown> = {
    screenshot: vi.fn(async (o?: ShotOpts) => {
      calls.push(o ?? {});
      if (opts.throws) throw new Error('page closed');
      return Buffer.alloc(Math.floor(((opts.bytes ?? 1024) * 3) / 4));
    }),
  };
  if (!opts.omitViewportSize) {
    page.viewportSize = () => opts.viewport ?? null;
  }
  if (opts.innerSize) {
    page.evaluate = async () => ({ width: opts.innerSize!.width, height: opts.innerSize!.height });
  }
  return { page: page as unknown as Parameters<typeof captureBoundedScreenshot>[0], calls };
}

describe('screenshot response bounds', () => {
  // --- Bound 1: viewport, never fullPage -------------------------------------------
  it('never requests a fullPage capture — page height must not determine payload size', async () => {
    const { page, calls } = fakePage({ viewport: { width: 1280, height: 720 } });
    await captureBoundedScreenshot(page);
    expect(calls).toHaveLength(1);
    expect(calls[0].fullPage).toBeFalsy();
  });

  it('captures PNG in CSS pixels so a HiDPI window cannot quadruple the payload', async () => {
    // Measured: the same astrophotograph is 4,096,696 bytes at dpr 2 and 1,532,700
    // with css scaling. Without this the dpr multiplier is invisible and uncapped.
    const { page, calls } = fakePage({ viewport: { width: 1280, height: 720 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].type).toBe('png');
    expect(calls[0].scale).toBe('css');
  });

  // --- Bound 2: the 4096px clamp ---------------------------------------------------
  it('clamps an oversized viewport to MAX_SHOT_PX on both axes', async () => {
    const { page, calls } = fakePage({ viewport: { width: 20000, height: 9000 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].clip).toEqual({ x: 0, y: 0, width: MAX_SHOT_PX, height: MAX_SHOT_PX });
  });

  it('clamps only the axis that exceeds the cap', async () => {
    const { page, calls } = fakePage({ viewport: { width: 9000, height: 800 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].clip).toEqual({ x: 0, y: 0, width: MAX_SHOT_PX, height: 800 });
  });

  it('clamps a CDP-adopted context, where viewportSize() reports null', async () => {
    // THE regression this bound exists for. Playwright returns null for a context it
    // does not own — measured null on 9/9 CDP-adopted contexts — so a clamp keyed only
    // on viewportSize() is dead code on the one path its docstring cites. The DOM read
    // is what makes it fire.
    const { page, calls } = fakePage({ viewport: null, innerSize: { width: 8000, height: 5000 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].clip).toEqual({ x: 0, y: 0, width: MAX_SHOT_PX, height: MAX_SHOT_PX });
  });

  it('does not clip a normal-sized CDP-adopted context (must-not-fire control)', async () => {
    // A 2560x1440 attached window is inside the clamp and must be captured whole.
    const { page, calls } = fakePage({ viewport: null, innerSize: { width: 2560, height: 1440 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].clip).toBeUndefined();
  });

  it('prefers the owned viewport over the DOM read when both are available', async () => {
    const { page, calls } = fakePage({
      viewport: { width: 1280, height: 720 },
      innerSize: { width: 9000, height: 9000 },
    });
    await captureBoundedScreenshot(page);
    expect(calls[0].clip).toBeUndefined();
  });

  it('does NOT synthesise a clip for a normal viewport (must-not-fire control)', async () => {
    const { page, calls } = fakePage({ viewport: { width: 1280, height: 720 } });
    const out = await captureBoundedScreenshot(page);
    expect(calls[0].clip).toBeUndefined();
    expect(out.ok).toBe(true);
  });

  // --- Bound 3: the byte cap -------------------------------------------------------
  it('refuses a capture that exceeds the byte cap, naming size_limit', async () => {
    const { page } = fakePage({
      viewport: { width: 1280, height: 720 },
      bytes: MAX_SHOT_B64_BYTES + 4096,
    });
    expect(await captureBoundedScreenshot(page)).toEqual({ ok: false, reason: 'size_limit' });
  });

  it('returns a capture that sits under the byte cap (must-not-fire control)', async () => {
    const { page } = fakePage({ viewport: { width: 1280, height: 720 }, bytes: 400_000 });
    const out = await captureBoundedScreenshot(page);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.base64.length).toBeLessThanOrEqual(MAX_SHOT_B64_BYTES);
  });

  it('derives the byte cap FROM the clamp, so the two bounds cannot contradict', () => {
    // The bug this encodes: the clamp and the cap were chosen independently, and a flat
    // 16 MiB refused captures the clamp explicitly admits. Measured live, flickr.com/
    // explore was DELIVERED on a 4K window but REFUSED on a 5K iMac, a Pro Display XDR,
    // and at the clamp's own 4096x4096 ceiling. Tying the cap to MAX_SHOT_PX means
    // raising the clamp raises the cap with it.
    expect(MAX_SHOT_B64_BYTES).toBe(MAX_SHOT_PX * MAX_SHOT_PX * 3);
  });

  it('sets the density budget as a fraction of the ENGINE-AGNOSTIC incompressible ceiling', () => {
    // The anchor is arithmetic, not a sample: PNG cannot beat raw storage and base64
    // expands 4/3. But the raw form is ENGINE-dependent and the pool is not
    // Chromium-only — WIGOLO_BROWSER_TYPES accepts firefox and webkit, which emit
    // colorType 6 (RGBA, 4 B/px) where Chromium emits colorType 2 (RGB, 3 B/px).
    // Measured on one identical noise canvas: chromium 3.975, firefox 4.598,
    // webkit 4.590. So the ceiling that binds is the RGBA one, 4 * 4/3 = 5.33 — a
    // Chromium-only 4.0 would understate it by a third.
    const INCOMPRESSIBLE_CEILING = 4 * (4 / 3); // RGBA, the worst engine
    const budget = MAX_SHOT_B64_BYTES / (MAX_SHOT_PX * MAX_SHOT_PX);
    expect(budget).toBeLessThan(INCOMPRESSIBLE_CEILING);
    expect(budget / INCOMPRESSIBLE_CEILING).toBeCloseTo(0.5625, 3);
  });

  it('refuses a payload bomb on the WORST engine, not just the default one', () => {
    // Why the cap stands at 48 MiB despite the ceiling being higher than first stated:
    // a full 4096x4096 noise capture on an RGBA engine is ~77 MB, still far over.
    const worstEngineNoiseBytesPerPx = 4.59; // webkit/firefox, measured
    expect(MAX_SHOT_B64_BYTES).toBeLessThan(MAX_SHOT_PX * MAX_SHOT_PX * worstEngineNoiseBytesPerPx);
  });

  it('admits a FULL-BLEED hero photograph, not just thumbnail grids', () => {
    // The bias that broke the previous constant: every early sample was a thumbnail
    // GRID, and browser downscaling is a low-pass filter, so grids compress well
    // (densest live grid: wallhaven 1.526). One full-resolution photo rendered
    // edge-to-edge measured 2.036 bytes/px at an ORDINARY 2560x1440 window and 2.372 at
    // the clamp ceiling — so a 2.0 budget refused an everyday hero image.
    const heroAtCeilingBytesPerPx = 2.372;
    expect(MAX_SHOT_B64_BYTES).toBeGreaterThan(MAX_SHOT_PX * MAX_SHOT_PX * heroAtCeilingBytesPerPx);
  });

  it('still refuses an incompressible payload on the DEFAULT engine', () => {
    // Chromium (RGB): 3.975 bytes/px measured on a 4096x4096 noise canvas (66,683,224
    // total; independently reproduced at 67,134,896 via a zlib encode). The RGBA engines
    // are covered separately — they are denser, so this is the tighter of the two.
    const chromiumNoiseBytesPerPx = 3.975;
    expect(MAX_SHOT_B64_BYTES).toBeLessThan(MAX_SHOT_PX * MAX_SHOT_PX * chromiumNoiseBytesPerPx);
  });

  // --- Fail-as-data: a refusal is reportable, never silent, never a failed fetch -----
  it('reports a failed capture as capture_failed rather than throwing', async () => {
    const { page } = fakePage({ viewport: { width: 1280, height: 720 }, throws: true });
    await expect(captureBoundedScreenshot(page)).resolves.toEqual({
      ok: false,
      reason: 'capture_failed',
    });
  });

  it('distinguishes a too-big capture from a broken one', async () => {
    // The caller branches differently: size_limit is retryable with a smaller window,
    // capture_failed is not. Collapsing both to "absent" destroys that distinction.
    const big = await captureBoundedScreenshot(
      fakePage({ viewport: { width: 1280, height: 720 }, bytes: MAX_SHOT_B64_BYTES + 1024 }).page,
    );
    const broken = await captureBoundedScreenshot(
      fakePage({ viewport: { width: 1280, height: 720 }, throws: true }).page,
    );
    expect(big).not.toEqual(broken);
  });

  it('still captures when the page cannot report a viewport at all', async () => {
    // Two existing suites drive the pool with a page-like object that has no
    // `viewportSize`. Reading it unguarded turned a screenshot request into a FAILED
    // FETCH — the clamp must degrade to "no clip", never take the fetch down.
    const { page, calls } = fakePage({ omitViewportSize: true });
    const out = await captureBoundedScreenshot(page);
    expect(out.ok).toBe(true);
    expect(calls[0].clip).toBeUndefined();
  });

  it('does not let a throwing viewportSize fail the capture', async () => {
    const screenshot = vi.fn(async () => Buffer.alloc(768));
    const page = {
      screenshot,
      viewportSize: () => {
        throw new Error('target closed');
      },
    } as unknown as Parameters<typeof captureBoundedScreenshot>[0];
    expect((await captureBoundedScreenshot(page)).ok).toBe(true);
  });

  it('does not let a throwing evaluate fail the capture', async () => {
    const screenshot = vi.fn(async () => Buffer.alloc(768));
    const page = {
      screenshot,
      viewportSize: () => null,
      evaluate: async () => {
        throw new Error('execution context destroyed');
      },
    } as unknown as Parameters<typeof captureBoundedScreenshot>[0];
    expect((await captureBoundedScreenshot(page)).ok).toBe(true);
  });

  it('ignores a garbage DOM viewport read', async () => {
    const screenshot = vi.fn(async () => Buffer.alloc(768));
    const page = {
      screenshot,
      viewportSize: () => null,
      evaluate: async () => ({ width: 'wide', height: null }),
    } as unknown as Parameters<typeof captureBoundedScreenshot>[0];
    const out = await captureBoundedScreenshot(page);
    expect(out.ok).toBe(true);
  });
});
