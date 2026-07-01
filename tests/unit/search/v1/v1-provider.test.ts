import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/search/core/orchestrator.js', () => ({
  runV1Search: vi.fn(async () => ({
    results: [],
    enginesUsed: [],
    degraded: false,
  })),
}));

vi.mock('../../../../src/search/answer-synthesis.js', () => ({
  runSynthesis: vi.fn(async () => ({
    ok: true as const,
    data: {
      answer: 'mocked answer',
      citations: [{ index: 1, url: 'https://x.example', title: 'x', snippet: '' }],
      fallback_level: 1 as const,
    },
  })),
}));

vi.mock('../../../../src/search/content-fetch.js', () => ({
  fetchContentForResults: vi.fn(async () => undefined),
}));

vi.mock('../../../../src/cache/store.js', () => ({
  getCachedSearchResults: vi.fn(() => null),
  cacheSearchResults: vi.fn(),
  buildSearchCacheKey: (query: string) => query,
}));

vi.mock('../../../../src/search/evidence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/search/evidence.js')>();
  return {
    ...actual,
    applyEvidenceDefault: vi.fn(async () => undefined),
  };
});

import { CoreSearchProvider } from '../../../../src/search/core/core-provider.js';
import { runV1Search } from '../../../../src/search/core/orchestrator.js';
import { runSynthesis } from '../../../../src/search/answer-synthesis.js';
import { fetchContentForResults } from '../../../../src/search/content-fetch.js';
import { applyEvidenceDefault } from '../../../../src/search/evidence.js';
import { getCachedSearchResults, cacheSearchResults } from '../../../../src/cache/store.js';

const runV1SearchMock = vi.mocked(runV1Search);
const runSynthesisMock = vi.mocked(runSynthesis);
const fetchContentMock = vi.mocked(fetchContentForResults);
const applyEvidenceDefaultMock = vi.mocked(applyEvidenceDefault);
const getCachedSearchResultsMock = vi.mocked(getCachedSearchResults);
const cacheSearchResultsMock = vi.mocked(cacheSearchResults);

const ctx = { router: undefined } as never;

