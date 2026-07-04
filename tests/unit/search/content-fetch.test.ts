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

// --- Narrow-set per-URL budget scaling
//
// WHY: with a WIDE candidate set the small balanced per-URL budget spread over
// many URLs keeps overall latency bounded. But with a NARROW set (2-3 results)
// each URL deserves proportionally more time — the stage budget would otherwise
// be left mostly unspent while a single slow page times out at the small
// default. The scaling keys on candidateCount (a STRUCTURAL signal), never a
// domain allowlist, and is always clamped to the stage budget so latency stays
// bounded. A WIDE set falls back to today's small budget (scaled < base).

describe('fetchContentForResults — narrow-set budget scaling', () => {
  afterEach(() => vi.useRealTimers());

  function mockRouter(impl: (url: string, opts: { signal?: AbortSignal; [k: string]: unknown }) => Promise<unknown>) {
    return { fetch: vi.fn(impl) } as unknown as SmartRouter;
  }
  const item = (url: string): SearchResultItem => ({ title: url, url, snippet: 's', relevance_score: 1 });

  // Resolves after delayMs unless the abort fires first — models a
  // slow-but-eventually-OK non-anti-bot page.
  function slowFetch(delayMs: number, url: string) {
    return (_u: string, opts: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(
          () => resolve({ html: `<html><body>${url}</body></html>`, finalUrl: url, contentType: 'text/html', statusCode: 200, method: 'http', headers: {} }),
          delayMs,
        );
        opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal!.reason); });
      });
  }

  const ctx = (over: Partial<Parameters<typeof fetchContentForResults>[2]> = {}): Parameters<typeof fetchContentForResults>[2] => ({
    contentMaxChars: 30000,
    maxTotalChars: 50000,
    fetchTimeoutMs: 2000, // small base per-URL budget
    totalDeadline: Date.now() + 30000,
    forceRefresh: false,
    stageBudgetMs: 8000,
    narrowSetBudgetMs: 6000,
    ...over,
  });

  it('gives a NARROW candidate set (2 results) a LARGER per-URL budget than the small base — a ~2.5s non-anti-bot fetch completes', async () => {
    vi.useFakeTimers();
    // Two candidates; each page takes 2500ms. Under the OLD 2000ms base they
    // would time out; with narrowSetBudgetMs=6000 / 2 candidates = 3000ms each,
    // the 2500ms fetch completes comfortably within the scaled budget.
    const urls = ['https://example.com/a', 'https://example.com/b'];
    const router = mockRouter((u, opts) => slowFetch(2500, u)(u, opts));
    const results = urls.map(item);
    const p = fetchContentForResults(results, router, ctx({ candidateCount: 2 }));
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    expect(results[0].fetch_failed).toBeUndefined();
    expect(results[0].markdown_content).toBeDefined();
    expect(results[1].fetch_failed).toBeUndefined();
    expect(results[1].markdown_content).toBeDefined();
  });

  it('keeps a WIDE candidate set on the small base budget — the scaled slice is below the base, so today\'s budget wins', async () => {
    vi.useFakeTimers();
    // Six candidates: 6000 / 6 = 1000ms scaled slice < 2000ms base, so the base
    // budget (today's behavior) is used — a 3000ms fetch times out.
    const url = 'https://example.com/wide';
    const router = mockRouter(slowFetch(3000, url));
    const results = [item(url)];
    const p = fetchContentForResults(results, router, ctx({ candidateCount: 6 }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(results[0].fetch_failed).toBe('timeout');
    expect(results[0].markdown_content).toBeUndefined();
  });

  it('never exceeds the stage budget even for a single candidate (latency ceiling)', async () => {
    vi.useFakeTimers();
    // narrowSetBudgetMs=6000 / 1 = 6000ms scaled, but the stage budget is 4000ms
    // — the scaled per-URL budget MUST be clamped to the stage ceiling so the
    // stage timer (not the per-URL timer) caps wall-clock.
    const url = 'https://example.com/single';
    const router = mockRouter(slowFetch(9000, url));
    const results = [item(url)];
    const start = Date.now();
    const p = fetchContentForResults(results, router, ctx({ candidateCount: 1, stageBudgetMs: 4000 }));
    await vi.advanceTimersByTimeAsync(4000);
    await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThanOrEqual(4500);
    expect(results[0].fetch_failed).toBe('stage_timeout');
  });

  it('back-compat: no narrowSetBudgetMs => small base budget regardless of candidate count', async () => {
    vi.useFakeTimers();
    const url = 'https://example.com/legacy';
    const router = mockRouter(slowFetch(3000, url));
    const results = [item(url)];
    // narrowSetBudgetMs undefined: legacy path, base 2000ms fires before 3000ms.
    const p = fetchContentForResults(results, router, ctx({ candidateCount: 1, narrowSetBudgetMs: undefined }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(results[0].fetch_failed).toBe('timeout');
  });
});

// --- Snippet fallback on timeout
//
// WHY: an empty markdown_content with only fetch_failed is worse for the host
// LLM than the result's own snippet. On a per-URL/stage timeout, fall back to
// the result's existing snippet as markdown_content (flagged content_from_snippet)
// so callers get evidence text. The failure is still recorded (fetch_failed
// stays set). Never fabricate — only the result's real snippet is used, and
// only when snippetFallback is enabled (legacy default is off: empty content).

describe('fetchContentForResults — snippet fallback on timeout', () => {
  afterEach(() => vi.useRealTimers());

  function mockRouter(impl: (url: string, opts: { signal?: AbortSignal; [k: string]: unknown }) => Promise<unknown>) {
    return { fetch: vi.fn(impl) } as unknown as SmartRouter;
  }
  const item = (url: string, snippet: string): SearchResultItem => ({ title: url, url, snippet, relevance_score: 1 });

  const ctx = (over: Partial<Parameters<typeof fetchContentForResults>[2]> = {}): Parameters<typeof fetchContentForResults>[2] => ({
    contentMaxChars: 30000,
    maxTotalChars: 50000,
    fetchTimeoutMs: 2000,
    totalDeadline: Date.now() + 30000,
    forceRefresh: false,
    stageBudgetMs: 6000,
    snippetFallback: true,
    ...over,
  });

  it('on a per-URL timeout, keeps the snippet as markdown_content (content_from_snippet) instead of empty content', async () => {
    vi.useFakeTimers();
    const router = mockRouter((_u, opts) =>
      new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason))),
    );
    const results = [item('https://example.com/slow', 'This snippet is real evidence text.')];
    const p = fetchContentForResults(results, router, ctx());
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    // Failure still recorded AND snippet promoted into content.
    expect(results[0].fetch_failed).toBe('timeout');
    expect(results[0].markdown_content).toBe('This snippet is real evidence text.');
    expect(results[0].content_from_snippet).toBe(true);
  });

  it('on a stage timeout, promotes the snippet for the slow result while fast results keep their fetched content', async () => {
    vi.useFakeTimers();
    const results = [item('a', 'snip-a'), item('slow', 'slow snippet fallback')];
    const router = mockRouter((url, opts) => {
      if (url === 'slow') {
        return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason)));
      }
      return Promise.resolve({ html: `<html><body>${url}</body></html>`, finalUrl: url, contentType: 'text/html', statusCode: 200, method: 'http', headers: {} });
    });
    // fetchTimeoutMs > stageBudgetMs so the stage timer wins for the slow one.
    const p = fetchContentForResults(results, router, ctx({ fetchTimeoutMs: 10000, stageBudgetMs: 3000 }));
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(results[0].markdown_content).toContain('a');
    expect(results[0].content_from_snippet).toBeUndefined();
    expect(results[1].fetch_failed).toBe('stage_timeout');
    expect(results[1].markdown_content).toBe('slow snippet fallback');
    expect(results[1].content_from_snippet).toBe(true);
  });

  it('does NOT promote a snippet when snippetFallback is disabled (legacy path: empty content, fetch_failed only)', async () => {
    vi.useFakeTimers();
    const router = mockRouter((_u, opts) =>
      new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason))),
    );
    const results = [item('https://example.com/slow', 'unused snippet')];
    const p = fetchContentForResults(results, router, ctx({ snippetFallback: undefined }));
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(results[0].fetch_failed).toBe('timeout');
    expect(results[0].markdown_content).toBeUndefined();
    expect(results[0].content_from_snippet).toBeUndefined();
  });

  it('does NOT promote a snippet on a non-timeout failure (only timeouts fall back)', async () => {
    const router = mockRouter(async () => { throw new Error('403 blocked'); });
    const results = [item('https://example.com/blocked', 'should not be used')];
    await fetchContentForResults(results, router, ctx());
    expect(results[0].fetch_failed).toBe('403 blocked');
    expect(results[0].markdown_content).toBeUndefined();
    expect(results[0].content_from_snippet).toBeUndefined();
  });

  it('does NOT promote an empty snippet (no fabrication — nothing to fall back to)', async () => {
    vi.useFakeTimers();
    const router = mockRouter((_u, opts) =>
      new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason))),
    );
    const results = [item('https://example.com/slow', '')];
    const p = fetchContentForResults(results, router, ctx());
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    expect(results[0].fetch_failed).toBe('timeout');
    expect(results[0].markdown_content).toBeUndefined();
    expect(results[0].content_from_snippet).toBeUndefined();
  });
});

