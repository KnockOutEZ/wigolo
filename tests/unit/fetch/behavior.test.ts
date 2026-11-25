import { describe, it, expect, vi } from 'vitest';
import { humanMousePath, humanizePage } from '../../../src/fetch/behavior.js';

// A deterministic pseudo-random generator so path/timing assertions are stable.
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0xffffffff;
  };
}

describe('humanMousePath', () => {
  it('returns a bounded sequence starting near `from` and ending at `to`', () => {
    const from = { x: 10, y: 20 };
    const to = { x: 400, y: 300 };
    const path = humanMousePath(from, to, seededRng(1));

    expect(path.length).toBeGreaterThan(2);
    expect(path.length).toBeLessThanOrEqual(200);

    const first = path[0];
    const last = path[path.length - 1];
    // Starts near the origin.
    expect(Math.abs(first.x - from.x)).toBeLessThan(50);
    expect(Math.abs(first.y - from.y)).toBeLessThan(50);
    // Ends exactly at the target.
    expect(last.x).toBeCloseTo(to.x, 5);
    expect(last.y).toBeCloseTo(to.y, 5);
  });

  it('produces no NaN and makes monotone-ish progress toward the target', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 500, y: 500 };
    const path = humanMousePath(from, to, seededRng(42));

    for (const p of path) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }

    // Distance to target should generally shrink: the last point is far closer
    // than the first (allowing intermediate wobble from the easing/jitter).
    const dist = (p: { x: number; y: number }) => Math.hypot(to.x - p.x, to.y - p.y);
    expect(dist(path[path.length - 1])).toBeLessThan(dist(path[0]));
  });

  it('is deterministic under a seeded rng', () => {
    const from = { x: 5, y: 5 };
    const to = { x: 300, y: 200 };
    const a = humanMousePath(from, to, seededRng(7));
    const b = humanMousePath(from, to, seededRng(7));
    expect(a).toEqual(b);
  });

  it('handles a zero-length move without throwing or NaN', () => {
    const path = humanMousePath({ x: 100, y: 100 }, { x: 100, y: 100 }, seededRng(3));
    expect(path.length).toBeGreaterThan(0);
    for (const p of path) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    expect(path[path.length - 1]).toEqual({ x: 100, y: 100 });
  });
});

// A mock page carrying mouse.move + evaluate (scroll) spies.
function makeMockPage() {
  const moves: Array<{ x: number; y: number }> = [];
  return {
    moves,
    mouse: {
      move: vi.fn((x: number, y: number) => {
        moves.push({ x, y });
        return Promise.resolve();
      }),
    },
    evaluate: vi.fn().mockResolvedValue(undefined),
    viewportSize: vi.fn(() => ({ width: 1280, height: 800 })),
  };
}

describe('humanizePage', () => {
  it('moves the mouse along multiple points and performs a scroll', async () => {
    const page = makeMockPage();
    await humanizePage(page as never, { rng: seededRng(11) });

    // Multiple mouse-move points (a path, not a single hop).
    expect(page.mouse.move.mock.calls.length).toBeGreaterThan(2);
    expect(page.moves.length).toBeGreaterThan(2);
    // A scroll was issued via evaluate.
    expect(page.evaluate).toHaveBeenCalled();
  });

  it('respects the time cap (never runs longer than maxMs)', async () => {
    const page = makeMockPage();
    const start = Date.now();
    await humanizePage(page as never, { rng: seededRng(2), maxMs: 200 });
    const elapsed = Date.now() - start;
    // A generous ceiling above the cap to absorb scheduler jitter.
    expect(elapsed).toBeLessThan(200 + 400);
  });

  it('no-ops cleanly on a page WITHOUT a real mouse', async () => {
    const page = { evaluate: vi.fn().mockResolvedValue(undefined) };
    // Must not throw.
    await expect(humanizePage(page as never, { rng: seededRng(1) })).resolves.toBeUndefined();
    // With no mouse there is nothing to move; scroll is also skipped since the
    // guard short-circuits when the page is not interaction-capable.
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  it('stops early when the abort signal is already fired', async () => {
    const page = makeMockPage();
    const ac = new AbortController();
    ac.abort();
    await humanizePage(page as never, { rng: seededRng(1), signal: ac.signal });
    // Aborted before any interaction — no moves.
    expect(page.mouse.move).not.toHaveBeenCalled();
  });

  it('swallows errors from the page (never rejects the fetch)', async () => {
    const page = {
      mouse: { move: vi.fn().mockRejectedValue(new Error('detached')) },
      evaluate: vi.fn().mockRejectedValue(new Error('detached')),
      viewportSize: vi.fn(() => ({ width: 1280, height: 800 })),
    };
    await expect(humanizePage(page as never, { rng: seededRng(1) })).resolves.toBeUndefined();
  });
});