describe('CoreSearchProvider', () => {
  // Pre-existing behavior was that the provider rejected
  // category=images with `unsupported_category`. The images vertical is now
  // a first-class core vertical (DDG Image + Brave Image). The legacy
  // assertion is gone; this replaces it by pinning that the provider DOES
  // dispatch the orchestrator (no early-return) and the response shape is
  // `ok: true`. Detailed image-shaped contracts live in
  // tests/unit/tools/search.images.test.ts (integration boundary) and the
  // adapter tests under tests/unit/search/engines/.
  it('dispatches category=images to the orchestrator (no longer unsupported_category)', async () => {
    runV1SearchMock.mockClear();
    runV1SearchMock.mockResolvedValueOnce({
      results: [
        { title: 'A cat', url: 'https://example.com/cats', snippet: 'src', relevance_score: 1, engine: 'ddg-image', image_url: 'https://cdn/cat.jpg' },
      ],
      enginesUsed: ['ddg-image'],
      degraded: false,
    });

    const provider = new CoreSearchProvider();
    const result = await provider.search(
      { query: 'cats', category: 'images', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(runV1SearchMock).toHaveBeenCalledOnce();
    expect(runV1SearchMock.mock.calls[0][0].category).toBe('images');
  });

  it('passes other categories straight through to the orchestrator', async () => {
    runV1SearchMock.mockClear();
    runV1SearchMock.mockResolvedValueOnce({ results: [], enginesUsed: ['stub'], degraded: false });

    const provider = new CoreSearchProvider();
    const result = await provider.search(
      { query: 'react server components', category: 'docs', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(runV1SearchMock).toHaveBeenCalledOnce();
    expect(runV1SearchMock.mock.calls[0][0].category).toBe('docs');
  });

  it('rejects an empty query before the images check', async () => {
    const provider = new CoreSearchProvider();
    const result = await provider.search(
      { query: '   ', category: 'images', max_results: 5 },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // Empty input takes precedence — we never reach the category check.
      expect(result.error).toBe('invalid_input');
    }
  });

  describe('array query dispatch', () => {
    it('dispatches each array element as a separate runV1Search call', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [],
        enginesUsed: ['bing'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: ['hnsw tuning', 'ef_construction m', 'pgvector index'], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(runV1SearchMock).toHaveBeenCalledTimes(3);
      const dispatched = runV1SearchMock.mock.calls.map((c) => c[0].query).sort();
      expect(dispatched).toEqual(['ef_construction m', 'hnsw tuning', 'pgvector index']);
    });

    it('RRF-fuses results so URLs appearing in multiple lists rank above singletons', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [
          { title: 'Shared', url: 'https://shared.example/a', snippet: 's', relevance_score: 0.9, engine: 'bing' },
          { title: 'Only-A', url: 'https://only-a.example', snippet: '', relevance_score: 0.8, engine: 'bing' },
        ],
        enginesUsed: ['bing'],
        degraded: false,
      }));
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [
          { title: 'Only-B', url: 'https://only-b.example', snippet: '', relevance_score: 0.95, engine: 'duckduckgo' },
          { title: 'Shared', url: 'https://shared.example/a', snippet: 's', relevance_score: 0.7, engine: 'duckduckgo' },
        ],
        enginesUsed: ['duckduckgo'],
        degraded: false,
      }));

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: ['query one', 'query two'], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        const urls = result.data.results.map((r) => r.url);
        // Shared appears in both lists → wins RRF over singletons.
        expect(urls[0]).toBe('https://shared.example/a');
        expect(urls).toContain('https://only-a.example');
        expect(urls).toContain('https://only-b.example');
        // Union of engines from both dispatches.
        expect(new Set(result.data.engines_used)).toEqual(new Set(['bing', 'duckduckgo']));
      }
    });

    it('dedupes and trims array entries before dispatch', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [],
        enginesUsed: [],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: ['  same  ', 'same', 'other', ''], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      expect(runV1SearchMock).toHaveBeenCalledTimes(2);
      const dispatched = runV1SearchMock.mock.calls.map((c) => c[0].query).sort();
      expect(dispatched).toEqual(['other', 'same']);
    });

    it('rejects an array of only empty strings as invalid_input', async () => {
      runV1SearchMock.mockClear();
      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: ['  ', ''], max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error).toBe('invalid_input');
      }
      expect(runV1SearchMock).not.toHaveBeenCalled();
    });

    it('does not invoke runSynthesis when format is unset', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search({ query: 'cats', max_results: 5 }, ctx);

      expect(result.ok).toBe(true);
      expect(runSynthesisMock).not.toHaveBeenCalled();
    });

    it('reports degraded only when all dispatches are degraded', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [],
        enginesUsed: [],
        degraded: true,
      }));
      runV1SearchMock.mockImplementationOnce(async () => ({
        results: [
          { title: 'OK', url: 'https://ok.example', snippet: '', relevance_score: 0.5, engine: 'bing' },
        ],
        enginesUsed: ['bing'],
        degraded: false,
      }));

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: ['q1', 'q2'], max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.warning).toBeUndefined();
      }
    });
  });

  describe('engine_outcomes telemetry', () => {
    it('does not emit engine_outcomes by default', async () => {
      runV1SearchMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue(null);
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: '', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search({ query: 'q', max_results: 5 }, ctx);
      if (result.ok) expect(result.data.engine_outcomes).toBeUndefined();
    });

    it('emits engine_outcomes with per-engine timing/count when include_engine_outcomes is true', async () => {
      runV1SearchMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue(null);
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: '', relevance_score: 1, engine: 'bing' }],
        enginesUsed: ['bing'],
        degraded: false,
        outcomes: [
          { engine: 'bing', ok: true, latencyMs: 120, results: [{ title: 't', url: 'https://x', snippet: '', relevance_score: 1, engine: 'bing' }] },
          { engine: 'duckduckgo', ok: false, latencyMs: 80, results: [], error: 'timeout' },
        ],
      } as never);

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', include_engine_outcomes: true, max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.engine_outcomes).toBeDefined();
        expect(result.data.engine_outcomes).toHaveLength(2);
        expect(result.data.engine_outcomes![0]).toMatchObject({
          engine: 'bing',
          ok: true,
          latency_ms: 120,
          result_count: 1,
        });
        expect(result.data.engine_outcomes![1]).toMatchObject({
          engine: 'duckduckgo',
          ok: false,
          latency_ms: 80,
          result_count: 0,
          error: 'timeout',
        });
      }
    });

    it('omits engine_outcomes when served from cache', async () => {
      runV1SearchMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue({
        query: 'q',
        results: [{ title: 'cached', url: 'https://c', snippet: '', relevance_score: 1 }],
        engines_used: ['bing'],
        searched_at: '2026-05-24T00:00:00Z',
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', include_engine_outcomes: true, max_results: 5 },
        ctx,
      );
      if (result.ok) expect(result.data.engine_outcomes).toBeUndefined();
    });
  });

  describe('cache layer', () => {
    it('stores items after dispatch when cache miss', async () => {
      runV1SearchMock.mockClear();
      cacheSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue(null);
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      await provider.search({ query: 'rust async runtime', max_results: 5 }, ctx);

      expect(runV1SearchMock).toHaveBeenCalledOnce();
      expect(cacheSearchResultsMock).toHaveBeenCalledOnce();
      const [cachedKey, cachedItems, cachedEngines] = cacheSearchResultsMock.mock.calls[0];
      expect(cachedKey).toBe('rust async runtime');
      expect(cachedItems.map((i: { url: string }) => i.url)).toEqual(['https://a.example']);
      expect(cachedEngines).toEqual(['b']);
    });

    it('serves from cache and skips dispatch + fetch when fresh entry exists', async () => {
      runV1SearchMock.mockClear();
      fetchContentMock.mockClear();
      getCachedSearchResultsMock.mockClear();
      cacheSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue({
        query: 'rust async runtime',
        results: [
          { title: 'Cached', url: 'https://cached.example', snippet: 'sc', relevance_score: 1 },
        ],
        engines_used: ['bing', 'duckduckgo'],
        searched_at: '2026-05-23T10:00:00Z',
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search({ query: 'rust async runtime', max_results: 5 }, ctx);

      expect(runV1SearchMock).not.toHaveBeenCalled();
      expect(fetchContentMock).not.toHaveBeenCalled();
      expect(cacheSearchResultsMock).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.results).toHaveLength(1);
        expect(result.data.results[0].url).toBe('https://cached.example');
        expect(result.data.results[0].cached).toBe(true);
        expect(result.data.results[0].cached_at).toBe('2026-05-23T10:00:00Z');
        expect(result.data.engines_used).toEqual(['bing', 'duckduckgo']);
      }
    });

    it('bypasses cache when force_refresh is true', async () => {
      runV1SearchMock.mockClear();
      getCachedSearchResultsMock.mockClear();
      cacheSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue({
        query: 'q',
        results: [{ title: 'stale', url: 'https://stale.example', snippet: '', relevance_score: 1 }],
        engines_used: ['x'],
        searched_at: '2026-05-23T10:00:00Z',
      });
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 'fresh', url: 'https://fresh.example', snippet: '', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', force_refresh: true, max_results: 5 },
        ctx,
      );

      expect(getCachedSearchResultsMock).not.toHaveBeenCalled();
      expect(runV1SearchMock).toHaveBeenCalledOnce();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.results[0].url).toBe('https://fresh.example');
      }
    });

    it('treats stale cache entries as a miss', async () => {
      runV1SearchMock.mockClear();
      getCachedSearchResultsMock.mockClear();
      cacheSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue({
        query: 'q',
        results: [{ title: 'old', url: 'https://old.example', snippet: '', relevance_score: 1 }],
        engines_used: ['x'],
        searched_at: '2026-05-23T10:00:00Z',
        stale: true,
      });
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 'fresh', url: 'https://fresh.example', snippet: '', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search({ query: 'q', max_results: 5 }, ctx);

      expect(runV1SearchMock).toHaveBeenCalledOnce();
      if (result.ok) {
        expect(result.data.results[0].url).toBe('https://fresh.example');
      }
    });

    it('uses joined array query as the cache key', async () => {
      runV1SearchMock.mockClear();
      cacheSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue(null);
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: '', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      await provider.search({ query: ['hnsw tuning', 'ef_construction'], max_results: 5 }, ctx);

      const lookupKey = getCachedSearchResultsMock.mock.calls[0][0];
      expect(lookupKey).toBe('hnsw tuning | ef_construction');
      const storedKey = cacheSearchResultsMock.mock.calls[0][0];
      expect(storedKey).toBe('hnsw tuning | ef_construction');
    });

    it('does not store cache when fused result list is empty', async () => {
      runV1SearchMock.mockClear();
      cacheSearchResultsMock.mockClear();
      getCachedSearchResultsMock.mockReturnValue(null);
      runV1SearchMock.mockResolvedValue({
        results: [],
        enginesUsed: [],
        degraded: true,
      });

      const provider = new CoreSearchProvider();
      await provider.search({ query: 'q', max_results: 5 }, ctx);

      expect(cacheSearchResultsMock).not.toHaveBeenCalled();
    });
  });

  describe('content fetch + evidence wiring', () => {
    it('skips content fetch when ctx.router is missing', async () => {
      runV1SearchMock.mockClear();
      fetchContentMock.mockClear();
      applyEvidenceDefaultMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      await provider.search({ query: 'q', max_results: 5 }, ctx);

      expect(fetchContentMock).not.toHaveBeenCalled();
      // applyEvidenceDefault should also be skipped — no content means useless evidence.
      expect(applyEvidenceDefaultMock).not.toHaveBeenCalled();
    });

    it('fetches content for items when ctx.router is present and include_content is default', async () => {
      runV1SearchMock.mockClear();
      fetchContentMock.mockClear();
      applyEvidenceDefaultMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
          { title: 'B', url: 'https://b.example', snippet: 'sb', relevance_score: 0.5, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const router = { fetch: vi.fn() } as never;
      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', max_results: 5 },
        { router, samplingServer: undefined } as never,
      );

      expect(fetchContentMock).toHaveBeenCalledOnce();
      const [items, passedRouter] = fetchContentMock.mock.calls[0];
      expect(passedRouter).toBe(router);
      expect(items.map((i: { url: string }) => i.url)).toEqual(['https://a.example', 'https://b.example']);
      expect(result.ok).toBe(true);
      if (result.ok) expect(typeof result.data.fetch_time_ms).toBe('number');
    });

    it('skips content fetch when input.include_content is explicitly false', async () => {
      runV1SearchMock.mockClear();
      fetchContentMock.mockClear();
      applyEvidenceDefaultMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const router = { fetch: vi.fn() } as never;
      const provider = new CoreSearchProvider();
      await provider.search(
        { query: 'q', include_content: false, max_results: 5 },
        { router } as never,
      );

      expect(fetchContentMock).not.toHaveBeenCalled();
      expect(applyEvidenceDefaultMock).not.toHaveBeenCalled();
    });

    it('calls applyEvidenceDefault when content was fetched and format is unset', async () => {
      runV1SearchMock.mockClear();
      fetchContentMock.mockClear();
      applyEvidenceDefaultMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const router = { fetch: vi.fn() } as never;
      const provider = new CoreSearchProvider();
      await provider.search({ query: 'q', max_results: 5 }, { router } as never);

      expect(applyEvidenceDefaultMock).toHaveBeenCalledOnce();
      const [, , passedItems, passedQuery] = applyEvidenceDefaultMock.mock.calls[0];
      expect(passedItems.map((i: { url: string }) => i.url)).toEqual(['https://a.example']);
      expect(passedQuery).toBe('q');
    });

    it('does not call applyEvidenceDefault when format=answer (synth path owns citations)', async () => {
      runV1SearchMock.mockClear();
      fetchContentMock.mockClear();
      applyEvidenceDefaultMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });

      const router = { fetch: vi.fn() } as never;
      const provider = new CoreSearchProvider();
      await provider.search(
        { query: 'q', format: 'answer', max_results: 5 },
        { router } as never,
      );

      expect(fetchContentMock).toHaveBeenCalledOnce();
      expect(applyEvidenceDefaultMock).not.toHaveBeenCalled();
    });

    it('does not fail when content fetch and evidence both run on a degraded search', async () => {
      runV1SearchMock.mockClear();
      fetchContentMock.mockClear();
      applyEvidenceDefaultMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [],
        enginesUsed: [],
        degraded: true,
      });

      const router = { fetch: vi.fn() } as never;
      const provider = new CoreSearchProvider();
      const result = await provider.search({ query: 'q', max_results: 5 }, { router } as never);

      expect(result.ok).toBe(true);
      // No items → both skipped.
      expect(fetchContentMock).not.toHaveBeenCalled();
      expect(applyEvidenceDefaultMock).not.toHaveBeenCalled();
    });
  });

  describe('citation_format wiring', () => {
    it('does not emit citations when citation_format is unset', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'first', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search({ query: 'q', max_results: 5 }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toBeUndefined();
        expect(result.data.citations_xml).toBeUndefined();
      }
    });

    it('emits citations array for citation_format="numbered"', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
          { title: 'B', url: 'https://b.example', snippet: 'sb', relevance_score: 0.5, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', citation_format: 'numbered', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toEqual([
          { index: 1, url: 'https://a.example', title: 'A', snippet: 'sa' },
          { index: 2, url: 'https://b.example', title: 'B', snippet: 'sb' },
        ]);
        expect(result.data.citations_xml).toBeUndefined();
      }
    });

    it('emits citations + citations_xml for citation_format="anthropic_tags"', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', citation_format: 'anthropic_tags', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toHaveLength(1);
        expect(result.data.citations_xml).toContain('<source');
        expect(result.data.citations_xml).toContain('https://a.example');
      }
    });

    it('emits citations array unchanged for citation_format="json"', async () => {
      runV1SearchMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', citation_format: 'json', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Array.isArray(result.data.citations)).toBe(true);
        expect(result.data.citations_xml).toBeUndefined();
      }
    });

    it('renders citations_xml from synth citations when format=answer + citation_format=anthropic_tags', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'sa', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: {
          answer: 'A says X [1].',
          citations: [{ index: 1, url: 'https://a.example', title: 'A', snippet: 'sa' }],
          fallback_level: 1,
        },
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'answer', citation_format: 'anthropic_tags', max_results: 5 },
        ctx,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.citations).toHaveLength(1);
        expect(result.data.citations_xml).toContain('<source');
      }
    });
  });

  describe('format=answer wiring', () => {
    it('calls runSynthesis when format is "answer" and populates answer + citations', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 'A', url: 'https://a.example', snippet: 'first', relevance_score: 1, engine: 'b' },
          { title: 'B', url: 'https://b.example', snippet: 'second', relevance_score: 0.5, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: {
          answer: 'A answer with [1] and [2].',
          citations: [
            { index: 1, url: 'https://a.example', title: 'A', snippet: 'first' },
            { index: 2, url: 'https://b.example', title: 'B', snippet: 'second' },
          ],
          fallback_level: 1,
        },
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'why sky blue', format: 'answer', max_results: 5 },
        ctx,
      );

      expect(runSynthesisMock).toHaveBeenCalledOnce();
      const synthCall = runSynthesisMock.mock.calls[0][0];
      expect(synthCall.query).toBe('why sky blue');
      expect(synthCall.results).toHaveLength(2);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.answer).toBe('A answer with [1] and [2].');
        expect(result.data.citations).toHaveLength(2);
        expect(result.data.streaming).toBeUndefined();
      }
    });

    it('sets streaming=true for format="stream_answer"', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [
          { title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' },
        ],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: { answer: 'streamed', citations: [], fallback_level: 1 },
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'stream_answer', max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.streaming).toBe(true);
        expect(result.data.answer).toBe('streamed');
      }
    });

    it('passes through samplingServer from SearchContext to runSynthesis', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: { answer: 'ok', citations: [], fallback_level: 1 },
      });

      const samplingServer = { capabilities: {} } as never;
      const provider = new CoreSearchProvider();
      await provider.search(
        { query: 'q', format: 'answer', max_results: 5 },
        { router: undefined, samplingServer } as never,
      );

      expect(runSynthesisMock.mock.calls[0][0].samplingServer).toBe(samplingServer);
    });

    it('surfaces synthesis warning into SearchOutput when synthesis fell back', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: true,
        data: { answer: 'fallback', citations: [], warning: 'fallback used', fallback_level: 2 },
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'answer', max_results: 5 },
        ctx,
      );

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.warning).toBe('fallback used');
      }
    });

    it('keeps search ok when synthesis returns error — surfaces warning only', async () => {
      runV1SearchMock.mockClear();
      runSynthesisMock.mockClear();
      runV1SearchMock.mockResolvedValue({
        results: [{ title: 't', url: 'https://x', snippet: 's', relevance_score: 1, engine: 'b' }],
        enginesUsed: ['b'],
        degraded: false,
      });
      runSynthesisMock.mockResolvedValue({
        ok: false,
        error: 'no_content',
        error_reason: 'no content',
        stage: 'synthesize',
      });

      const provider = new CoreSearchProvider();
      const result = await provider.search(
        { query: 'q', format: 'answer', max_results: 5 },
        ctx,
      );

      // Search itself succeeds even if synth failed.
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data.answer).toBeUndefined();
        expect(result.data.warning).toMatch(/synthesis/i);
      }
    });
  });
});