// --- Narrow-set browser-render escalation
//
// WHY: JS-heavy documentation SPAs (react.dev-class) served over the HTTP tier
// return an empty JS shell — extraction "succeeds" with near-empty content, so
// the snippet fallback never fires and callers get a content-poor result. When
// include_domains narrows the enrichment set to a FEW URLs (bounded cost), the
// fetch should force the browser engine (renderJs:'always') so the SPA is
// actually rendered and real content recovered. Broad (many-URL) searches must
// stay on today's fast auto path (no browser cold-start on every result). Keys
// on candidateCount — a STRUCTURAL signal — never a domain allowlist. The
// snippet-fallback safety net is preserved when even the render fetch fails.

describe('fetchContentForResults — narrow-set browser-render escalation', () => {
  afterEach(() => vi.useRealTimers());

  function captureRouter() {
    const renderModes: Array<'auto' | 'always' | 'never' | undefined> = [];
    const router = {
      fetch: vi.fn(async (url: string, opts: { renderJs?: 'auto' | 'always' | 'never' }) => {
        renderModes.push(opts?.renderJs);
        return makeRaw(url);
      }),
    } as unknown as SmartRouter;
    return { router, renderModes };
  }

  const item = (url: string): SearchResultItem => ({ title: url, url, snippet: 's', relevance_score: 1 });

  const baseCtx = (over: Partial<Parameters<typeof fetchContentForResults>[2]> = {}): Parameters<typeof fetchContentForResults>[2] => ({
    contentMaxChars: 30000,
    maxTotalChars: 50000,
    fetchTimeoutMs: 5000,
    totalDeadline: Date.now() + 30000,
    forceRefresh: false,
    stageBudgetMs: 8000,
    ...over,
  });

  it('forces renderJs:always for a NARROW set (candidateCount <= maxCandidates) so the SPA is rendered', async () => {
    const { router, renderModes } = captureRouter();
    const results = [item('https://docs.example.com/a'), item('https://docs.example.com/b')];
    await fetchContentForResults(results, router, baseCtx({
      candidateCount: 2,
      renderNarrowSet: { maxCandidates: 3 },
    }));
    // Every hydration fetch used the browser-render path.
    expect(renderModes.length).toBe(2);
    expect(renderModes.every((m) => m === 'always')).toBe(true);
  });

  it('keeps renderJs:auto for a WIDE set (candidateCount > maxCandidates) — fast path unchanged', async () => {
    const { router, renderModes } = captureRouter();
    const results = Array.from({ length: 5 }, (_, i) => item(`https://docs.example.com/${i}`));
    await fetchContentForResults(results, router, baseCtx({
      candidateCount: 5,
      renderNarrowSet: { maxCandidates: 3 },
    }));
    expect(renderModes.length).toBe(5);
    expect(renderModes.every((m) => m === 'auto')).toBe(true);
  });

  it('keeps renderJs:auto when renderNarrowSet is absent regardless of candidate count (legacy path)', async () => {
    const { router, renderModes } = captureRouter();
    const results = [item('https://docs.example.com/a'), item('https://docs.example.com/b')];
    await fetchContentForResults(results, router, baseCtx({ candidateCount: 2 }));
    expect(renderModes.every((m) => m === 'auto')).toBe(true);
  });

  it('preserves the snippet-fallback safety net when the render fetch still times out', async () => {
    vi.useFakeTimers();
    const renderModes: Array<string | undefined> = [];
    const router = {
      fetch: vi.fn((url: string, opts: { renderJs?: string; signal?: AbortSignal }) => {
        renderModes.push(opts?.renderJs);
        return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(opts.signal!.reason)));
      }),
    } as unknown as SmartRouter;
    const results: SearchResultItem[] = [
      { title: 't', url: 'https://docs.example.com/slow', snippet: 'real snippet evidence', relevance_score: 1 },
    ];
    const p = fetchContentForResults(results, router, baseCtx({
      candidateCount: 1,
      renderNarrowSet: { maxCandidates: 3 },
      fetchTimeoutMs: 2000,
      snippetFallback: true,
    }));
    await vi.advanceTimersByTimeAsync(2000);
    await p;
    // Render path was chosen...
    expect(renderModes[0]).toBe('always');
    // ...and when it still fails on timeout, the snippet is preserved.
    expect(results[0].fetch_failed).toBe('timeout');
    expect(results[0].markdown_content).toBe('real snippet evidence');
    expect(results[0].content_from_snippet).toBe(true);
  });
});
