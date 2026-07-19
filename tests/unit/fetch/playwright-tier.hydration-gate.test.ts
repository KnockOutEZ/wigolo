import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// React.dev (and any SSR nav-shell SPA) clears `networkidle` almost
// immediately — the shell's bundle requests settle while <main> is still
// empty. The render-tier capture MUST gate on the hydration probe (via the
// shared settlePage), NOT race the probe against networkidle: a race resolves
// on whichever settles first, so a fast networkidle short-circuits the probe
// and `page.content()` captures nav-only HTML. This test pins the behavioral
// contract deterministically (no real browser): the body-presence probe
// resolves LATE, networkidle resolves EARLY, and we assert capture happens
// only after the probe resolved. The concrete wait mechanism lives in
// settlePage (tests/unit/fetch/settle.test.ts); here we assert the tier wires
// it in so capture reflects the hydrated page.

interface FakePage {
  goto: ReturnType<typeof vi.fn>;
  waitForFunction: ReturnType<typeof vi.fn>;
  waitForLoadState: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

const events: string[] = [];
let probeResolved = false;
let fakePage: FakePage;

function makePage(): FakePage {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    // networkidle resolves on the next microtask — i.e. "fast", like react.dev.
    waitForLoadState: vi.fn().mockImplementation(() => {
      events.push('networkidle');
      return Promise.resolve(undefined);
    }),
    // The body-presence probe resolves only after a real delay — the article
    // mounts late. Until it resolves, the captured HTML would be nav-only.
    waitForFunction: vi.fn().mockImplementation(() => {
      events.push('probe:start');
      return new Promise((resolve) => {
        setTimeout(() => {
          probeResolved = true;
          events.push('probe:resolved');
          resolve(undefined);
        }, 40);
      });
    }),
    content: vi.fn().mockImplementation(() => {
      events.push(probeResolved ? 'content:after-probe' : 'content:before-probe');
      return Promise.resolve(
        probeResolved
          ? '<html><body><main><h1>Real Article</h1><p>body</p></main></body></html>'
          : '<html><body><nav>nav only</nav><div id="root"></div></body></html>',
      );
    }),
    // settle's stability poller reads content metrics; harmless while the probe
    // is the winning gate in these tests.
    evaluate: vi.fn().mockResolvedValue({ textLen: 1000, nodes: 20 }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('playwright', () => {
  const launch = vi.fn().mockResolvedValue({
    newContext: vi.fn().mockResolvedValue({
      newPage: vi.fn().mockImplementation(() => fakePage),
      close: vi.fn().mockResolvedValue(undefined),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  });
  const stub = { launch, executablePath: () => '/fake/chrome' };
  return { chromium: stub, firefox: stub, webkit: stub };
});

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>();
  return { ...actual, existsSync: () => true };
});

describe('fetchWithPlaywright gates capture on the hydration probe', () => {
  beforeEach(() => {
    events.length = 0;
    probeResolved = false;
    fakePage = makePage();
  });

  afterEach(async () => {
    const { closeDaemonBrowser } = await import('../../../src/fetch/playwright-tier.js');
    await closeDaemonBrowser().catch(() => undefined);
    vi.resetModules();
  });

  it('captures HTML only after the body-presence probe resolves (not on fast networkidle)', async () => {
    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    const result = await fetchWithPlaywright('https://react.dev/reference/react');

    // The probe must have run and resolved before capture.
    expect(events).toContain('probe:resolved');
    expect(events).toContain('content:after-probe');
    expect(events).not.toContain('content:before-probe');

    // And the captured HTML is the hydrated body, not the nav-only shell.
    expect(result.html).toContain('Real Article');
    expect(result.html).not.toContain('nav only');
  });

  it('settles via the stability poller when the probe never fires, then captures', async () => {
    // The probe never resolves (a page whose body never matches the hydration
    // predicate), so settle must fall back to the stability poller: content
    // stops growing → capture proceeds rather than hanging on the probe. This
    // is the universal fallback the shared settle gives every capture.
    fakePage.waitForFunction = vi.fn().mockImplementation(() => {
      events.push('probe:start');
      // Never resolves; rejects only at its own (large) timeout.
      return new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('Timeout')), 60_000));
    });
    // Metrics flatten immediately → stability gate settles fast.
    fakePage.evaluate = vi.fn().mockImplementation(() => {
      probeResolved = true; // flip so content() returns the hydrated body
      return Promise.resolve({ textLen: 1000, nodes: 20 });
    });

    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    const result = await fetchWithPlaywright('https://react.dev/reference/react');

    expect(events).toContain('probe:start');
    expect(events).toContain('content:after-probe');
    expect(result.html).toContain('Real Article');
  }, 20000);

  it('aborts promptly when the signal fires during the post-goto settle', async () => {
    // The caller's signal aborts WHILE the settle wait is pending. The tier
    // must reject with the abort reason promptly, not swallow it into a
    // nav-only capture.
    const controller = new AbortController();
    const abortReason = new DOMException('aborted', 'AbortError');
    fakePage.waitForFunction = vi.fn().mockImplementation(() => {
      events.push('probe:pending');
      // Never resolves on its own — abort must win the settle race.
      queueMicrotask(() => controller.abort(abortReason));
      return new Promise(() => {});
    });
    // Poller keeps sampling (never flat) so only abort can end the wait.
    let n = 0;
    fakePage.evaluate = vi.fn().mockImplementation(() =>
      Promise.resolve({ textLen: 100 + n++ * 100, nodes: 2 + n }));

    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    await expect(
      fetchWithPlaywright('https://react.dev/reference/react', { signal: controller.signal }),
    ).rejects.toBe(abortReason);

    expect(events).toContain('probe:pending');
    expect(events).not.toContain('content:before-probe');
    expect(events).not.toContain('content:after-probe');
    expect(fakePage.content).not.toHaveBeenCalled();
  });
});

