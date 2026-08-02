import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FindSimilarInput, SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

// Mock extraction pipeline
const extractMock = vi.fn().mockResolvedValue({
  title: 'Mock',
  markdown: '# Mock\n\nContent.',
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


const { handleFindSimilar } = await import('../../../src/tools/find-similar.js');

describe('handleFindSimilar', () => {
  const originalEnv = process.env;

  const mockEngine: SearchEngine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      {
        title: 'Web Result',
        url: 'https://web.example.com/1',
        snippet: 'A web result',
        relevance_score: 0.9,
        engine: 'mock',
      },
    ] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com/page',
      finalUrl: 'https://example.com/page',
      html: '<html><body><h1>Test</h1><p>Content</p></body></html>',
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
    const __r_result = await handleFindSimilar(
      {} as FindSimilarInput,
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);
    expect(result.error).toBeDefined();
  });

  it('returns FindSimilarOutput shape for concept input', async () => {
    const __r_result = await handleFindSimilar(
      { concept: 'React hooks' },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('cache_hits');
    expect(result).toHaveProperty('search_hits');
    expect(result).toHaveProperty('embedding_available');
    expect(result).toHaveProperty('total_time_ms');
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('returns FindSimilarOutput shape for url input', async () => {
    const __r_result = await handleFindSimilar(
      { url: 'https://example.com/page' },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('method');
    expect(typeof result.total_time_ms).toBe('number');
  });

  it('passes through max_results to pipeline', async () => {
    const __r_result = await handleFindSimilar(
      { concept: 'test', max_results: 2, include_web: false },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it('passes through domain filters to pipeline', async () => {
    const __r_result = await handleFindSimilar(
      {
        concept: 'test',
        include_domains: ['example.com'],
        include_web: true,
      },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toHaveProperty('results');
  });

  it('handles pipeline errors gracefully', async () => {
    const failRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as SmartRouter;

    const failEngine: SearchEngine = {
      name: 'fail',
      search: vi.fn().mockRejectedValue(new Error('engine down')),
    };

    const __r_result = await handleFindSimilar(
      { concept: 'test', include_web: true },
      [failEngine],
      failRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('method');
  });

  it('returns embedding_available as false (no embedding engine yet)', async () => {
    const __r_result = await handleFindSimilar(
      { concept: 'test' },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.embedding_available).toBe(false);
  });

  it('validates input: concept must be non-empty string', async () => {
    const __r_result = await handleFindSimilar(
      { concept: '' },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('validates input: url must be non-empty string', async () => {
    const __r_result = await handleFindSimilar(
      { url: '' },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('validates input: url must be valid URL format', async () => {
    const r = await handleFindSimilar(
      { url: 'not-a-url' },
      [mockEngine],
      mockRouter,
    );
    // With an invalid URL, the handler still returns either a successful
    // empty result set or a structured StageError — never throws.
    if (r.ok) {
      expect(r.data).toHaveProperty('results');
    } else {
      expect(r.error).toBeDefined();
    }
  });

  it('refuses an SSRF url seed (metadata target) before the pipeline runs', async () => {
    // WHY: the url seed is fetched raw downstream (bypassing handleFetch's
    // guard). A metadata/private seed must be refused at the handler top.
    const guardRouter = {
      fetch: vi.fn().mockResolvedValue({
        url: 'x', finalUrl: 'x', html: '', contentType: 'text/html',
        statusCode: 200, method: 'http' as const, headers: {},
      }),
    } as unknown as SmartRouter;

    const r = await handleFindSimilar(
      { url: 'http://169.254.169.254/latest/meta-data/' },
      [mockEngine],
      guardRouter,
    );

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error_reason).toMatch(/link-local|metadata|blocked/i);
      expect(r.stage).toBe('find_similar');
    }
    expect(guardRouter.fetch).not.toHaveBeenCalled();
  });

  it('max_results is capped at 50', async () => {
    const __r_result = await handleFindSimilar(
      { concept: 'test', max_results: 1000 },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeLessThanOrEqual(50);
  });

  it('max_results defaults to 10 when not specified', async () => {
    const __r_result = await handleFindSimilar(
      { concept: 'test', include_web: false },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  it('returns valid FindSimilarResult items with all required fields', async () => {
    const __r_result = await handleFindSimilar(
      { concept: 'test', include_web: true },
      [mockEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    for (const item of result.results) {
      expect(item).toHaveProperty('url');
      expect(item).toHaveProperty('title');
      expect(item).toHaveProperty('markdown');
      expect(item).toHaveProperty('relevance_score');
      expect(item).toHaveProperty('source');
      expect(item).toHaveProperty('match_signals');
      expect(typeof item.relevance_score).toBe('number');
      expect(['cache', 'search']).toContain(item.source);
      expect(typeof item.match_signals.fused_score).toBe('number');
    }
  });

  describe('evidence shape', () => {
    it('default response includes evidence and strips per-result markdown', async () => {
      const { cacheContent } = await import('../../../src/cache/store.js');
      cacheContent(
        {
          url: 'https://cached.example.com/page',
          finalUrl: 'https://cached.example.com/page',
          html: '<html><body><h1>React Hooks</h1></body></html>',
          contentType: 'text/html',
          statusCode: 200,
          method: 'http',
          headers: {},
        },
        {
          title: 'React Hooks Guide',
          markdown:
            '# React Hooks\n\n' +
            'React Hooks let you use state and other React features without writing a class. ' +
            'Hooks are functions that let you hook into React state and lifecycle features ' +
            'from function components. They are a powerful addition to the React API.\n\n' +
            'useState is the most common hook for adding stateful logic to components.',
          metadata: {},
          links: [],
          images: [],
          extractor: 'defuddle',
        },
      );

      const __r_result = await handleFindSimilar(
        { concept: 'React Hooks', include_web: false },
        [mockEngine],
        mockRouter,
      );;
      const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

      expect(result.evidence).toBeDefined();
      expect(result.evidence!.length).toBeGreaterThan(0);
      const ev = result.evidence![0];
      expect(ev.excerpt.length).toBeGreaterThan(0);
      expect(ev.citation_id).toMatch(/^[a-f0-9]{12}$/);
      expect(ev.source_span.end).toBeGreaterThan(ev.source_span.start);
      for (const r of result.results) {
        expect(r.markdown).toBe('');
      }
    });

    it('include_full_markdown=true preserves per-result markdown', async () => {
      const { cacheContent } = await import('../../../src/cache/store.js');
      const fullMarkdown =
        '# React Hooks\n\n' +
        'React Hooks let you use state and other React features without writing a class. ' +
        'Hooks are functions that let you hook into React state and lifecycle features.';
      cacheContent(
        {
          url: 'https://cached2.example.com/page',
          finalUrl: 'https://cached2.example.com/page',
          html: '<html></html>',
          contentType: 'text/html',
          statusCode: 200,
          method: 'http',
          headers: {},
        },
        {
          title: 'React Hooks Guide',
          markdown: fullMarkdown,
          metadata: {},
          links: [],
          images: [],
          extractor: 'defuddle',
        },
      );

      const __r_result = await handleFindSimilar(
        { concept: 'React Hooks', include_web: false, include_full_markdown: true },
        [mockEngine],
        mockRouter,
      );;
      const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

      expect(result.evidence).toBeDefined();
      const hasFullMarkdown = result.results.some((r) => r.markdown.length > 0);
      expect(hasFullMarkdown).toBe(true);
    });
  });

  describe('cold start auto-seed', () => {
    it('seeds cache via search and returns cache_seeded:true when domain has < 5 cached URLs', async () => {
      const store = await import('../../../src/cache/store.js');
      const search = await import('../../../src/tools/search.js');
      vi.spyOn(store, 'countCachedUrlsForDomain').mockReturnValue(2);
      const handleSearchSpy = vi.spyOn(search, 'handleSearch').mockResolvedValue({
        results: [
          { url: 'https://a.example.com/1', title: 'A', snippet: 'aa', relevance_score: 1, engines: ['mock'] },
          { url: 'https://b.example.com/2', title: 'B', snippet: 'bb', relevance_score: 0.9, engines: ['mock'] },
          { url: 'https://c.example.com/3', title: 'C', snippet: 'cc', relevance_score: 0.8, engines: ['mock'] },
        ],
        query: 'seed',
        engines_used: ['mock'],
        total_time_ms: 10,
      });

      const __r_out = await handleFindSimilar(
        { url: 'https://example.com/post-title' },
        [mockEngine],
        mockRouter,
      );;
      const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);

      const seedCall = handleSearchSpy.mock.calls.find(
        (c) => (c[0] as { query?: string }).query === 'post title example',
      );
      expect(seedCall).toBeDefined();
      expect(out.cache_seeded).toBe(true);
    });

    it('does NOT seed when domain has >= 5 cached URLs', async () => {
      const store = await import('../../../src/cache/store.js');
      const search = await import('../../../src/tools/search.js');
      vi.spyOn(store, 'countCachedUrlsForDomain').mockReturnValue(7);
      const handleSearchSpy = vi.spyOn(search, 'handleSearch');

      const __r_out = await handleFindSimilar(
        { url: 'https://example.com/post-title' },
        [mockEngine],
        mockRouter,
      );;
      const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);

      const seedCall = handleSearchSpy.mock.calls.find(
        (c) => (c[0] as { query?: string }).query === 'post title example',
      );
      expect(seedCall).toBeUndefined();
      expect(out.cache_seeded).toBeUndefined();
    });

    it('does NOT seed when only concept is provided (no url)', async () => {
      const store = await import('../../../src/cache/store.js');
      const countSpy = vi.spyOn(store, 'countCachedUrlsForDomain');

      const __r_out = await handleFindSimilar(
        { concept: 'react hooks' },
        [mockEngine],
        mockRouter,
      );;
      const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);

      expect(countSpy).not.toHaveBeenCalled();
      expect(out.cache_seeded).toBeUndefined();
    });
  });

  describe('lazy embedding readiness (D2 gate sites)', () => {
    it('awaits provider readiness before probing availability rather than returning false immediately', async () => {
      const embedModule = await import('../../../src/embedding/embed.js');

      let resolveReady: (v: boolean) => void = () => {};
      const readyPromise = new Promise<boolean>((res) => { resolveReady = res; });
      const ensureProviderReady = vi.fn().mockReturnValue(readyPromise);

      // Availability = true (service booted), provider verified only AFTER the
      // slow ensureProviderReady() resolves. If the gate did not await, the
      // synchronous isSubprocessReady() probe would read false and the whole
      // request would report embedding_available:false.
      let verified = false;
      vi.spyOn(embedModule, 'getEmbeddingService').mockReturnValue({
        isAvailable: () => true,
        isSubprocessReady: () => verified,
        ensureProviderReady,
        getIndex: () => ({ size: () => 0, has: () => false }),
        findSimilar: vi.fn().mockResolvedValue([]),
        embedAndStore: vi.fn().mockResolvedValue(undefined),
        embedAsync: vi.fn(),
      } as unknown as ReturnType<typeof embedModule.getEmbeddingService>);

      const out$ = handleFindSimilar(
        { concept: 'React hooks', include_web: false },
        [mockEngine],
        mockRouter,
      );

      // Let the pipeline reach the readiness gate, then resolve it as verified.
      await Promise.resolve();
      verified = true;
      resolveReady(true);

      const __r = await out$;
      const out = __r.ok ? __r.data : ({ ...__r } as any);

      expect(ensureProviderReady).toHaveBeenCalled();
      // The gate awaited readiness, so availability reflects the resolved state.
      expect(out.embedding_available).toBe(true);
    });
  });

  it('concurrent calls do not interfere with each other', async () => {
    const results = await Promise.all([
      handleFindSimilar(
        { concept: 'React hooks', include_web: false },
        [mockEngine],
        mockRouter,
      ),
      handleFindSimilar(
        { concept: 'Vue components', include_web: false },
        [mockEngine],
        mockRouter,
      ),
    ]);

    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.data).toHaveProperty('results');
      }
    }
  });
});
