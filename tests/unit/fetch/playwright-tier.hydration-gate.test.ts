import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// React.dev (and any SSR nav-shell SPA) clears `networkidle` almost
// immediately — the shell's bundle requests settle while <main> is still
// empty. The render-tier capture MUST gate on the hydration probe, NOT race
// the probe against networkidle: a race resolves on whichever settles first,
// so a fast networkidle short-circuits the probe and `page.content()` captures
// nav-only HTML. This test pins the ordering deterministically (no real
// browser): the body-presence probe resolves LATE, networkidle resolves
// EARLY, and we assert capture happens only after the probe resolved.

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
    evaluate: vi.fn().mockResolvedValue('body text'),
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

  it('re-polls with a longer budget when the first wait times out on an app-shell, rather than capturing nav-only', async () => {
    // First waitForFunction call times out (body not mounted yet). The page is
    // an SPA app-shell (evaluate → true). The tier must escalate to a second,
    // longer waitForFunction that succeeds — proving the timeout does NOT
    // silently fall through to a nav-only capture.
    let probeCalls = 0;
    fakePage.waitForFunction = vi.fn().mockImplementation(() => {
      probeCalls += 1;
      if (probeCalls === 1) {
        events.push('probe1:timeout');
        return Promise.reject(new Error('Timeout 800ms exceeded'));
      }
      events.push('probe2:start');
      return new Promise((resolve) => {
        setTimeout(() => {
          probeResolved = true;
          events.push('probe2:resolved');
          resolve(undefined);
        }, 20);
      });
    });
    // App-shell-only: body not yet present → escalation should fire.
    fakePage.evaluate = vi.fn().mockResolvedValue(true);

    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    const result = await fetchWithPlaywright('https://react.dev/reference/react');

    expect(probeCalls).toBe(2); // escalated
    expect(events).toContain('probe1:timeout');
    expect(events).toContain('probe2:resolved');
    expect(events).toContain('content:after-probe');
    expect(events).not.toContain('content:before-probe');
    expect(result.html).toContain('Real Article');
  });

  it('does not escalate when the page is a plain non-SPA doc (no app-shell)', async () => {
    // Probe times out and the page is NOT an SPA app-shell (evaluate → false):
    // a plain page that genuinely has no semantic body. Must capture as-is with
    // no second wait — so already-good/fast non-SPA pages pay no escalation.
    let probeCalls = 0;
    fakePage.waitForFunction = vi.fn().mockImplementation(() => {
      probeCalls += 1;
      events.push(`probe${probeCalls}:timeout`);
      return Promise.reject(new Error('Timeout 800ms exceeded'));
    });
    fakePage.evaluate = vi.fn().mockResolvedValue(false);

    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    await fetchWithPlaywright('https://example.com/');

    expect(probeCalls).toBe(1); // no escalation
    expect(events).not.toContain('probe2:timeout');
  });

  it('aborts promptly when the signal fires mid-escalation re-poll', async () => {
    // First probe times out → app-shell → escalation re-poll starts. The
    // caller's signal aborts WHILE the second (escalation) wait is pending.
    // The tier must reject with the abort reason promptly, not swallow it into
    // a nav-only capture.
    const controller = new AbortController();
    const abortReason = new DOMException('aborted', 'AbortError');
    let probeCalls = 0;
    fakePage.waitForFunction = vi.fn().mockImplementation(() => {
      probeCalls += 1;
      if (probeCalls === 1) {
        events.push('probe1:timeout');
        return Promise.reject(new Error('Timeout 800ms exceeded'));
      }
      // Escalation wait: never resolves on its own — abort must win.
      events.push('probe2:pending');
      queueMicrotask(() => controller.abort(abortReason));
      return new Promise(() => {});
    });
    fakePage.evaluate = vi.fn().mockResolvedValue(true); // app-shell-only

    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    await expect(
      fetchWithPlaywright('https://react.dev/reference/react', { signal: controller.signal }),
    ).rejects.toBe(abortReason);

    expect(events).toContain('probe2:pending');
    expect(events).not.toContain('content:before-probe');
    expect(events).not.toContain('content:after-probe');
    expect(fakePage.content).not.toHaveBeenCalled();
  });
});

// Perf guard: the three post-goto phases — networkidle wait, probe
// wait, escalation re-poll — must draw from ONE shared deadline, not three
// independent budgets. Signal-less callers (extract.ts, router stealth tier)
// pass no timeoutMs and no signal, so WITHOUT a shared deadline worst-case
// post-goto wall-clock would be ~5s+5s+6s = ~16s (a latency blowup). We
// assert ACTUAL post-goto elapsed wall-clock stays within the cap — and that
// every later leg's granted timeout is clamped to the budget still remaining,
// so a leg can never be handed more than what's left on the shared deadline.
describe('fetchWithPlaywright bounds total post-goto wait by a single shared deadline', () => {
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

  it('keeps total post-goto elapsed within the cap even with no timeoutMs/signal (app-shell escalation path)', async () => {
    vi.useFakeTimers();
    const POST_GOTO_CAP = 6000;
    const startNow = Date.now();
    const waitFnGranted: number[] = [];
    // Remaining budget (deadline - now) at the instant each leg is granted —
    // the tier must never hand a leg more time than the shared deadline has left.
    const budgetLeftAtGrant: number[] = [];

    fakePage.waitForLoadState = vi.fn().mockImplementation((_state: string, opts: { timeout: number }) => {
      budgetLeftAtGrant.push(POST_GOTO_CAP - (Date.now() - startNow));
      // networkidle settles partway through the budget (like a real settle).
      return new Promise((resolve) => setTimeout(() => resolve(undefined), 1000));
    });
    fakePage.waitForFunction = vi.fn().mockImplementation((_src: string, _arg: unknown, opts: { timeout: number }) => {
      waitFnGranted.push(opts.timeout);
      budgetLeftAtGrant.push(POST_GOTO_CAP - (Date.now() - startNow));
      // Each probe wait consumes its full granted timeout then times out.
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error(`Timeout ${opts.timeout}ms exceeded`)), opts.timeout);
      });
    });
    fakePage.evaluate = vi.fn().mockResolvedValue(true); // app-shell-only → escalate

    const { fetchWithPlaywright } = await import('../../../src/fetch/playwright-tier.js');
    // No timeoutMs, no signal — the unbounded-caller case the perf review flagged.
    const promise = fetchWithPlaywright('https://react.dev/reference/react');
    await vi.runAllTimersAsync();
    await promise;

    // Actual post-goto wall-clock (simulated) must not exceed the shared cap —
    // this bounds latency: even unbounded callers stay within budget.
    const elapsed = Date.now() - startNow;
    expect(elapsed).toBeLessThanOrEqual(POST_GOTO_CAP);

    // The escalation leg actually fired (2 probe waits): the shared deadline
    // bound did NOT silently disable the SPA escalation re-poll.
    expect(waitFnGranted.length).toBe(2);

    // No leg was ever granted more time than the shared deadline had left, and
    // its granted timeout never exceeded that remaining budget.
    waitFnGranted.forEach((granted, i) => {
      // waitFn legs are entries 1.. in budgetLeftAtGrant (entry 0 is networkidle).
      const budgetLeft = budgetLeftAtGrant[i + 1];
      expect(granted).toBeLessThanOrEqual(budgetLeft + 1);
    });
  });
});
