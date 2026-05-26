import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// --- Slice S1 (M16): backup-fetch behavior ---
//
// WHY: when the top-N parallel fetches lose one to a transient timeout,
// the audit complained that callers got fewer pages than they asked for.
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
});
