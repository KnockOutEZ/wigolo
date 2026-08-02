import { describe, it, expect, vi, afterEach } from 'vitest';
import { pollUntilCleared } from '../../../src/fetch/challenge-completion.js';

// A minimal structural mock "page". The real caller injects readContent /
// readCookies closures, so this fn never touches Playwright directly. The mock
// page object is just an opaque token threaded through those closures.
const PAGE = { id: 'mock-page' } as const;

interface Cookie {
  name: string;
  value: string;
  domain: string;
  expires: number;
}

/** Build a readContent that walks a scripted sequence of bodies, reusing the
 *  last entry once exhausted (mirrors a page whose DOM has settled). */
function bodySequence(bodies: string[]): () => Promise<string> {
  let i = 0;
  return () => {
    const idx = Math.min(i, bodies.length - 1);
    i += 1;
    return Promise.resolve(bodies[idx]);
  };
}

const CHALLENGE = '<html><title>Just a moment...</title></html>';
const REAL = '<html><body><article>real content</article></body></html>';

// The challenge predicate the caller supplies: markers present == still challenge.
const isChallengeMarkers = (html: string) => html.includes('Just a moment');

describe('pollUntilCleared', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears on the 2nd poll once the challenge markers vanish — the real page rendered', async () => {
    // WHY: a real challenge that completes AFTER the old fixed 5s settle used to
    // be fast-failed. Polling must capture it on a later tick instead of once.
    const readContent = bodySequence([CHALLENGE, REAL]);
    const res = await pollUntilCleared(PAGE, {
      deadlineMs: 5000,
      intervalMs: 10,
      isStillChallenge: isChallengeMarkers,
      readContent,
      readCookies: () => Promise.resolve([]),
    });
    expect(res.cleared).toBe(true);
    expect(res.cfClearance).toBeUndefined();
  });

  it('never clears until the deadline elapses → cleared:false (bounded fast-fail preserved)', async () => {
    // WHY: an interactive / never-completing challenge must still terminate
    // deterministically at the deadline so the caller can fast-fail — no hang.
    const start = Date.now();
    const res = await pollUntilCleared(PAGE, {
      deadlineMs: 120,
      intervalMs: 20,
      isStillChallenge: isChallengeMarkers,
      readContent: () => Promise.resolve(CHALLENGE),
      readCookies: () => Promise.resolve([]),
    });
    const elapsed = Date.now() - start;
    expect(res.cleared).toBe(false);
    expect(res.cookies).toEqual([]);
    // Stopped at the deadline, not spinning forever.
    expect(elapsed).toBeLessThan(2000);
  });

  it('clears on a cf_clearance cookie even while challenge markers still linger; cfClearance populated', async () => {
    // WHY: the clearance cookie is the authoritative pass signal — the DOM may
    // still show the interstitial mid-redirect, but the cookie means we passed.
    const cookies: Cookie[] = [
      { name: 'cf_clearance', value: 'abc123', domain: '.example.com', expires: 999 },
      { name: 'other', value: 'x', domain: '.example.com', expires: 0 },
    ];
    const res = await pollUntilCleared(PAGE, {
      deadlineMs: 5000,
      intervalMs: 10,
      isStillChallenge: () => true, // markers never leave
      readContent: () => Promise.resolve(CHALLENGE),
      readCookies: () => Promise.resolve(cookies),
    });
    expect(res.cleared).toBe(true);
    expect(res.cfClearance).toEqual({ value: 'abc123', expires: 999 });
    expect(res.cookies).toEqual(cookies);
  });

  it('rejects promptly when the signal aborts mid-poll — not after the full deadline', async () => {
    // WHY: an abort is the caller's budget deadline; it must propagate as the
    // abort reason and cut the poll short, mirroring the old settle race.
    const controller = new AbortController();
    const start = Date.now();
    const p = pollUntilCleared(PAGE, {
      deadlineMs: 60000, // large — must NOT wait for this
      intervalMs: 10,
      isStillChallenge: () => true,
      readContent: () => Promise.resolve(CHALLENGE),
      readCookies: () => Promise.resolve([]),
      signal: controller.signal,
    });
    const captured = p.catch((e) => e);
    setTimeout(() => controller.abort(new DOMException('caller deadline', 'AbortError')), 30);
    const err = await captured;
    const elapsed = Date.now() - start;
    expect((err as Error).name).toBe('AbortError');
    expect(elapsed).toBeLessThan(2000);
  });

  it('a tiny deadline stops the loop immediately with no hang', async () => {
    // WHY: min() may cap the deadline to a near-zero remaining budget; the loop
    // must terminate, not spin.
    const res = await pollUntilCleared(PAGE, {
      deadlineMs: 1,
      intervalMs: 500,
      isStillChallenge: () => true,
      readContent: () => Promise.resolve(CHALLENGE),
      readCookies: () => Promise.resolve([]),
    });
    expect(res.cleared).toBe(false);
  });
});
