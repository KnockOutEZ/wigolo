import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Programmable page behaviour shared with the playwright mock below. Each test
// sets `state` before constructing the pool.
interface PageState {
  status: number;
  // Sequence of bodies returned by successive page.content() calls. The last
  // entry is reused once exhausted (so a settle re-check reads the final body).
  bodies: string[];
  gotoRejectsTimeout: boolean;
  contentCalls: number;
  // Nav-response headers the mock reports (response.headers()). A modern-CF
  // challenge carries `cf-mitigated: challenge` here even when the body has no
  // legacy markers.
  headers: Record<string, string>;
}

const state: PageState = {
  status: 200,
  bodies: ['<html><body>ok</body></html>'],
  gotoRejectsTimeout: false,
  contentCalls: 0,
  headers: { 'content-type': 'text/html' },
};

function makeTimeoutErr() {
  const err = new Error('page.goto: Timeout 30000ms exceeded.') as Error & { name: string };
  err.name = 'TimeoutError';
  return err;
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockResolvedValue({
    newContext: vi.fn().mockResolvedValue({
      close: vi.fn().mockResolvedValue(undefined),
      newPage: vi.fn().mockImplementation(() => ({
        goto: vi.fn().mockImplementation(() => {
          if (state.gotoRejectsTimeout) return Promise.reject(makeTimeoutErr());
          return Promise.resolve({
            status: () => state.status,
            url: () => 'https://blocked.example/',
            headers: () => state.headers,
          });
        }),
        waitForLoadState: vi.fn().mockResolvedValue(undefined),
        waitForFunction: vi.fn().mockResolvedValue(undefined),
        // settlePage reads content metrics (stability poller) and, after the
        // gate, the DOM verdict. Branch on the injected source: the verdict
        // source is the only one containing 'hasContent'. These tests assert
        // challenge classification over the final html, not the verdict values,
        // so a permissive default verdict is fine.
        evaluate: vi.fn().mockImplementation((src: string) => {
          if (typeof src === 'string' && src.includes('hasContent')) {
            return Promise.resolve({ hasContent: true, hasSpaRoot: false, nearEmpty: false });
          }
          return Promise.resolve({ textLen: 1000, nodes: 8 });
        }),
        content: vi.fn().mockImplementation(() => {
          const idx = Math.min(state.contentCalls, state.bodies.length - 1);
          state.contentCalls += 1;
          return Promise.resolve(state.bodies[idx]);
        }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from('x')),
        setExtraHTTPHeaders: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      })),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const stub = { launch };
  return { chromium: stub, firefox: stub, webkit: stub };
});

import { MultiBrowserPool, ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';

const CHALLENGE_INTERSTITIAL =
  '<html><head><title>Just a moment...</title></head><body>' +
  '<div class="cf-browser-verification"></div><div class="cf-turnstile"></div></body></html>';

// A modern-Cloudflare challenge served at HTTP 403 with `cf-mitigated:
// challenge` and a body that carries NONE of the legacy markers — its only body
// signal is the /cdn-cgi/challenge-platform/ script on a near-empty skeleton.
// This is the Upwork-shaped challenge S-A7/S-A8 target.
const MODERN_CF_CHALLENGE =
  '<html><head><title>Verify</title></head><body>' +
  '<div id="challenge-running">Verifying you are human.</div>' +
  '<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=x"></script>' +
  '</body></html>';

// A 200 article whose PROSE quotes challenge marker strings — must never fire.
const ARTICLE_QUOTING_MARKERS =
  '<html><head><title>How Cloudflare challenges work</title></head><body><article>' +
  ('The interstitial shows "Just a moment" and sets _cfChlOpt while a cf-turnstile ' +
    'widget loads. Here is a deep dive into how that flow works in practice. ').repeat(20) +
  '</article></body></html>';

describe('browser-pool anti-bot fast-fail (D6)', () => {
  beforeEach(() => {
    resetConfig();
    state.status = 200;
    state.bodies = ['<html><body>ok</body></html>'];
    state.gotoRejectsTimeout = false;
    state.contentCalls = 0;
    state.headers = { 'content-type': 'text/html' };
  });
  afterEach(() => {
    vi.useRealTimers();
    resetConfig();
  });

  it('MUST-FIRE: 403 + challenge markers (near-empty body) fast-fails with ChallengeBlockedError under fake timers', async () => {
    vi.useFakeTimers();
    // Poll to completion, then fast-fail at the bounded deadline. A short
    // completion window keeps the test fast while proving the bound.
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '5000';
    resetConfig();
    state.status = 403;
    // Stays a challenge across every poll — never clears.
    state.bodies = [CHALLENGE_INTERSTITIAL, CHALLENGE_INTERSTITIAL];

    const pool = new MultiBrowserPool();
    const start = Date.now();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    // Attach rejection expectation, then drive the completion poll to its deadline.
    const assertion = expect(p).rejects.toBeInstanceOf(ChallengeBlockedError);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    const elapsed = Date.now() - start;
    // Total challenged-page budget must be bounded (well under 10s here).
    expect(elapsed).toBeLessThan(10000);
    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });

  it('carries a use_auth suggestion + names the site bot protection in capability language', async () => {
    vi.useFakeTimers();
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '5000';
    resetConfig();
    state.status = 403;
    state.bodies = [CHALLENGE_INTERSTITIAL, CHALLENGE_INTERSTITIAL];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    const captured = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(6000);
    const err = (await captured) as ChallengeBlockedError;
    expect(err).toBeInstanceOf(ChallengeBlockedError);
    expect(err.code).toBe('blocked_by_challenge');
    expect(err.hint).toMatch(/use_auth/);
    // Capability language — no vendor internals jargon.
    expect(err.message.toLowerCase()).toMatch(/bot protection|challenge page/);
    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });

  it('MUST-NOT-FIRE: 200 article quoting marker strings extracts normally, no fast-fail', async () => {
    state.status = 200;
    state.bodies = [ARTICLE_QUOTING_MARKERS];

    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://news.example/article');
    expect(res.html).toContain('How Cloudflare challenges work');
    expect(res.statusCode).toBe(200);
    await pool.shutdown();
  });

  it('MUST-FIRE: 200 challenge shell (markers + skeleton) enters settle window and fast-fails when it persists', async () => {
    // NEW SPEC: a challenge interstitial served at HTTP 200 (DataDome-style)
    // must be treated as a challenge — the gate is no longer status-gated.
    vi.useFakeTimers();
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '5000';
    resetConfig();
    state.status = 200;
    state.bodies = [CHALLENGE_INTERSTITIAL, CHALLENGE_INTERSTITIAL];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    const assertion = expect(p).rejects.toBeInstanceOf(ChallengeBlockedError);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });

  it('MUST-NOT-FIRE: 200 challenge body markers but SUBSTANTIAL content (article quoting markers) never fires', async () => {
    // Markers present at 200 but the body is a real article, not a skeleton.
    state.status = 200;
    state.bodies = [ARTICLE_QUOTING_MARKERS];

    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://news.example/article');
    expect(res.statusCode).toBe(200);
    expect(res.html).toContain('How Cloudflare challenges work');
    await pool.shutdown();
  });

  it('MUST-NOT-FIRE: 200 challenge shell that HYDRATES into real content within the settle window returns content', async () => {
    vi.useFakeTimers();
    state.status = 200;
    const realArticle = '<html><body><article>' + 'Real hydrated content here. '.repeat(50) + '</article></body></html>';
    state.bodies = [CHALLENGE_INTERSTITIAL, realArticle];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    await vi.advanceTimersByTimeAsync(6000);
    const res = await p;
    expect(res.html).toContain('Real hydrated content');
    await pool.shutdown();
  });

  it('MUST-NOT-FIRE: challenge that AUTO-PASSES within the settle window returns normal content', async () => {
    vi.useFakeTimers();
    state.status = 403;
    // First read = challenge; after settle the page navigated to a real article.
    const realArticle = '<html><body><article>' + 'Real hydrated content here. '.repeat(50) + '</article></body></html>';
    state.bodies = [CHALLENGE_INTERSTITIAL, realArticle];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    await vi.advanceTimersByTimeAsync(6000);
    const res = await p;
    expect(res.html).toContain('Real hydrated content');
    await pool.shutdown();
  });

  it('MUST-NOT-FIRE: a challenge that completes AFTER the old 5s fixed settle is now captured, not fast-failed', async () => {
    // WHY this slice exists: the old fixed 5s settle re-checked exactly once and
    // fast-failed anything still challenged at 5s. A real Cloudflare interstitial
    // that runs its JS and navigates at ~8s was lost. Polling to a 15s completion
    // deadline must now capture it.
    vi.useFakeTimers();
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '15000';
    resetConfig();
    state.status = 403;
    const realArticle = '<html><body><article>' + 'Real hydrated content here. '.repeat(50) + '</article></body></html>';
    // Challenge persists across ~16 polls (500ms each ≈ 8s), then the real page renders.
    state.bodies = [...Array(16).fill(CHALLENGE_INTERSTITIAL), realArticle];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    await vi.advanceTimersByTimeAsync(9000);
    const res = await p;
    expect(res.html).toContain('Real hydrated content');
    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });

  it('MUST-FIRE via timeout path: goto timeout + challenge skeleton partial fast-fails', async () => {
    state.gotoRejectsTimeout = true;
    // Partial content on timeout is a challenge skeleton (title interstitial).
    state.bodies = [CHALLENGE_INTERSTITIAL];

    const pool = new MultiBrowserPool();
    await expect(pool.fetchWithBrowser('https://blocked.example/')).rejects.toBeInstanceOf(ChallengeBlockedError);
    await pool.shutdown();
  });

  it('MUST-NOT-FIRE via timeout path: goto timeout partial WITHOUT markers preserves partial-return', async () => {
    state.gotoRejectsTimeout = true;
    state.bodies = ['<html><body>' + 'partial shell content that is long enough to be real '.repeat(20) + '</body></html>'];

    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://spa.example/');
    expect(res.warning).toBe('goto_timeout_partial_content');
    expect(res.html).toContain('partial shell content');
    await pool.shutdown();
  });

  it('TRIGGER: modern-CF 403 + cf-mitigated header + body WITHOUT legacy markers enters the poll and fast-fails when it never clears', async () => {
    // Before S-A8 the trigger used only OLD body markers, so a modern-CF
    // challenge (whose body has no legacy markers) NEVER entered the poll and the
    // shell leaked as content. Now the header-inclusive trigger recognises it.
    vi.useFakeTimers();
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '5000';
    resetConfig();
    state.status = 403;
    state.headers = { 'content-type': 'text/html', 'cf-mitigated': 'challenge' };
    state.bodies = [MODERN_CF_CHALLENGE, MODERN_CF_CHALLENGE];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    const assertion = expect(p).rejects.toBeInstanceOf(ChallengeBlockedError);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });

  it('CLEAR-CHECK cleared: modern-CF challenge that renders real content returns the CONTENT (stale-header false-positive guard)', async () => {
    // The nav header stays `cf-mitigated: challenge` even after the challenge
    // clears and the real page renders. The clear-check keys on the RENDERED
    // BODY, not the header, so this must return the real content — NOT
    // blocked_by_challenge. It also proves the final result no longer carries a
    // 403 / stale cf-mitigated so the router guard won't mislabel it.
    vi.useFakeTimers();
    state.status = 403;
    state.headers = { 'content-type': 'text/html', 'cf-mitigated': 'challenge' };
    const realArticle = '<html><body><article>' + 'Real hydrated content here. '.repeat(50) + '</article></body></html>';
    state.bodies = [MODERN_CF_CHALLENGE, realArticle];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    await vi.advanceTimersByTimeAsync(6000);
    const res = await p;
    expect(res.html).toContain('Real hydrated content');
    // Cleared challenge must not report the stale 403 / cf-mitigated header, or
    // the router's guardChallengeShell would wrongly block it downstream.
    expect(res.statusCode).toBe(200);
    expect(res.headers['cf-mitigated']).toBeUndefined();
    await pool.shutdown();
  });

  it('DataDome: challenge that "clears" to a near-empty stub is labeled blocked, NOT leaked as content', async () => {
    // WHY: DataDome (G2 et al.) serves an "enable JS" interstitial at 403, then
    // during the poll swaps it for a tiny stub — `<body>g2.com</body>` — that
    // carries NO challenge marker. The marker-based clear-check reads the stub as
    // a pass, so before this guard a 6-char stub leaked as content at HTTP 200.
    // After full hydration a body that is still near-empty never truly cleared →
    // it must fast-fail as ChallengeBlockedError, matching Upwork/Glassdoor.
    vi.useFakeTimers();
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '5000';
    resetConfig();
    state.status = 403;
    const DATADOME_INTERSTITIAL =
      '<html lang="en"><head><title>g2.com</title>' +
      '<style>#cmsg{animation: A 1.5s;}</style></head>' +
      '<body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p></body></html>';
    const TINY_STUB = '<html><head><title>g2.com</title></head><body>g2.com</body></html>';
    state.bodies = [DATADOME_INTERSTITIAL, TINY_STUB, TINY_STUB];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    const assertion = expect(p).rejects.toBeInstanceOf(ChallengeBlockedError);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });

  it('CLEAR-CHECK still-blocked: modern-CF skeleton that never clears + no cf_clearance fast-fails with ChallengeBlockedError', async () => {
    vi.useFakeTimers();
    process.env.WIGOLO_CHALLENGE_COMPLETION_MS = '5000';
    resetConfig();
    state.status = 403;
    state.headers = { 'content-type': 'text/html', 'cf-mitigated': 'challenge' };
    state.bodies = [MODERN_CF_CHALLENGE, MODERN_CF_CHALLENGE];

    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/');
    const assertion = expect(p).rejects.toBeInstanceOf(ChallengeBlockedError);
    await vi.advanceTimersByTimeAsync(6000);
    await assertion;
    delete process.env.WIGOLO_CHALLENGE_COMPLETION_MS;
    await pool.shutdown();
  });

  it('MUST-NOT-FIRE: a real 200 article referencing /cdn-cgi/challenge-platform/ (substantial prose) extracts normally', async () => {
    // The clear-check skeleton gate is text-length based, so a real article that
    // merely references the challenge-platform script path is NOT a skeleton.
    state.status = 200;
    const article =
      '<html><body><article><h1>How the challenge-platform works</h1>' +
      ('The verification script lives at /cdn-cgi/challenge-platform/ and runs a check. ' +
        'Here is a deep dive of real article prose so this is unmistakably content. '.repeat(10)) +
      '</article></body></html>';
    state.bodies = [article];

    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://news.example/article');
    expect(res.statusCode).toBe(200);
    expect(res.html).toContain('How the challenge-platform works');
    await pool.shutdown();
  });

  it('an abort DURING the settle wait propagates the abort — never masquerades as a challenge error', async () => {
    vi.useFakeTimers();
    state.status = 403;
    state.bodies = [CHALLENGE_INTERSTITIAL, CHALLENGE_INTERSTITIAL];

    const controller = new AbortController();
    const pool = new MultiBrowserPool();
    const p = pool.fetchWithBrowser('https://blocked.example/', { signal: controller.signal });
    const captured = p.catch((e) => e);
    // Abort mid-settle before the 5s window elapses.
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort(new DOMException('caller deadline', 'AbortError'));
    await vi.advanceTimersByTimeAsync(10);
    const err = await captured;
    expect(err).not.toBeInstanceOf(ChallengeBlockedError);
    expect((err as Error).name).toBe('AbortError');
    await pool.shutdown();
  });

  it('challenge_shell BOUNDARY: a 200 challenge shell that slips the throw-gates is labeled contentCompleteness=challenge_shell', async () => {
    // The ONLY place challenge_shell is asserted. Construct a case that bypasses
    // both throw-gates: the INITIAL read is a clean article (no challenge markers
    // → no completion poll entered), but the FINAL captured html is a challenge
    // interstitial that carries a "Just a moment" title AND substantial body
    // text (so isNearEmptyBody is false → the near-empty throw does NOT fire).
    // The browser-pool override keys on isChallengeShell over the final html and
    // must relabel the returned result rather than trust it as content.
    state.status = 200;
    const cleanInitial =
      '<html><head><title>Docs</title></head><body><article>' +
      'A perfectly normal first read with no anti-bot markers at all. '.repeat(20) +
      '</article></body></html>';
    // Title matches CHALLENGE_TITLE_PATTERN → skeleton=true; "Just a moment"
    // marker → hasChallengeBody=true → isChallengeShell(200)=true. Long body →
    // NOT near-empty, so the challenge poll's near-empty throw cannot fire.
    const challengeWithBody =
      '<html><head><title>Just a moment...</title></head><body>' +
      '<div class="cf-browser-verification">Just a moment while we verify your browser. ' +
      'This interstitial carries enough visible text that it is not near-empty. '.repeat(12) +
      '</div></body></html>';
    state.bodies = [cleanInitial, challengeWithBody];

    const pool = new MultiBrowserPool();
    const res = await pool.fetchWithBrowser('https://blocked.example/');
    // It did NOT throw (slipped the gates) but is labeled a challenge shell.
    expect(res.contentCompleteness).toEqual({
      level: 'shell',
      reason: 'challenge_shell',
      settled_by: expect.any(String),
    });
    await pool.shutdown();
  });
});
