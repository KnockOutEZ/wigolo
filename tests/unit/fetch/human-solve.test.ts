import { describe, it, expect, vi } from 'vitest';
import {
  humanSolveChallenge,
  type HumanSolveOptions,
  type ClearanceCookie,
} from '../../../src/fetch/human-solve.js';

// Structural page token — the real caller injects the readers, so this module
// never touches Playwright. The mock page is an opaque handle.
const PAGE = { id: 'mock-page' } as const;

const CHALLENGE = '<html><title>Checking your browser</title></html>';
const REAL = '<html><body><article>real content</article></body></html>';
const isChallengeMarkers = (html: string) => html.includes('Checking your browser');

const CF: ClearanceCookie = {
  name: 'cf_clearance',
  value: 'granted-token',
  domain: 'example.com',
  expires: Date.now() / 1000 + 3600,
};

/** A body reader that walks a fixed sequence, then sticks on the last body. */
function bodySequence(bodies: string[]): () => Promise<string> {
  let i = 0;
  return () => {
    const idx = Math.min(i, bodies.length - 1);
    i += 1;
    return Promise.resolve(bodies[idx]);
  };
}

/** Baseline opts wired for the engaged path (consent + surface) with a page
 *  that stays challenged forever. Each test overrides only what it exercises. */
function baseOpts(over: Partial<HumanSolveOptions>): HumanSolveOptions {
  return {
    page: PAGE,
    info: { url: 'https://example.com/protected', challengeClass: 'cf-turnstile' },
    hasVisibleSurface: true,
    consent: true,
    onNeedHuman: vi.fn(() => Promise.resolve()),
    readContent: () => Promise.resolve(CHALLENGE),
    readCookies: () => Promise.resolve([]),
    isStillChallenge: isChallengeMarkers,
    humanSolveTimeoutMs: 200,
    intervalMs: 5,
    ...over,
  };
}

describe('humanSolveChallenge — hard no-op gate (VPS safety)', () => {
  it('no visible surface → returns {solved:false, no-visible-surface} without engaging or polling', async () => {
    // WHY: this is THE demotion contract — on headless/hosted/VPS nobody is
    // watching a window, so the rung must never call onNeedHuman and never poll,
    // or a server-side fetch would hang forever on a human who will never arrive.
    const onNeedHuman = vi.fn(() => Promise.resolve());
    const readContent = vi.fn(() => Promise.resolve(CHALLENGE));
    const readCookies = vi.fn(() => Promise.resolve([] as ClearanceCookie[]));

    const res = await humanSolveChallenge(
      baseOpts({ hasVisibleSurface: false, consent: true, onNeedHuman, readContent, readCookies }),
    );

    expect(res).toEqual({ solved: false, reason: 'no-visible-surface' });
    expect(onNeedHuman).not.toHaveBeenCalled();
    // No polling: the page readers must be untouched.
    expect(readContent).not.toHaveBeenCalled();
    expect(readCookies).not.toHaveBeenCalled();
  });

  it('no consent (surface present) → returns {solved:false, no-consent} without engaging or polling', async () => {
    // WHY: a visible window is not permission. Without explicit consent we must
    // not raise the window or poll — the consent gate is independent of surface.
    const onNeedHuman = vi.fn(() => Promise.resolve());
    const readContent = vi.fn(() => Promise.resolve(CHALLENGE));
    const readCookies = vi.fn(() => Promise.resolve([] as ClearanceCookie[]));

    const res = await humanSolveChallenge(
      baseOpts({ hasVisibleSurface: true, consent: false, onNeedHuman, readContent, readCookies }),
    );

    expect(res).toEqual({ solved: false, reason: 'no-consent' });
    expect(onNeedHuman).not.toHaveBeenCalled();
    expect(readContent).not.toHaveBeenCalled();
    expect(readCookies).not.toHaveBeenCalled();
  });

  it('neither consent nor surface → still hard no-ops (surface reason wins) without engaging', async () => {
    // WHY: the double-negative must not accidentally engage; surface is checked
    // first so the reason is deterministic.
    const onNeedHuman = vi.fn(() => Promise.resolve());
    const res = await humanSolveChallenge(
      baseOpts({ hasVisibleSurface: false, consent: false, onNeedHuman }),
    );
    expect(res).toEqual({ solved: false, reason: 'no-visible-surface' });
    expect(onNeedHuman).not.toHaveBeenCalled();
  });
});

describe('humanSolveChallenge — engaged path', () => {
  it('consent + surface → engages once and returns solved when cf_clearance appears', async () => {
    // WHY: the whole point of the rung is to harvest the human-earned clearance;
    // the cookie is the authoritative pass signal even while the DOM still shows
    // the interstitial mid-redirect. onNeedHuman fires exactly once.
    const onNeedHuman = vi.fn(() => Promise.resolve());
    let ticks = 0;
    const res = await humanSolveChallenge(
      baseOpts({
        onNeedHuman,
        // Stays visually challenged; the cookie is what clears it.
        readContent: () => Promise.resolve(CHALLENGE),
        readCookies: () => {
          ticks += 1;
          return Promise.resolve(ticks >= 2 ? [CF] : []);
        },
      }),
    );

    expect(res).toEqual({ solved: true, cookies: [CF], solveMethod: 'human' });
    expect(onNeedHuman).toHaveBeenCalledTimes(1);
    expect(onNeedHuman).toHaveBeenCalledWith({
      url: 'https://example.com/protected',
      challengeClass: 'cf-turnstile',
    });
  });

  it('consent + surface → returns solved when the challenge DOM disappears (real page renders)', async () => {
    // WHY: clearance can also be evidenced by the interstitial giving way to the
    // real page even with no cf_clearance cookie surfaced yet.
    const res = await humanSolveChallenge(
      baseOpts({
        readContent: bodySequence([CHALLENGE, CHALLENGE, REAL]),
        readCookies: () => Promise.resolve([]),
      }),
    );
    expect(res).toEqual({ solved: true, cookies: [], solveMethod: 'human' });
  });

  it('never clears within the human timeout → {solved:false, timeout}', async () => {
    // WHY: a human may walk away; the rung must bound on humanSolveTimeoutMs and
    // fast-fail rather than hang. Small injected timeout keeps the test quick.
    const onNeedHuman = vi.fn(() => Promise.resolve());
    const start = Date.now();
    const res = await humanSolveChallenge(
      baseOpts({
        onNeedHuman,
        humanSolveTimeoutMs: 60,
        intervalMs: 5,
        readContent: () => Promise.resolve(CHALLENGE),
        readCookies: () => Promise.resolve([]),
      }),
    );
    expect(res).toEqual({ solved: false, reason: 'timeout' });
    // Engaged once, then bounded — did not spin far past the deadline.
    expect(onNeedHuman).toHaveBeenCalledTimes(1);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it('honors an abort mid-poll — rejects promptly with the signal reason', async () => {
    // WHY: an abort is the caller's budget deadline; it must propagate as the
    // reason, not swallow into a timeout or wait for the full human budget.
    const controller = new AbortController();
    const reason = new DOMException('caller aborted', 'AbortError');
    setTimeout(() => controller.abort(reason), 20);

    await expect(
      humanSolveChallenge(
        baseOpts({
          humanSolveTimeoutMs: 60000, // large — must NOT wait for this
          intervalMs: 5,
          readContent: () => Promise.resolve(CHALLENGE),
          readCookies: () => Promise.resolve([]),
          signal: controller.signal,
        }),
      ),
    ).rejects.toBe(reason);
  });
});
