import { describe, it, expect, vi } from 'vitest';
import {
  captureBoundedScreenshot,
  MAX_SHOT_PX,
  MAX_SHOT_B64_BYTES,
} from '../../../src/fetch/browser-pool.js';

/**
 * WHY these bounds exist, measured rather than assumed:
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
 * So page height — which the PAGE controls — was the sole size determinant. That is
 * the unbounded path. Capturing the viewport instead makes the size determined by OUR
 * viewport, not the page's length.
 *
 * The dimension clamp alone is NOT enough, which is why a byte cap sits on top: a
 * 4096x4096 incompressible-noise canvas measured 66,683,224 b64 bytes while fully
 * inside the clamp. Real pages rendered at that same 4096x4096 ceiling measured
 * 1,109,836 (MDN) and 2,431,388 (Wikipedia) bytes — hence a cap above realistic
 * content and far below a payload bomb.
 */

type ShotOpts = { type?: string; fullPage?: boolean; clip?: { x: number; y: number; width: number; height: number } };

function fakePage(opts: {
  viewport: { width: number; height: number } | null;
  bytes?: number;
  throws?: boolean;
}) {
  const calls: ShotOpts[] = [];
  const page = {
    viewportSize: () => opts.viewport,
    screenshot: vi.fn(async (o?: ShotOpts) => {
      calls.push(o ?? {});
      if (opts.throws) throw new Error('page closed');
      // Buffer of N raw bytes -> ceil(N/3)*4 base64 chars. Size the raw buffer so the
      // resulting base64 length lands where the test wants it.
      return Buffer.alloc(Math.floor(((opts.bytes ?? 1024) * 3) / 4));
    }),
  };
  return { page: page as unknown as Parameters<typeof captureBoundedScreenshot>[0], calls };
}

describe('screenshot response bounds', () => {
  // --- Bound 1: viewport, never fullPage -------------------------------------------
  it('never requests a fullPage capture — page height must not determine payload size', async () => {
    const { page, calls } = fakePage({ viewport: { width: 1280, height: 720 } });
    await captureBoundedScreenshot(page);
    expect(calls).toHaveLength(1);
    // `fullPage: true` is precisely what made a 59k-px article emit 27 MB.
    expect(calls[0].fullPage).toBeFalsy();
  });

  it('captures PNG', async () => {
    const { page, calls } = fakePage({ viewport: { width: 1280, height: 720 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].type).toBe('png');
  });

  // --- Bound 2: the 4096px clamp ---------------------------------------------------
  it('clamps an oversized viewport to MAX_SHOT_PX on both axes', async () => {
    // The CDP-attach path adopts an EXTERNAL browser's context, so the viewport is not
    // ours to trust. A 20000x9000 context must not rasterise at 20000x9000.
    const { page, calls } = fakePage({ viewport: { width: 20000, height: 9000 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].clip).toEqual({ x: 0, y: 0, width: MAX_SHOT_PX, height: MAX_SHOT_PX });
  });

  it('clamps only the axis that exceeds the cap', async () => {
    const { page, calls } = fakePage({ viewport: { width: 9000, height: 800 } });
    await captureBoundedScreenshot(page);
    expect(calls[0].clip).toEqual({ x: 0, y: 0, width: MAX_SHOT_PX, height: 800 });
  });

  it('does NOT synthesise a clip for a normal viewport (must-not-fire control)', async () => {
    // The pool's own contexts are 1280x720. The clamp must be invisible there — a crop
    // on the common path would be an unrequested behaviour change.
    const { page, calls } = fakePage({ viewport: { width: 1280, height: 720 } });
    const out = await captureBoundedScreenshot(page);
    expect(calls[0].clip).toBeUndefined();
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeGreaterThan(0);
  });

  it('still captures when the viewport size is unavailable', async () => {
    const { page, calls } = fakePage({ viewport: null });
    const out = await captureBoundedScreenshot(page);
    expect(calls[0].clip).toBeUndefined();
    expect(typeof out).toBe('string');
  });

  // --- Bound 3: the byte cap -------------------------------------------------------
  it('omits a capture that exceeds the byte cap', async () => {
    // A 4096x4096 noise canvas measured 66.7 MB fully inside the dimension clamp, so
    // the clamp alone cannot bound the response.
    const { page } = fakePage({ viewport: { width: 1280, height: 720 }, bytes: MAX_SHOT_B64_BYTES + 4096 });
    expect(await captureBoundedScreenshot(page)).toBeUndefined();
  });

  it('returns a capture that sits under the byte cap (must-not-fire control)', async () => {
    // A normal screenshot request under a normal budget must still succeed unchanged.
    const { page } = fakePage({ viewport: { width: 1280, height: 720 }, bytes: 400_000 });
    const out = await captureBoundedScreenshot(page);
    expect(typeof out).toBe('string');
    expect((out as string).length).toBeLessThanOrEqual(MAX_SHOT_B64_BYTES);
  });

  it('sets the byte cap above realistic clamped captures and below a payload bomb', () => {
    // Numbers are MEASURED (see file header), not chosen for tidiness.
    const largestRealisticClampedCapture = 2_431_388; // wikipedia @4096x4096
    const adversarialNoiseCanvas = 66_683_224; // 4096x4096 incompressible noise
    expect(MAX_SHOT_B64_BYTES).toBeGreaterThan(largestRealisticClampedCapture);
    expect(MAX_SHOT_B64_BYTES).toBeLessThan(adversarialNoiseCanvas);
  });

  it('still captures when the page cannot report a viewport at all', async () => {
    // Not hypothetical: two existing suites drive the pool with a page-like object that
    // has no `viewportSize`. Reading it unguarded turned a screenshot request into a
    // FAILED FETCH — the clamp must degrade to "no clip", never take the fetch down.
    const screenshot = vi.fn(async () => Buffer.alloc(768));
    const page = { screenshot } as unknown as Parameters<typeof captureBoundedScreenshot>[0];
    const out = await captureBoundedScreenshot(page);
    expect(typeof out).toBe('string');
    expect(screenshot).toHaveBeenCalledTimes(1);
  });

  it('does not let a throwing viewportSize fail the capture', async () => {
    const screenshot = vi.fn(async () => Buffer.alloc(768));
    const page = {
      screenshot,
      viewportSize: () => {
        throw new Error('target closed');
      },
    } as unknown as Parameters<typeof captureBoundedScreenshot>[0];
    expect(typeof (await captureBoundedScreenshot(page))).toBe('string');
  });

  // --- Failure is data, not a thrown fetch ------------------------------------------
  it('reports a failed capture as an absent image rather than failing the fetch', async () => {
    const { page } = fakePage({ viewport: { width: 1280, height: 720 }, throws: true });
    await expect(captureBoundedScreenshot(page)).resolves.toBeUndefined();
  });
});
