import { describe, it, expect, vi } from 'vitest';
import { autoPassChallenge, type AutoPassOptions } from '../../../src/fetch/auto-pass.js';
import type { ClearanceCookie } from '../../../src/fetch/challenge-completion.js';

// A minimal structural mock "page". auto-pass is pure logic — every browser I/O
// is an injected callback — so the page is an opaque token threaded through the
// reader closures, never touched directly.
const PAGE = { id: 'mock-page' } as const;

const CHALLENGE = '<html><title>Just a moment...</title></html>';
const REAL = '<html><body><article>real content</article></body></html>';
const isChallengeMarkers = (html: string) => html.includes('Just a moment');

const WIDGET = { x: 220, y: 340 } as const;

/** Deterministic rng so the Bézier path is reproducible in assertions. */
function seededRng(): () => number {
  let n = 0.123456789;
  return () => {
    n = (n * 9301 + 49297) % 233280;
    return n / 233280;
  };
}

/** Build a readContent that walks a scripted sequence of bodies, reusing the
 *  last entry once exhausted. */
function bodySequence(bodies: string[]): () => Promise<string> {
  let i = 0;
  return () => {
    const idx = Math.min(i, bodies.length - 1);
    i += 1;
    return Promise.resolve(bodies[idx]);
  };
}

/** Assemble AutoPassOptions with spy-able injected callbacks. Overrides win. */
function makeOpts(overrides: Partial<AutoPassOptions> = {}): {
  opts: AutoPassOptions;
  moves: Array<{ x: number; y: number }>;
  clicks: Array<{ x: number; y: number }>;
  locate: ReturnType<typeof vi.fn>;
} {
  const moves: Array<{ x: number; y: number }> = [];
  const clicks: Array<{ x: number; y: number }> = [];
  const locate = vi.fn(async () => WIDGET as { x: number; y: number } | null);
  const opts: AutoPassOptions = {
    page: PAGE,
    locateWidget: locate,
    dispatchTrustedMove: async (x: number, y: number) => {
      moves.push({ x, y });
    },
    dispatchTrustedClick: async (x: number, y: number) => {
      clicks.push({ x, y });
    },
    readContent: bodySequence([CHALLENGE, REAL]),
    readCookies: async () => [] as ClearanceCookie[],
    isStillChallenge: isChallengeMarkers,
    deadlineMs: 5000,
    pollIntervalMs: 5,
    stepDelayMs: 0,
    rng: seededRng(),
    ...overrides,
  };
  return { opts, moves, clicks, locate };
}

describe('autoPassChallenge', () => {
  it('dispatches a trusted click at the located widget coords after a multi-waypoint Bézier move', async () => {
    // WHY: the whole point over a JS .click() is a TRUSTED CDP gesture that
    // arrives along a human motion path — many intermediate move events, then a
    // press+release exactly on the widget. If the path collapses to one hop or
    // the click misses the widget, the anti-bot behavioral score sees a bot.
    const { opts, moves, clicks } = makeOpts();
    const res = await autoPassChallenge(opts);

    expect(res.passed).toBe(true);
    expect(res.solveMethod).toBe('auto-pass');
    // Click landed exactly on the widget.
    expect(clicks).toEqual([{ x: WIDGET.x, y: WIDGET.y }]);
    // Move path had multiple waypoints ...
    expect(moves.length).toBeGreaterThan(1);
    // ... with genuine intermediate coords (not all equal to the endpoint).
    const intermediate = moves.slice(0, -1);
    expect(intermediate.some((p) => p.x !== WIDGET.x || p.y !== WIDGET.y)).toBe(true);
    // ... and the final move pinned to the widget so the click lands true.
    expect(moves[moves.length - 1]).toEqual({ x: WIDGET.x, y: WIDGET.y });
  });

  it('must-not-fire: locateWidget returns null → no click dispatched, passed:false', async () => {
    // WHY: on a behavioral/none challenge there is no checkbox. The pass must be
    // inert — never synthesize a click at a guessed coordinate.
    const { opts, moves, clicks } = makeOpts({ locateWidget: async () => null });
    const res = await autoPassChallenge(opts);

    expect(res.passed).toBe(false);
    expect(res.reason).toBe('no-widget');
    expect(clicks).toEqual([]);
    expect(moves).toEqual([]);
  });

  it('clears on a cf_clearance cookie → passed:true with the cookies returned', async () => {
    // WHY: the clearance cookie is the authoritative pass signal even while the
    // interstitial DOM lingers mid-redirect; the caller persists these cookies.
    const cookies: ClearanceCookie[] = [
      { name: 'cf_clearance', value: 'tok123', domain: '.example.com', expires: 999 },
    ];
    const { opts } = makeOpts({
      readContent: async () => CHALLENGE, // markers never leave
      readCookies: async () => cookies,
    });
    const res = await autoPassChallenge(opts);

    expect(res.passed).toBe(true);
    expect(res.cookies).toEqual(cookies);
  });

  it('bounded: retries up to maxAttempts, re-polling each failed attempt, then gives up', async () => {
    // WHY: a stubborn interactive challenge must not loop forever. Each attempt
    // re-clicks and re-polls, but the count is hard-capped so we fast-fail.
    const locate = vi.fn(async () => WIDGET as { x: number; y: number } | null);
    const clicks: Array<{ x: number; y: number }> = [];
    const opts = makeOpts({
      locateWidget: locate,
      dispatchTrustedClick: async (x: number, y: number) => {
        clicks.push({ x, y });
      },
      readContent: async () => CHALLENGE, // never clears
      readCookies: async () => [],
      maxAttempts: 3,
    }).opts;

    const res = await autoPassChallenge(opts);

    expect(res.passed).toBe(false);
    expect(clicks.length).toBe(3);
    expect(locate).toHaveBeenCalledTimes(3);
  });

  it('honors maxAttempts default of 2 when unspecified', async () => {
    const clicks: Array<{ x: number; y: number }> = [];
    const { opts } = makeOpts({
      maxAttempts: undefined,
      dispatchTrustedClick: async (x: number, y: number) => {
        clicks.push({ x, y });
      },
      readContent: async () => CHALLENGE,
      readCookies: async () => [],
    });
    const res = await autoPassChallenge(opts);
    expect(res.passed).toBe(false);
    expect(clicks.length).toBe(2);
  });

  it('aborts promptly mid-gesture, rejecting with the abort reason — not after the deadline', async () => {
    // WHY: the caller's abort is the budget deadline; a slow move gesture must
    // stop between waypoints and surface the abort reason, not run to completion.
    const controller = new AbortController();
    const { opts } = makeOpts({
      // A slow move lets the abort fire mid-path.
      dispatchTrustedMove: () => new Promise((r) => setTimeout(r, 50)),
      readContent: async () => CHALLENGE,
      readCookies: async () => [],
      signal: controller.signal,
      stepDelayMs: 20,
      deadlineMs: 60000,
    });

    const start = Date.now();
    const p = autoPassChallenge(opts);
    const captured = p.catch((e) => e);
    setTimeout(() => controller.abort(new DOMException('caller deadline', 'AbortError')), 25);
    const err = await captured;
    const elapsed = Date.now() - start;

    expect((err as Error).name).toBe('AbortError');
    expect(elapsed).toBeLessThan(2000);
  });

  it('does not click when the signal is already aborted before the gesture starts', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('pre-aborted', 'AbortError'));
    const { opts, clicks } = makeOpts({ signal: controller.signal });
    await expect(autoPassChallenge(opts)).rejects.toMatchObject({ name: 'AbortError' });
    expect(clicks).toEqual([]);
  });
});