// Perf guard: the post-goto settle must draw from ONE shared deadline capped at
// POST_GOTO_CAP_MS, not run unbounded. Signal-less callers (extract.ts, router
// stealth tier) pass no timeoutMs and no signal, so WITHOUT the shared cap a
// never-idling SPA would hang past the cap (a latency blowup). We assert ACTUAL
// post-goto elapsed wall-clock stays within the cap.
describe('fetchWithPlaywright bounds total post-goto wait by the shared settle cap', () => {
  beforeEach(() => {
    events.length = 0;
    probeResolved = false;
    fakePage = makePage();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { closeDaemonBrowser } = await import('../../../src/fetch/playwright-tier.js');
    await closeDaemonBrowser().catch(() => undefined);
    vi.resetModules();
  });

  it('keeps total post-goto elapsed within the cap even with no timeoutMs/signal (never-settling page)', async () => {
    vi.useFakeTimers();
    const { POST_GOTO_CAP_MS } = await import('../../../src/fetch/settle.js');
    const startNow = Date.now();

    // networkidle settles partway through the budget (like a real settle).
    fakePage.waitForLoadState = vi.fn().mockImplementation(() =>
      new Promise((resolve) => setTimeout(() => resolve(undefined), 1000)));
    // Probe never fires within any granted timeout.
    fakePage.waitForFunction = vi.fn().mockImplementation((_src: string, _arg: unknown, opts: { timeout: number }) =>
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error(`Timeout ${opts.timeout}ms exceeded`)), opts.timeout)));
    // Content keeps growing forever → stability never fires either; only the
    // shared budget can end the settle.
    let n = 0;
    fakePage.evaluate = vi.fn().mockImplementation(() =>
      Promise.resolve({ textLen: 500 + n++ * 500, nodes: 10 + n }));

    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    // No timeoutMs, no signal — the unbounded-caller case the perf review flagged.
    const promise = fetchWithPlaywright('https://react.dev/reference/react');
    await vi.runAllTimersAsync();
    await promise;

    // Actual post-goto wall-clock (simulated) must not exceed the shared cap —
    // this bounds latency: even unbounded callers stay within budget.
    const elapsed = Date.now() - startNow;
    expect(elapsed).toBeLessThanOrEqual(POST_GOTO_CAP_MS + 500);
  });
});
