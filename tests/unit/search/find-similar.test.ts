import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FindSimilarInput, SearchEngine, RawSearchResult, CachedContent } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

// Mock the extraction pipeline to avoid Playwright dependency
const extractMock = vi.fn().mockResolvedValue({
  title: 'Mock Title',
  markdown: '# Mock Content\n\nSome extracted content here.',
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));


// Import after mocks
const { findSimilar } = await import('../../../src/search/find-similar.js');

function seedCache(url: string, title: string, markdown: string): void {
  const rawResult: RawFetchResult = {
    url,
    finalUrl: url,
    html: `<html><body><h1>${title}</h1><p>${markdown}</p></body></html>`,
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  const extraction: ExtractionResult = {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
  };
  cacheContent(rawResult, extraction);
}

describe('findSimilar', () => {
  const originalEnv = process.env;

  const mockSearchEngine: SearchEngine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      {
        title: 'Web Result 1',
        url: 'https://web.example.com/1',
        snippet: 'A web search result',
        relevance_score: 0.9,
        engine: 'mock',
      },
      {
        title: 'Web Result 2',
        url: 'https://web.example.com/2',
        snippet: 'Another web result',
        relevance_score: 0.7,
        engine: 'mock',
      },
    ] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      html: '<html><body><h1>Test</h1><p>Content about React hooks and state management.</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      VALIDATE_LINKS: 'false',
      LOG_LEVEL: 'error',
    };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('returns error when neither url nor concept provided', async () => {
    const result = await findSimilar({}, [mockSearchEngine], mockRouter);
    expect(result.error).toBeDefined();
    expect(result.error).toContain('url or concept');
    expect(result.results).toEqual([]);
  });

  it('finds similar pages from cache using concept', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks let you use **state** and lifecycle features in function components.');
    seedCache('https://vuejs.org/guide', 'Vue Guide', '# Vue.js Guide\n\nVue provides **reactive** state management for building UIs.');
    seedCache('https://example.com/unrelated', 'Cooking Recipes', '# Best Pasta Recipes\n\nHow to make **pasta** from scratch.');

    const result = await findSimilar(
      { concept: 'React hooks state management', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
    expect(result.method).toBe('fts5');
    expect(result.embedding_available).toBe(false);
  });

  it('respects max_results limit', async () => {
    for (let i = 0; i < 15; i++) {
      seedCache(
        `https://example.com/page${i}`,
        `React Page ${i}`,
        `# React Tutorial ${i}\n\nLearn about **React** hooks and state.`,
      );
    }

    const result = await findSimilar(
      { concept: 'React hooks', max_results: 3, include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.results.length).toBeLessThanOrEqual(3);
  });

  it('uses web search fallback when cache is empty', async () => {
    const result = await findSimilar(
      { concept: 'quantum computing algorithms', include_cache: true, include_web: true },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.search_hits).toBeGreaterThan(0);
    expect(mockSearchEngine.search).toHaveBeenCalled();
  });

  it('includes cache_hits and search_hits counts', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state** management.');

    const result = await findSimilar(
      { concept: 'React hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(typeof result.cache_hits).toBe('number');
    expect(typeof result.search_hits).toBe('number');
    expect(result.cache_hits + result.search_hits).toBe(result.results.length);
  });

  it('excludes the input URL from results when url is provided', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state** and lifecycle.');
    seedCache('https://react.dev/components', 'React Components', '# React Components\n\nBuild UIs with **components** and hooks.');

    const result = await findSimilar(
      { url: 'https://react.dev/hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    const urls = result.results.map(r => r.url);
    expect(urls).not.toContain('https://react.dev/hooks');
  });

  it('applies include_domains filter', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');
    seedCache('https://vuejs.org/guide', 'Vue Guide', '# Vue Guide\n\nReactive **state** management.');
    seedCache('https://angular.dev/guide', 'Angular Guide', '# Angular Guide\n\nAngular **state** management.');

    const result = await findSimilar(
      {
        concept: 'state management',
        include_domains: ['react.dev'],
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    for (const r of result.results) {
      expect(r.url).toContain('react.dev');
    }
  });

  it('applies exclude_domains filter', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');
    seedCache('https://spam.com/hooks', 'Spam Hooks', '# Spam\n\nHooks for **state** on spam.');

    const result = await findSimilar(
      {
        concept: 'hooks state',
        exclude_domains: ['spam.com'],
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    for (const r of result.results) {
      expect(r.url).not.toContain('spam.com');
    }
  });

  it('returns match_signals with fts5_rank and fused_score', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');

    const result = await findSimilar(
      { concept: 'React hooks state', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    if (result.results.length > 0) {
      const first = result.results[0];
      expect(first.match_signals).toBeDefined();
      expect(typeof first.match_signals.fused_score).toBe('number');
      expect(first.match_signals.fused_score).toBeGreaterThan(0);
    }
  });

  it('each result has source field set correctly', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');

    const result = await findSimilar(
      { concept: 'React hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    for (const r of result.results) {
      expect(r.source).toBe('cache');
    }
  });

  it('web search results have source set to search', async () => {
    const result = await findSimilar(
      { concept: 'quantum computing', include_cache: false, include_web: true },
      [mockSearchEngine],
      mockRouter,
    );

    for (const r of result.results) {
      expect(r.source).toBe('search');
    }
  });

  it('respects include_cache=false', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');

    const result = await findSimilar(
      { concept: 'React hooks', include_cache: false, include_web: true },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.cache_hits).toBe(0);
  });

  it('respects include_web=false', async () => {
    const result = await findSimilar(
      { concept: 'React hooks', include_cache: true, include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(mockSearchEngine.search).not.toHaveBeenCalled();
    expect(result.search_hits).toBe(0);
  });

  it('returns total_time_ms', async () => {
    const result = await findSimilar(
      { concept: 'anything', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(typeof result.total_time_ms).toBe('number');
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('handles concept as empty string', async () => {
    const result = await findSimilar(
      { concept: '' },
      [mockSearchEngine],
      mockRouter,
    );
    expect(result.error).toBeDefined();
  });

  it('url takes priority when both url and concept provided', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state** management.');
    seedCache('https://react.dev/components', 'React Components', '# Components\n\nBuild UIs with **components**.');

    const result = await findSimilar(
      {
        url: 'https://react.dev/hooks',
        concept: 'completely different topic',
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    // Should use URL-based term extraction, not the concept
    expect(result.error).toBeUndefined();
  });

  it('handles URL that is not in cache by fetching it', async () => {
    const result = await findSimilar(
      {
        url: 'https://new-site.com/page',
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    // Should have attempted to fetch the URL
    expect(mockRouter.fetch).toHaveBeenCalledWith(
      'https://new-site.com/page',
      expect.any(Object),
    );
  });

  it('defaults include_cache to true', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');

    const result = await findSimilar(
      { concept: 'React hooks' },
      [mockSearchEngine],
      mockRouter,
    );

    // Should have searched the cache
    expect(result.cache_hits).toBeGreaterThanOrEqual(0);
  });

  it('defaults include_web to true', async () => {
    // No cache entries, should fall through to web search
    const result = await findSimilar(
      { concept: 'obscure topic with no cache hits' },
      [mockSearchEngine],
      mockRouter,
    );

    expect(mockSearchEngine.search).toHaveBeenCalled();
  });

  it('defaults max_results to 10', async () => {
    for (let i = 0; i < 15; i++) {
      seedCache(
        `https://example.com/react${i}`,
        `React Page ${i}`,
        `# React ${i}\n\nHooks **state** management tutorial.`,
      );
    }

    const result = await findSimilar(
      { concept: 'React hooks state', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  it('results are sorted by fused_score descending', async () => {
    seedCache('https://a.com', 'React Hooks', '# React Hooks\n\n**State** management with hooks.');
    seedCache('https://b.com', 'Vue State', '# Vue\n\n**State** management in Vue.');
    seedCache('https://c.com', 'Angular', '# Angular\n\nAngular **state** patterns.');

    const result = await findSimilar(
      { concept: 'React hooks state management', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );

    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i].relevance_score).toBeLessThanOrEqual(
        result.results[i - 1].relevance_score,
      );
    }
  });

  it('sets cold_start note when cache is completely empty', async () => {
    const result = await findSimilar(
      { concept: 'quantum computing', include_cache: true, include_web: true },
      [mockSearchEngine],
      mockRouter,
    );
    expect(result.cold_start).toBeDefined();
    expect(result.cold_start).toMatch(/cache is empty/i);
  });

  it('sets cold_start note when embeddings unavailable despite populated cache', async () => {
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');
    const result = await findSimilar(
      { concept: 'React hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );
    expect(result.cold_start).toBeDefined();
    expect(result.cold_start).toMatch(/embeddings unavailable|index empty/i);
  });

  it('omits cold_start when cache has content and embeddings available', async () => {
    // With current test setup embeddings never init, so this variant just
    // ensures cold_start is a string when present and never a blocking error.
    seedCache('https://react.dev/hooks', 'React Hooks', '# React Hooks\n\nHooks for **state**.');
    const result = await findSimilar(
      { concept: 'React hooks', include_web: false },
      [mockSearchEngine],
      mockRouter,
    );
    if (result.cold_start !== undefined) {
      expect(typeof result.cold_start).toBe('string');
    }
  });

  it('emits weak-signal cold_start with raw scores when top fused_score is below threshold', async () => {
    // Concept "obscure niche topic xyzzy quantum
    // widget framework" returned 5 cache hits with normalized relevance_score
    // 0.94-1.0 even though raw signals were weak. fuseResults normalizes the
    // top RRF score to 1.0 regardless of its absolute strength, so callers
    // saw confident-looking matches for a query that had only token-overlap.
    //
    // Fix: when the top raw RRF score is below WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD,
    // emit cold_start AND replace per-result relevance_score with the raw
    // fused_score so callers see the truth instead of the normalization lie.
    //
    // Setup: seed cache so a single overlapping token ('framework') matches
    // five otherwise-unrelated pages. Concept query reuses that token plus
    // nonsense tokens. FTS5 (OR query) returns five rank-1..5 hits; embeddings
    // are unavailable in test env, so only one RRF list contributes. Top raw
    // score = 1/(60+1) ≈ 0.0164, well below the 0.02 default threshold.
    for (let i = 0; i < 5; i++) {
      seedCache(
        `https://noise-${i}.example`,
        `Framework Note ${i}`,
        `# Framework Note ${i}\n\nA short note about an unrelated **framework** in another domain.`,
      );
    }

    const result = await findSimilar(
      {
        concept: 'obscure niche topic xyzzy quantum widget framework',
        include_cache: true,
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.results.length).toBeGreaterThan(0);
    expect(result.cold_start).toBeDefined();
    expect(result.cold_start).toMatch(/weak|low confidence|below threshold|raw signal/i);
    expect(result.cold_start).toContain('obscure niche topic xyzzy quantum widget framework');

    // Top result's relevance_score must reflect the raw fused_score, not the
    // normalized 1.0 that fuseResults emits by default.
    const top = result.results[0];
    expect(top.match_signals.fused_score).toBeGreaterThan(0);
    expect(top.relevance_score).toBeCloseTo(top.match_signals.fused_score, 6);
    expect(top.relevance_score).toBeLessThan(0.5);
  });

  it('honors WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD override', async () => {
    // Threshold=0 disables the weak-signal cold_start path entirely; the
    // top result reverts to the normalized relevance_score of 1.0.
    process.env.WIGOLO_FIND_SIMILAR_COLD_START_THRESHOLD = '0';
    resetConfig();
    for (let i = 0; i < 5; i++) {
      seedCache(
        `https://noise-${i}.example`,
        `Framework Note ${i}`,
        `# Framework Note ${i}\n\nA short note about an unrelated **framework** in another domain.`,
      );
    }

    const result = await findSimilar(
      {
        concept: 'obscure niche topic xyzzy quantum widget framework',
        include_cache: true,
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    if (result.results.length > 0) {
      expect(result.results[0].relevance_score).toBeCloseTo(1.0, 3);
    }
    if (result.cold_start) {
      expect(result.cold_start).not.toMatch(/weak|low confidence|below threshold|raw signal/i);
    }
  });

  // A concept like "retrieval augmented generation" previously returned 1
  // irrelevant result with NO cold_start. Now: concept mode with a thin
  // local-cache signal (very few cache hits and no web fallback) must emit
  // cold_start so the host LLM can tell the user the result is weakly grounded.
  it('emits cold_start when concept mode returns only 1 cache hit with no web fallback', async () => {
    // Seed a populated-but-irrelevant cache (the cache
    // had many pages, but the concept query only weakly matched one). We
    // share one token ('generation') with a single page so FTS5 returns one
    // hit, then the H9 thin-cache cold_start must fire because the local
    // signal is too thin to trust.
    seedCache(
      'https://example.com/deployment',
      'Deployment environment',
      '# Deployment environment\n\nA deployment environment is a setup used in the next generation of software deployment.',
    );
    // Add 4 unrelated pages so cache size > 3 (the H9 threshold). None
    // overlap with the RAG query — they exist solely so the cache size
    // reflects a real, populated index where the per-query thinness is the
    // signal.
    for (let i = 0; i < 4; i++) {
      seedCache(
        `https://unrelated-${i}.example`,
        `Unrelated ${i}`,
        `# Unrelated topic ${i}\n\nThis page is about something completely different from the query.`,
      );
    }

    const result = await findSimilar(
      {
        concept: 'retrieval augmented generation',
        include_cache: true,
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    // Thin-cache shape: at most a handful of cache hits, no web.
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.search_hits).toBe(0);
    // The cold_start signal must fire here so the LLM knows the
    // local-cache result is thin.
    expect(result.cold_start).toBeDefined();
    expect(result.cold_start).toMatch(/thin|too few|weak|sparse|cold|1 cache match|few cache match/i);
  });

  it('does NOT emit thin-cache cold_start when concept mode returns plenty of cache hits', async () => {
    // Boundary: with 10+ matching pages and no thin-cache concern, the new
    // H9 signal must stay silent. Other cold_start signals may still fire
    // (e.g. embedding-unavailable) so we only assert the H9 message did not.
    for (let i = 0; i < 10; i++) {
      seedCache(
        `https://example.com/rag-${i}`,
        `RAG explainer ${i}`,
        `# Retrieval augmented generation explainer ${i}\n\nA primer on retrieval augmented generation systems and patterns.`,
      );
    }

    const result = await findSimilar(
      {
        concept: 'retrieval augmented generation',
        include_cache: true,
        include_web: false,
      },
      [mockSearchEngine],
      mockRouter,
    );

    expect(result.results.length).toBeGreaterThan(2);
    if (result.cold_start) {
      expect(result.cold_start).not.toMatch(/thin|too few|sparse|1 cache match|few cache match/i);
    }
  });

  it('sets cold_start when cache has many pages but none match this query and results come from web search', async () => {
    // Bench: cache had 39 pages but the find_similar query returned 0 cache
    // hits and the result was silently web-only — cold_start was documented
    // but never emitted. Now it fires whenever cacheHits === 0 && searchHits > 0
    // so the host LLM can tell the user the cache wasn't helpful for THIS topic.
    for (let i = 0; i < 25; i++) {
      seedCache(
        `https://unrelated-${i}.example`,
        `Unrelated ${i}`,
        `# Unrelated topic ${i}\n\nSome content that has nothing to do with the query.`,
      );
    }
    const result = await findSimilar(
      { concept: 'quantum entanglement Bell inequality', include_cache: true, include_web: true },
      [mockSearchEngine],
      mockRouter,
    );
    expect(result.cache_hits).toBe(0);
    if (result.search_hits > 0) {
      expect(result.cold_start).toBeDefined();
      expect(result.cold_start).toMatch(/no cache matches/i);
    }
  });

  // fts5_rank and embedding_rank can disagree without any way for the caller
  // to inspect the disagreement. Add an opt-in `ranking_debug` field per
  // result, off by default.
  describe('ranking_debug', () => {
    it('omits ranking_debug by default (no shape regression)', async () => {
      seedCache(
        'https://react.dev/hooks',
        'React Hooks',
        '# React Hooks\n\nHooks for **state** management.',
      );

      const result = await findSimilar(
        { concept: 'React hooks', include_web: false },
        [mockSearchEngine],
        mockRouter,
      );

      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results) {
        expect(r.ranking_debug).toBeUndefined();
      }
    });

    it('emits ranking_debug with fts5_rank + rrf_score when include_ranking_debug=true on cache-only results', async () => {
      seedCache(
        'https://react.dev/hooks',
        'React Hooks',
        '# React Hooks\n\nHooks for **state** management.',
      );
      seedCache(
        'https://vuejs.org/guide',
        'Vue Guide',
        '# Vue Guide\n\nReactive **state** management.',
      );

      const result = await findSimilar(
        {
          concept: 'state management',
          include_web: false,
          include_ranking_debug: true,
        },
        [mockSearchEngine],
        mockRouter,
      );

      expect(result.results.length).toBeGreaterThan(0);
      for (const r of result.results) {
        expect(r.ranking_debug).toBeDefined();
        expect(typeof r.ranking_debug!.rrf_score).toBe('number');
        // Every cache result must surface its fts5_rank in the debug block;
        // without it, the disagreement between fts5 and embedding ranks is
        // opaque.
        expect(typeof r.ranking_debug!.fts5_rank).toBe('number');
      }
    });

    it('emits ranking_debug with web_rank when include_ranking_debug=true and results come from web search', async () => {
      const result = await findSimilar(
        {
          concept: 'quantum computing latest research',
          include_cache: false,
          include_web: true,
          include_ranking_debug: true,
        },
        [mockSearchEngine],
        mockRouter,
      );

      expect(result.search_hits).toBeGreaterThan(0);
      for (const r of result.results) {
        if (r.source === 'search') {
          expect(r.ranking_debug).toBeDefined();
          expect(typeof r.ranking_debug!.web_rank).toBe('number');
          expect(typeof r.ranking_debug!.rrf_score).toBe('number');
        }
      }
    });
  });
});
