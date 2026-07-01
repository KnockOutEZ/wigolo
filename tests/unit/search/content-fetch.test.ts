import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchResultItem, RawFetchResult, ExtractionResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

vi.mock('../../../src/cache/store.js', () => ({
  cacheContent: vi.fn(),
}));

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    isAvailable: () => false,
    embedAsync: vi.fn(),
  }),
}));

const extractMock = vi.fn<(html: string, url: string, options?: unknown) => Promise<ExtractionResult>>();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { fetchContentForResults } from '../../../src/search/content-fetch.js';

function makeRaw(url: string, html = '<html><body>ok</body></html>'): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
}

function makeResult(url: string): SearchResultItem {
  return {
    title: `T-${url}`,
    url,
    snippet: 's',
    relevance_score: 1,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  extractMock.mockImplementation(async (_html, url) => ({
    title: `T-${url}`,
    markdown: `# Body for ${url}`,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }));
});

describe('fetchContentForResults — max_fetches cap', () => {
  it('fetches only up to max_fetches when cap is 1', async () => {
    const router = {
      fetch: vi.fn(async (url: string) => makeRaw(url)),
    } as unknown as SmartRouter;
    const results = [
      makeResult('https://a.com/1'),
      makeResult('https://a.com/2'),
      makeResult('https://a.com/3'),
    ];

    await fetchContentForResults(results, router, {
      contentMaxChars: 1000,
      maxTotalChars: 10000,
      fetchTimeoutMs: 5000,
      totalDeadline: Date.now() + 60000,
      forceRefresh: false,
      maxFetches: 1,
    });

    // Only one URL actually fetched.
    expect((router.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(results[0].markdown_content).toBeDefined();
    expect(results[1].markdown_content).toBeUndefined();
    expect(results[2].markdown_content).toBeUndefined();
  });
});

// --- backup-fetch behavior ---
//
// WHY: when the top-N parallel fetches lose one to a transient timeout,
// callers could get fewer pages than they asked for.
// The fix: try `results[maxFetches..]` sequentially as backups when there's
// remaining budget. `max_fetches: 1` is exempt — a literal cap of 1 must
// not silently fetch a second URL.

describe('fetchContentForResults — M16 backup behavior', () => {
  it('does NOT try a backup when max_fetches is 1 and the top-1 fails (respects literal cap)', async () => {
    const router = {
      fetch: vi.fn(async () => {
        throw new Error('timeout');
      }),
    } as unknown as SmartRouter;
    const results = [
      makeResult('https://a.com/1'),
      makeResult('https://a.com/2'),
    ];

    await fetchContentForResults(results, router, {
      contentMaxChars: 1000,
      maxTotalChars: 10000,
      fetchTimeoutMs: 1000,
      totalDeadline: Date.now() + 60000,
      forceRefresh: false,
      maxFetches: 1,
    });

    // Exactly one router.fetch call — the cap is respected, no fallback.
    expect((router.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(results[0].fetch_failed).toBeDefined();
    expect(results[1].markdown_content).toBeUndefined();
  });

  it('tries a backup when max_fetches=2, top-1 fails, and a backup URL is available', async () => {
    let callCount = 0;
    const router = {
      fetch: vi.fn(async (url: string) => {
        callCount++;
        // Fail the first attempt, succeed everything else.
        if (callCount === 1) throw new Error('timeout');
        return makeRaw(url);
      }),
    } as unknown as SmartRouter;
    const results = [
      makeResult('https://a.com/top-1'),
      makeResult('https://a.com/top-2'),
      makeResult('https://a.com/backup-3'),
    ];

    await fetchContentForResults(results, router, {
      contentMaxChars: 1000,
      maxTotalChars: 10000,
      fetchTimeoutMs: 5000,
      totalDeadline: Date.now() + 60000,
      forceRefresh: false,
      maxFetches: 2,
    });

    // The top-1 should be marked failed, top-2 should have content, and
    // the backup-3 should ALSO have content (filled in for top-1).
    expect(results[0].fetch_failed).toBeDefined();
    expect(results[1].markdown_content).toBeDefined();
    expect(results[2].markdown_content).toBeDefined();
    // 2 top + 1 backup = 3 router.fetch calls.
    expect((router.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it('does NOT exceed max_fetches successful pages when backup succeeds (cap-respecting)', async () => {
    let callCount = 0;
    const router = {
      fetch: vi.fn(async (url: string) => {
        callCount++;
        if (callCount === 1) throw new Error('timeout');
        return makeRaw(url);
      }),
    } as unknown as SmartRouter;
    const results = [
      makeResult('https://a.com/top-1'),
      makeResult('https://a.com/top-2'),
      makeResult('https://a.com/backup-3'),
      makeResult('https://a.com/backup-4'),
    ];

    await fetchContentForResults(results, router, {
      contentMaxChars: 1000,
      maxTotalChars: 10000,
      fetchTimeoutMs: 5000,
      totalDeadline: Date.now() + 60000,
      forceRefresh: false,
      maxFetches: 2,
    });

    // Two slots had failures originally? Only the top-1 — top-2 succeeded.
    // So we only need ONE backup; the second backup must NOT be attempted.
    const successfulPages = results.filter((r) => r.markdown_content !== undefined).length;
    // Cap was 2 + 1 successful backup = 2 (or 3 if we count the original
    // failed top-1 still in results with no content). The contract is
    // "no more than cap successful fetches": top-2 + backup-3.
    expect(successfulPages).toBe(2);
    expect(results[3].markdown_content).toBeUndefined();
  });

  it('skips fallback when totalDeadline has passed', async () => {
    let callCount = 0;
    const router = {
      fetch: vi.fn(async () => {
        callCount++;
        // First call fails immediately. Backup must not be tried because
        // we'll set totalDeadline to the past below.
        throw new Error('timeout');
      }),
    } as unknown as SmartRouter;
    const results = [
      makeResult('https://a.com/top-1'),
      makeResult('https://a.com/top-2'),
      makeResult('https://a.com/backup-3'),
    ];

    // totalDeadline in the past — backup loop must early-out via the
    // Date.now() < ctx.totalDeadline guard.
    await fetchContentForResults(results, router, {
      contentMaxChars: 1000,
      maxTotalChars: 10000,
      fetchTimeoutMs: 5000,
      totalDeadline: Date.now() - 1,
      forceRefresh: false,
      maxFetches: 2,
    });

    // Top-1 and top-2 attempted in parallel (totalDeadline check is per-fetch);
    // backup is not attempted because deadline has passed before backup loop.
    // Allow 0-2 calls depending on whether the per-fetch check fires.
    expect(callCount).toBeLessThanOrEqual(2);
  });

  // --- backup fetches must run in PARALLEL waves,
  // not slot-by-slot. The original loop awaited each backup sequentially,
  // which on the very requests that already had a bad day (all top fetches
  // failed) inflated wall-clock to N × fetchTimeoutMs. This test pins the
  // contract: backups for independent failed slots fire concurrently.
  it('fires backup-fetch wave in parallel, not slot-by-slot', async () => {
    const fetchEntries: number[] = [];
    const router = {
      fetch: vi.fn(async (url: string) => {
        fetchEntries.push(Date.now());
        // Top fetches (any /top-) fail; backups (any /backup-) succeed
        // after a small delay to keep their windows wide enough to detect
        // sequential vs parallel.
        if (url.includes('/top-')) {
          throw new Error('timeout');
        }
        await new Promise((r) => setTimeout(r, 50));
        return makeRaw(url);
      }),
    } as unknown as SmartRouter;

    const cap = 5;
    const results: SearchResultItem[] = [];
    for (let i = 0; i < cap; i++) results.push(makeResult(`https://a.com/top-${i}`));
    for (let i = 0; i < cap; i++) results.push(makeResult(`https://a.com/backup-${i}`));

    await fetchContentForResults(results, router, {
      contentMaxChars: 1000,
      maxTotalChars: 10000,
      fetchTimeoutMs: 5000,
      totalDeadline: Date.now() + 60000,
      forceRefresh: false,
      maxFetches: cap,
    });

    // All 5 top fetches fired in parallel (the wave starts at roughly the
    // same instant) — that part already worked before this fix.
    expect(fetchEntries.length).toBe(2 * cap); // 5 top + 5 backups
    const topEntries = fetchEntries.slice(0, cap);
    const backupEntries = fetchEntries.slice(cap);

    // The contract: backup entry timestamps should overlap (be issued
    // concurrently), not serialize. Sequential mode would space them ≥ 50ms
    // apart (each await blocks the next). Parallel mode should keep the
    // window well under one fetch duration.
    const backupSpread = Math.max(...backupEntries) - Math.min(...backupEntries);
    expect(backupSpread).toBeLessThan(40);

    // And both top + backup waves should land before sequential mode could
    // (sequential = 5 × 50 = 250ms minimum for the backup loop alone).
    const topStart = Math.min(...topEntries);
    const backupEnd = Math.max(...backupEntries);
    expect(backupEnd - topStart).toBeLessThan(150);

    // Every slot got filled — 5 backups for 5 failed tops.
    const filled = results.filter((r) => r.markdown_content !== undefined).length;
    expect(filled).toBe(cap);
  });

  it('does NOT exceed cap when first backup wave succeeds for fewer than all failed slots', async () => {
    const router = {
      fetch: vi.fn(async (url: string) => {
        // Top: fail. First two backups: fail. Remaining: succeed.
        if (url.includes('/top-')) throw new Error('top-fail');
        if (url.includes('/backup-0') || url.includes('/backup-1')) {
          throw new Error('backup-fail');
        }
        return makeRaw(url);
      }),
    } as unknown as SmartRouter;

    const cap = 3;
    const results: SearchResultItem[] = [
      makeResult('https://a.com/top-0'),
      makeResult('https://a.com/top-1'),
      makeResult('https://a.com/top-2'),
      makeResult('https://a.com/backup-0'), // fails
      makeResult('https://a.com/backup-1'), // fails
      makeResult('https://a.com/backup-2'), // succeeds
      makeResult('https://a.com/backup-3'), // succeeds
      makeResult('https://a.com/backup-4'), // succeeds
    ];

    await fetchContentForResults(results, router, {
      contentMaxChars: 1000,
      maxTotalChars: 10000,
      fetchTimeoutMs: 5000,
      totalDeadline: Date.now() + 60000,
      forceRefresh: false,
      maxFetches: cap,
    });

    const filled = results.filter((r) => r.markdown_content !== undefined).length;
    // Exactly cap successful pages — no more, no less.
    expect(filled).toBe(cap);
  });
});

// --- Task 6: Hedged stage return + abort orchestration ---
//
// WHY: content-fetch is the latency bottleneck in search. Without a stage budget,
// one slow target page stalls the entire search response. The stage AbortController
// fires at stageBudgetMs, signals all in-flight fetches, and the results are
// returned immediately with fast ones hydrated and slow ones flagged snippet-only.

describe('fetchContentForResults — stage budget abort orchestration', () => {
  afterEach(() => vi.useRealTimers());

  function mockRouter(impl: (url: string, opts: { signal?: AbortSignal; [k: string]: unknown }) => Promise<unknown>) {
    return { fetch: vi.fn(impl) } as unknown as SmartRouter;
  }

  const item = (url: string): SearchResultItem => ({ title: url, url, snippet: 's', relevance_score: 1 });

  // fetchTimeoutMs must be > stageBudgetMs so that the stage timer fires first
  // when testing stage_timeout (per-URL timeout would win otherwise).
  const baseCtx = (over: Partial<Parameters<typeof fetchContentForResults>[2]> = {}): Parameters<typeof fetchContentForResults>[2] => ({
    contentMaxChars: 30000,
    maxTotalChars: 50000,
    fetchTimeoutMs: 5000,
    totalDeadline: Date.now() + 30000,
    forceRefresh: false,
    stageBudgetMs: 4000,
    ...over,
  });

  it('returns hydrated fast results and flags the slow one stage_timeout at the budget', async () => {
    vi.useFakeTimers();
    const results = [item('a'), item('b'), item('slow')];
    const router = mockRouter((url, opts) => {
      if (url === 'slow') {
        return new Promise((_, rej) =>
          opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason)),
        );
      }
      return Promise.resolve({ html: `<html><body>${url}</body></html>`, finalUrl: url, contentType: 'text/html', statusCode: 200, method: 'http', headers: {} });
    });
    const p = fetchContentForResults(results, router, baseCtx());
    await vi.advanceTimersByTimeAsync(4000);
    await p;
    expect(results[0].markdown_content).toBeDefined();
    expect(results[1].markdown_content).toBeDefined();
    expect(results[2].fetch_failed).toBe('stage_timeout');
    expect(results[2].markdown_content).toBeUndefined();
  });

  it('the aborted fetch actually receives an aborted signal (no dangling work)', async () => {
    vi.useFakeTimers();
    let captured: AbortSignal | undefined;
    const router = mockRouter((url, opts) => {
      captured = opts.signal;
      return new Promise((_, rej) =>
        opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason)),
      );
    });
    const p = fetchContentForResults([item('slow')], router, baseCtx());
    await vi.advanceTimersByTimeAsync(4000);
    await p;
    expect(captured?.aborted).toBe(true);
  });

  it('per-URL timeout flags timeout (distinct from stage_timeout)', async () => {
    vi.useFakeTimers();
    // perUrl 3000 < stage 10000: a single slow URL trips the per-URL leg first
    const router = mockRouter((_url, opts) =>
      new Promise((_, rej) =>
        opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason)),
      ),
    );
    const results = [item('slow')];
    const p = fetchContentForResults(results, router, baseCtx({ fetchTimeoutMs: 3000, stageBudgetMs: 10000 }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(results[0].fetch_failed).toBe('timeout');
  });

  it('does not emit an unhandled rejection when work rejects after abort', async () => {
    vi.useFakeTimers();
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    const router = mockRouter((_url, opts) =>
      new Promise((_, rej) => {
        opts.signal?.addEventListener('abort', () =>
          setTimeout(() => rej(new Error('late socket error')), 5),
        );
      }),
    );
    const p = fetchContentForResults([item('slow')], router, baseCtx());
    await vi.advanceTimersByTimeAsync(4100);
    await p;
    await vi.advanceTimersByTimeAsync(50);
    process.off('unhandledRejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it('back-compat: no stageBudgetMs => per-URL casualty still flagged "timeout"', async () => {
    vi.useFakeTimers();
    const router = mockRouter((_url, opts) =>
      new Promise((_, rej) =>
        opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason)),
      ),
    );
    const results = [item('slow')];
    const p = fetchContentForResults(
      results,
      router,
      baseCtx({ stageBudgetMs: undefined, fetchTimeoutMs: 15000, totalDeadline: Date.now() + 30000 }),
    );
    await vi.advanceTimersByTimeAsync(15000);
    await p;
    expect(results[0].fetch_failed).toBe('timeout');
  });
});

// --- Dedicated per-URL budget for anti-bot/TLS-first domains
//
// WHY: the router routes anti-bot/timeout-prone domains (stackoverflow.com et
// al.) through the TLS-impersonation tier FIRST on the search-hydration path. A
// working TLS attempt takes ~1-5s, but the shared balanced per-URL budget
// (searchFetchTimeoutBalancedMs ~= 3000ms) starves it under parallel fetch —
// the tier is selected but never gets enough time, producing fetch_failed:
// timeout. The fix gives anti-bot/TLS-first domains a LARGER per-URL budget
// (capped by the stage budget so the overall stage stays bounded — no runaway
// blowup), while non-anti-bot domains keep the small budget.

describe('fetchContentForResults — anti-bot/TLS-first per-URL budget', () => {
  afterEach(() => vi.useRealTimers());

  function mockRouter(impl: (url: string, opts: { signal?: AbortSignal; [k: string]: unknown }) => Promise<unknown>) {
    return { fetch: vi.fn(impl) } as unknown as SmartRouter;
  }
  const item = (url: string): SearchResultItem => ({ title: url, url, snippet: 's', relevance_score: 1 });

  // A fetch that resolves only after `delayMs`, but rejects early if the
  // per-URL (or stage) abort fires first. Models a slow-but-eventually-OK
  // TLS attempt.
  function slowFetch(delayMs: number, url: string) {
    return (_u: string, opts: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(
          () =>
            resolve({
              html: `<html><body>${url}</body></html>`,
              finalUrl: url,
              contentType: 'text/html',
              statusCode: 200,
              method: 'tls-impersonation',
              headers: {},
            }),
          delayMs,
        );
        opts.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(opts.signal!.reason);
        });
      });
  }

  // Stage budget 6000ms > anti-bot needs; per-URL fetchTimeoutMs 3000ms would
  // starve a 3500ms TLS attempt under the OLD shared budget.
  const ctx = (over: Partial<Parameters<typeof fetchContentForResults>[2]> = {}): Parameters<typeof fetchContentForResults>[2] => ({
    contentMaxChars: 30000,
    maxTotalChars: 50000,
    fetchTimeoutMs: 3000,
    totalDeadline: Date.now() + 30000,
    forceRefresh: false,
    stageBudgetMs: 6000,
    ...over,
  });

  it('gives a known anti-bot/TLS-first domain (stackoverflow.com) the larger budget so a ~3.5s attempt completes', async () => {
    vi.useFakeTimers();
    const url = 'https://stackoverflow.com/questions/123/x';
    const router = mockRouter(slowFetch(3500, url));
    const results = [item(url)];
    const p = fetchContentForResults(results, router, ctx());
    // Advance past the OLD shared budget (3000ms) — a non-anti-bot URL would
    // have timed out here — then past the 3500ms TLS attempt.
    await vi.advanceTimersByTimeAsync(3500);
    await p;
    expect(results[0].fetch_failed).toBeUndefined();
    expect(results[0].markdown_content).toBeDefined();
  });

  it('keeps a non-anti-bot domain on the SMALL budget — a ~3.5s attempt still times out at fetchTimeoutMs', async () => {
    vi.useFakeTimers();
    const url = 'https://example.com/article';
    const router = mockRouter(slowFetch(3500, url));
    const results = [item(url)];
    const p = fetchContentForResults(results, router, ctx());
    await vi.advanceTimersByTimeAsync(3500);
    await p;
    // The small (3000ms) per-URL budget fires before the 3500ms attempt
    // resolves — proves the budget differs by domain class (no blanket bump).
    expect(results[0].fetch_failed).toBe('timeout');
    expect(results[0].markdown_content).toBeUndefined();
  });

  it('keeps the OVERALL stage bounded — anti-bot per-URL budget never exceeds the stage budget (latency ceiling)', async () => {
    vi.useFakeTimers();
    const url = 'https://stackoverflow.com/questions/456/y';
    // Attempt would take 9s — longer than the 6000ms stage budget. The stage
    // timer MUST cut it off at the stage budget, NOT let the larger anti-bot
    // per-URL budget run unbounded.
    const router = mockRouter(slowFetch(9000, url));
    const results = [item(url)];
    const start = Date.now();
    const p = fetchContentForResults(results, router, ctx({ stageBudgetMs: 6000 }));
    await vi.advanceTimersByTimeAsync(6000);
    await p;
    const elapsed = Date.now() - start;
    // Bounded by the stage budget, not the 9s attempt.
    expect(elapsed).toBeLessThanOrEqual(6500);
    expect(results[0].fetch_failed).toBe('stage_timeout');
  });
});
