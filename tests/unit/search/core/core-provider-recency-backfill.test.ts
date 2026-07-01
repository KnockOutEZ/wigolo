import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';
import type { Config } from '../../../../src/config.js';

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));
vi.mock('../../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));

const foldRerankIntoOrdering = vi.fn(async (results: RawSearchResult[]) => results);
vi.mock('../../../../src/search/core/rerank-fold.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/search/core/rerank-fold.js')>();
  return { ...actual, foldRerankIntoOrdering };
});

function cfg(over: Partial<Config> = {}): Config {
  return { reranker: 'none', relevanceThreshold: 0, logLevel: 'error', ...over } as Config;
}

const getConfig = vi.fn(() => cfg());
vi.mock('../../../../src/config.js', () => ({ getConfig }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

const NOW_MS = Date.UTC(2026, 5, 14);
function isoDaysAgo(days: number): string {
  return new Date(NOW_MS - days * 86_400_000).toISOString();
}

function res(url: string, score: number, publishedDate?: string): RawSearchResult {
  return {
    title: url,
    url,
    snippet: 's',
    relevance_score: score,
    engine: 'e1',
    ...(publishedDate ? { published_date: publishedDate } : {}),
  };
}

function dispatchOf(results: RawSearchResult[]) {
  return { results, enginesUsed: ['e1'], outcomes: [], degraded: false };
}

describe('core-provider stale-result demotion', () => {
  beforeEach(() => {
    runV1Search.mockReset();
    foldRerankIntoOrdering.mockReset();
    foldRerankIntoOrdering.mockImplementation(async (results: RawSearchResult[]) => results);
    getConfig.mockReset();
    getConfig.mockReturnValue(cfg());
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_MS));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('demotes a stale result below a fresh one on a temporal-intent query', async () => {
    // Two results: a STALE one ranked slightly higher by the engine, and a
    // FRESH one just behind. On a temporal-intent query ("latest ...") the
    // stale result must lose its lead to the fresh one.
    runV1Search.mockResolvedValue(
      dispatchOf([
        res('https://stale.example.com/old', 0.90, isoDaysAgo(800)),
        res('https://fresh.example.com/new', 0.80, isoDaysAgo(2)),
      ]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'latest framework release', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const urls = out.data.results.map((r) => r.url);
    // Fresh result wins the top slot once stale demotion is applied.
    expect(urls[0]).toBe('https://fresh.example.com/new');
  });

  it('leaves an evergreen (no temporal intent) query unaffected by date', async () => {
    // Same scores + dates, but the query carries NO temporal intent. The
    // engine-supplied order (stale higher) must be preserved — recency
    // demotion must NOT fire for evergreen queries.
    runV1Search.mockResolvedValue(
      dispatchOf([
        res('https://stale.example.com/old', 0.90, isoDaysAgo(800)),
        res('https://fresh.example.com/new', 0.80, isoDaysAgo(2)),
      ]),
    );
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'how to use python decorators', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const urls = out.data.results.map((r) => r.url);
    expect(urls[0]).toBe('https://stale.example.com/old');
  });
});

describe('core-provider floored-recall backfill', () => {
  beforeEach(() => {
    runV1Search.mockReset();
    foldRerankIntoOrdering.mockReset();
    foldRerankIntoOrdering.mockImplementation(async (results: RawSearchResult[]) => results);
    getConfig.mockReset();
    getConfig.mockReturnValue(cfg());
  });

  it('refills to max_results from survivors when the floor drops junk', async () => {
    // The orchestrator ALREADY slices to the maxResults it is handed (see
    // orchestrator.ts:437), so the floor downstream has nothing to backfill
    // from unless core-provider over-fetches a buffer. This mock mirrors that:
    // it returns at most `maxResults` results, sorted desc by score, exactly
    // like the real orchestrator.
    //
    // Candidate pool (desc): good1, junk1, good2, junk2, good3, good4, good5.
    // junk1/junk2 sit in the top-5 window. With max_results=5 and NO buffer
    // over-fetch, the orchestrator returns only the top-5
    // [good1, junk1, good2, junk2, good3]; the floor drops the 2 junk →
    // 3 results (the bug). With a buffer over-fetch the orchestrator returns
    // the deeper pool, the floor drops junk, and backfill refills to 5.
    const POOL = [
      res('https://good1.com', 1.0),
      res('https://junk1.com', 0.001),
      res('https://good2.com', 0.9),
      res('https://junk2.com', 0.002),
      res('https://good3.com', 0.8),
      res('https://good4.com', 0.7),
      res('https://good5.com', 0.6),
    ];
    runV1Search.mockImplementation(async (arg: { maxResults?: number }) => {
      const n = arg.maxResults ?? POOL.length;
      return dispatchOf(POOL.slice(0, n));
    });
    const provider = new CoreSearchProvider();
    const out = await provider.search(
      { query: 'some query', search_depth: 'fast', include_content: false, max_results: 5 },
      { router: undefined } as never,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const urls = out.data.results.map((r) => r.url);
    expect(urls).not.toContain('https://junk1.com');
    expect(urls).not.toContain('https://junk2.com');
    // Backfill refilled the two freed slots with the next survivors.
    expect(out.data.results).toHaveLength(5);
    expect(urls).toEqual([
      'https://good1.com',
      'https://good2.com',
      'https://good3.com',
      'https://good4.com',
      'https://good5.com',
    ]);
  });
});
