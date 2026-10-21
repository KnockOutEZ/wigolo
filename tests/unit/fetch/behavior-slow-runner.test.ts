import { describe, it, expect, vi } from 'vitest';
import { humanizePage } from '../../../src/fetch/behavior.js';

/**
 * The behavioral pass splits its budget: ~55% for the mouse traversal, the rest
 * for the scroll. That split was computed but never ENFORCED — the traversal
 * loop only checked the global deadline, so on a slow host it consumed the whole
 * budget and the scroll never ran. The pass then silently delivered half of what
 * it claims (mouse, no scroll) exactly when the machine is busy, with nothing
 * reporting it.
 *
 * Windows CI trips this reliably: `sleep(perStep)` with perStep <= 12ms rounds up
 * to the ~15.6ms timer granularity, so the traversal overruns its share.
 *
 * These tests model a slow host by charging real wall-clock per mouse move.
 */
function slowPage(moveCostMs: number) {
  const page = {
    moves: 0,
    scrolls: 0,
    mouse: {
      move: vi.fn(async () => {
        page.moves++;
        await new Promise((r) => setTimeout(r, moveCostMs));
      }),
    },
    evaluate: vi.fn(async () => {
      page.scrolls++;
    }),
    viewportSize: () => ({ width: 1280, height: 800 }),
  };
  return page;
}

describe('humanizePage under a slow host', () => {
  // Exercised at the DEFAULT budget the browser tier actually uses. A much
  // tighter cap would fail for an honest reason — the pass's two fixed settle
  // sleeps (~140-440ms combined) can exceed it on their own — which would test
  // an unachievable contract instead of the starvation bug.

  it('still scrolls when each mouse move costs real wall-clock', async () => {
    const page = slowPage(5);
    await humanizePage(page as never, {});

    expect(page.moves).toBeGreaterThan(0);
    expect(page.scrolls).toBe(1);
  });

  it('still scrolls at Windows timer granularity (~16ms per move)', async () => {
    const page = slowPage(16);
    await humanizePage(page as never, {});

    expect(page.moves).toBeGreaterThan(0);
    expect(page.scrolls).toBe(1);
  });

  it('yields the traversal early rather than overrunning the total cap', async () => {
    const page = slowPage(16);
    const started = Date.now();
    await humanizePage(page as never, {});
    // Reserving scroll time must not be paid for by running longer: the ~1200ms
    // hard cap is still the contract. Generous slack for CI scheduling jitter.
    expect(Date.now() - started).toBeLessThan(2_500);
  });
});
