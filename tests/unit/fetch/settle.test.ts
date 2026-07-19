import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  settlePage,
  toCompleteness,
  POST_GOTO_CAP_MS,
  STABILITY_TICK_MS,
} from '../../../src/fetch/settle.js';
import { CONTENT_METRICS_SOURCE, DOM_VERDICT_SOURCE, type DomVerdict } from '../../../src/fetch/hydration-probe.js';

// Scripted fake page. `waitForFunction` resolves at `probeResolvesAtMs` (or
// rejects with a TimeoutError at its own timeout when never). `evaluate`
// branches on the injected source: CONTENT_METRICS_SOURCE returns per-call
// metrics (last entry repeating) for the stability poller; DOM_VERDICT_SOURCE
// returns the final verdict settle reads after the gate exits. No content() —
// settle never captures.
function makeFakePage(script: {
  probeResolvesAtMs?: number;
  metrics: Array<{ textLen: number; nodes: number }>;
  networkidleRejects?: boolean;
  verdict?: DomVerdict;
}) {
  let evalCalls = 0;
  const page = {
    // Count only the metrics (stability-poller) evaluate calls — the single
    // final DOM_VERDICT_SOURCE read must not inflate the poller-sample count.
    evalCallCount: () => evalCalls,
    waitForLoadState: vi.fn().mockImplementation(() => {
      if (script.networkidleRejects) {
        return Promise.reject(Object.assign(new Error('networkidle timeout'), { name: 'TimeoutError' }));
      }
      return Promise.resolve(undefined);
    }),
    waitForFunction: vi.fn().mockImplementation((_src: string, _arg: undefined, opts: { timeout: number }) => {
      if (script.probeResolvesAtMs === undefined) {
        return new Promise((_res, rej) =>
          setTimeout(() => rej(Object.assign(new Error('Timeout'), { name: 'TimeoutError' })), opts.timeout));
      }
      return new Promise((res) => setTimeout(res, script.probeResolvesAtMs));
    }),
    evaluate: vi.fn().mockImplementation((src: string) => {
      if (src === DOM_VERDICT_SOURCE) {
        return Promise.resolve(
          script.verdict ?? { hasContent: true, hasSpaRoot: false, hasNavChrome: false, nearEmpty: false },
        );
      }
      // CONTENT_METRICS_SOURCE (stability poller).
      const m = script.metrics[Math.min(evalCalls++, script.metrics.length - 1)];
      return Promise.resolve(m);
    }),
  };
  // Ensure the constant is referenced so the branch is meaningful under lint.
  void CONTENT_METRICS_SOURCE;
  return page;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('settlePage — hybrid probe + stability gate', () => {
  it('probe resolves immediately → returns fast via the probe gate, no stability wait', async () => {
    vi.useFakeTimers();
    const page = makeFakePage({ probeResolvesAtMs: 0, metrics: [{ textLen: 1000, nodes: 20 }] });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;
    expect(result.settledBy).toBe('probe');
    expect(result.stillGrowing).toBe(false);
    // The probe won before any stability tick could sample metrics.
    expect(page.evalCallCount()).toBe(0);
  });

  it('probe never resolves, metrics stop growing after 2 ticks → settledBy stability', async () => {
    vi.useFakeTimers();
    // Grows once, then flat: ticks read 1000, 1000, 1000 → two stable
    // transitions after the first sample.
    const page = makeFakePage({
      metrics: [
        { textLen: 1000, nodes: 20 },
        { textLen: 1000, nodes: 20 },
        { textLen: 1000, nodes: 20 },
      ],
    });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(POST_GOTO_CAP_MS);
    const result = await p;
    expect(result.settledBy).toBe('stability');
    expect(result.lastMetrics?.textLen).toBe(1000);
    expect(result.stillGrowing).toBe(false);
  });

  it('probe never resolves, metrics grow forever → returns at deadline via budget', async () => {
    vi.useFakeTimers();
    // Each evaluate returns a strictly larger textLen → never stable.
    const grow = Array.from({ length: 50 }, (_v, i) => ({ textLen: 500 + i * 500, nodes: 10 + i }));
    const page = makeFakePage({ metrics: grow });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(POST_GOTO_CAP_MS + 100);
    const result = await p;
    expect(result.settledBy).toBe('budget');
    // Growth was active when the budget cut in.
    expect(result.stillGrowing).toBe(true);
  });

  it('caller budget smaller than the cap sets the deadline to the caller budget', async () => {
    vi.useFakeTimers();
    const grow = Array.from({ length: 50 }, (_v, i) => ({ textLen: 500 + i * 500, nodes: 10 + i }));
    const page = makeFakePage({ metrics: grow });
    const start = Date.now();
    const budgetMs = 1200;
    const p = settlePage(page, { budgetMs });
    // Advance to just past the caller budget but well under the cap.
    await vi.advanceTimersByTimeAsync(budgetMs + 50);
    const result = await p;
    const elapsed = Date.now() - start;
    expect(result.settledBy).toBe('budget');
    // Total wall clock is bounded by the caller budget, not the 6s cap.
    expect(elapsed).toBeLessThan(budgetMs + STABILITY_TICK_MS + 50);
    expect(elapsed).toBeGreaterThanOrEqual(budgetMs);
  });

  it('abort during the wait rejects with the abort reason and never resolves', async () => {
    vi.useFakeTimers();
    const page = makeFakePage({
      metrics: [{ textLen: 100, nodes: 2 }, { textLen: 200, nodes: 4 }, { textLen: 300, nodes: 6 }],
    });
    const controller = new AbortController();
    const reason = new Error('caller budget exhausted');
    const p = settlePage(page, { signal: controller.signal });
    // Guard against a silent resolve masquerading as success.
    const outcome = p.then(
      (r) => ({ resolved: true as const, r }),
      (e) => ({ resolved: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(STABILITY_TICK_MS + 10);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(10);
    const o = await outcome;
    expect(o.resolved).toBe(false);
    if (!o.resolved) expect(o.e).toBe(reason);
  });

  it('abort tears down the stability poller: no further evaluate calls after the rejection', async () => {
    vi.useFakeTimers();
    // Growing metrics so no gate ever fires — the stability poller is the only
    // thing sampling, and it must stop the instant abort wins the race.
    const grow = Array.from({ length: 50 }, (_v, i) => ({ textLen: 100 + i * 100, nodes: 2 + i }));
    const page = makeFakePage({ metrics: grow });
    const controller = new AbortController();
    const p = settlePage(page, { signal: controller.signal });
    const outcome = p.then(
      () => ({ resolved: true as const }),
      (e) => ({ resolved: false as const, e }),
    );
    // Let a couple of ticks sample metrics, then abort.
    await vi.advanceTimersByTimeAsync(STABILITY_TICK_MS * 2 + 10);
    const callsAtAbort = page.evaluate.mock.calls.length;
    // While active, settle owns two timers (budget + the in-flight tick) on top
    // of the probe wait's own timer (which Playwright, not settle, cancels on
    // page close). Capture the live count so we can prove settle clears ITS two.
    const timersWhileActive = vi.getTimerCount();
    controller.abort(new Error('aborted'));
    const o = await outcome;
    expect(o.resolved).toBe(false);
    // Advance well past several more tick intervals: if teardown were skipped,
    // the poller would keep calling evaluate every STABILITY_TICK_MS.
    await vi.advanceTimersByTimeAsync(STABILITY_TICK_MS * 5);
    // The load-bearing proof: the poller stopped sampling the moment abort won.
    expect(page.evaluate.mock.calls.length).toBe(callsAtAbort);
    // And settle tore down the two timers it owns (budget + tick).
    expect(vi.getTimerCount()).toBe(timersWhileActive - 2);
  });

  it('a networkidle rejection is swallowed (best-effort) and settle still completes', async () => {
    vi.useFakeTimers();
    const page = makeFakePage({
      networkidleRejects: true,
      probeResolvesAtMs: 0,
      metrics: [{ textLen: 900, nodes: 15 }],
    });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;
    expect(result.settledBy).toBe('probe');
  });

  it('epsilon: deltas < 2% AND < 40 chars are stable; a 5% growth tick resets stability', async () => {
    vi.useFakeTimers();
    // 1000 → 1010 (1%, 10 chars: stable) → 1015 (<1%, 5 chars: stable) would
    // reach stability, so instead inject a 5% jump on the second transition to
    // prove it RESETS, then two genuinely-stable ticks to finally settle.
    const page = makeFakePage({
      metrics: [
        { textLen: 1000, nodes: 20 }, // baseline
        { textLen: 1010, nodes: 20 }, // +10 chars, +1% → stable tick 1
        { textLen: 1060, nodes: 21 }, // +50 chars, +5% → RESET (not stable)
        { textLen: 1065, nodes: 21 }, // +5 chars, <1% → stable tick 1 again
        { textLen: 1065, nodes: 21 }, // +0 → stable tick 2 → settle
      ],
    });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(POST_GOTO_CAP_MS);
    const result = await p;
    // If the 5% jump had NOT reset, stability would have fired one tick early
    // at a smaller textLen. Settling only at 1065 proves the reset happened.
    expect(result.settledBy).toBe('stability');
    expect(result.lastMetrics?.textLen).toBe(1065);
  });

  it('a zero-content shell (textLen 0, flat) never settles via stability — only budget', async () => {
    vi.useFakeTimers();
    // A nav-only SPA shell: CONTENT_METRICS_SOURCE nets out chrome text, so a
    // pure shell reports textLen 0 forever. isStable's ratio guard treats a
    // prev.textLen of 0 as "not stable" (ratio = 1), so the stability gate can
    // never fire on a shell — only the probe (never here) or the budget ends it.
    // This is the unit-level guard for what the delayed-mount corpus proves e2e.
    const page = makeFakePage({
      metrics: Array.from({ length: 50 }, () => ({ textLen: 0, nodes: 0 })),
    });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(POST_GOTO_CAP_MS + 100);
    const result = await p;
    expect(result.settledBy).toBe('budget');
  });

  it('reads the DOM verdict after the gate and returns a completeness label', async () => {
    vi.useFakeTimers();
    // Probe fires immediately (content_verified path) and the final verdict
    // reports real content → full/content_verified.
    const page = makeFakePage({
      probeResolvesAtMs: 0,
      metrics: [{ textLen: 1000, nodes: 20 }],
      verdict: { hasContent: true, hasSpaRoot: false, hasNavChrome: false, nearEmpty: false },
    });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;
    expect(result.settledBy).toBe('probe');
    expect(result.completeness).toEqual({
      level: 'full',
      reason: 'content_verified',
      settled_by: 'probe',
    });
  });

  it('growing-forever SPA shell → budget exit → partial/never_settled completeness', async () => {
    vi.useFakeTimers();
    // Content grows every tick so stability never fires; the probe never
    // resolves; budget wins with stillGrowing=true. Final verdict has an SPA
    // root but no article yet → never_settled (partial), the "cut off
    // mid-mount" label — NOT app_shell, because growth was still active.
    const grow = Array.from({ length: 50 }, (_v, i) => ({ textLen: 200 + i * 300, nodes: 1 }));
    const page = makeFakePage({
      metrics: grow,
      verdict: { hasContent: false, hasSpaRoot: true, hasNavChrome: false, nearEmpty: false },
    });
    const p = settlePage(page, {});
    await vi.advanceTimersByTimeAsync(POST_GOTO_CAP_MS + 100);
    const result = await p;
    expect(result.settledBy).toBe('budget');
    expect(result.stillGrowing).toBe(true);
    expect(result.completeness).toEqual({
      level: 'partial',
      reason: 'never_settled',
      settled_by: 'budget',
    });
  });

  it('abort DURING the networkidle slice rejects with the reason, before the gate', async () => {
    // Deferred Task-3 coverage: the networkidle wait (before the gate phase)
    // must honor abort. The fake networkidle never resolves; abort fires during
    // it → settlePage rejects with the reason and never enters the gate.
    vi.useFakeTimers();
    let gateEntered = false;
    const controller = new AbortController();
    const reason = new Error('caller budget exhausted mid-networkidle');
    const page = {
      waitForLoadState: vi.fn().mockImplementation(() => new Promise(() => {})), // never resolves
      waitForFunction: vi.fn().mockImplementation(() => {
        gateEntered = true;
        return new Promise(() => {});
      }),
      evaluate: vi.fn().mockImplementation((src: string) => {
        if (src === DOM_VERDICT_SOURCE) return Promise.resolve({ hasContent: false, hasSpaRoot: false, hasNavChrome: false, nearEmpty: true });
        gateEntered = true;
        return Promise.resolve({ textLen: 0, nodes: 0 });
      }),
    };
    const p = settlePage(page, { signal: controller.signal });
    const outcome = p.then(
      (r) => ({ resolved: true as const, r }),
      (e) => ({ resolved: false as const, e }),
    );
    await vi.advanceTimersByTimeAsync(5);
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(5);
    const o = await outcome;
    expect(o.resolved).toBe(false);
    if (!o.resolved) expect(o.e).toBe(reason);
    // The abort during networkidle short-circuited before any gate work.
    expect(gateEntered).toBe(false);
  });
});

describe('toCompleteness — closed reason mapping (challenge_shell is browser-pool only)', () => {
  const V = (o: Partial<DomVerdict>): DomVerdict => ({
    hasContent: false,
    hasSpaRoot: false,
    hasNavChrome: false,
    nearEmpty: false,
    ...o,
  });

  it('nearEmpty beats everything → shell/empty (even at budget-with-growth)', () => {
    expect(toCompleteness('budget', V({ nearEmpty: true, hasContent: true }), true)).toEqual({
      level: 'shell',
      reason: 'empty',
      settled_by: 'budget',
    });
  });

  it('content + probe → full/content_verified', () => {
    expect(toCompleteness('probe', V({ hasContent: true }), false)).toEqual({
      level: 'full',
      reason: 'content_verified',
      settled_by: 'probe',
    });
  });

  it('content + stability → full/stable_content', () => {
    expect(toCompleteness('stability', V({ hasContent: true }), false)).toEqual({
      level: 'full',
      reason: 'stable_content',
      settled_by: 'stability',
    });
  });

  it('content + budget-with-growth → partial/never_settled (growth cut off mid-mount)', () => {
    expect(toCompleteness('budget', V({ hasContent: true }), true)).toEqual({
      level: 'partial',
      reason: 'never_settled',
      settled_by: 'budget',
    });
  });

  it('content + budget-without-growth → full/stable_content', () => {
    expect(toCompleteness('budget', V({ hasContent: true }), false)).toEqual({
      level: 'full',
      reason: 'stable_content',
      settled_by: 'budget',
    });
  });

  it('no content + budget-with-growth → partial/never_settled', () => {
    expect(toCompleteness('budget', V({ hasContent: false }), true)).toEqual({
      level: 'partial',
      reason: 'never_settled',
      settled_by: 'budget',
    });
  });

  it('no content + SPA root → shell/app_shell (app_shell REQUIRES an SPA root)', () => {
    expect(toCompleteness('budget', V({ hasSpaRoot: true }), false)).toEqual({
      level: 'shell',
      reason: 'app_shell',
      settled_by: 'budget',
    });
  });

  it('no content + nav chrome (no SPA root) → shell/nav_shell (nav_shell REQUIRES nav chrome)', () => {
    expect(toCompleteness('stability', V({ hasNavChrome: true }), false)).toEqual({
      level: 'shell',
      reason: 'nav_shell',
      settled_by: 'stability',
    });
  });

  it('no content + NO frame evidence (no SPA root, no nav chrome) → partial/thin_content', () => {
    // The refinement: a rendered-but-thin frameless page (example.com, HN) is
    // NOT an un-rendered shell — it has no chrome/root to BE a shell. It must
    // not be shell-excluded from research / marked cache-stale.
    expect(toCompleteness('stability', V({ hasContent: false, hasSpaRoot: false, hasNavChrome: false }), false)).toEqual({
      level: 'partial',
      reason: 'thin_content',
      settled_by: 'stability',
    });
  });

  it('SPA root takes precedence over nav chrome when both present → app_shell', () => {
    expect(toCompleteness('budget', V({ hasSpaRoot: true, hasNavChrome: true }), false)).toEqual({
      level: 'shell',
      reason: 'app_shell',
      settled_by: 'budget',
    });
  });
});
