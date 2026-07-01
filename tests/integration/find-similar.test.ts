import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchEngine, RawSearchResult, RawFetchResult, ExtractionResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { cacheContent } from '../../src/cache/store.js';

// Mock extraction pipeline
const extractMock = vi.fn().mockResolvedValue({
  title: 'Fetched Page',
  markdown: '# Fetched Page\n\nContent about **React** hooks and state management patterns.',
  metadata: {},
  links: [],
  images: [],
  extractor: 'defuddle' as const,
});
vi.mock('../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));


const { handleFindSimilar } = await import('../../src/tools/find-similar.js');

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

describe('find_similar integration', () => {
  const originalEnv = process.env;

  const searchEngine: SearchEngine = {
    name: 'integration-stub',
    search: vi.fn().mockResolvedValue([
      {
        title: 'React Patterns',
        url: 'https://patterns.dev/react',
        snippet: 'Common React design patterns and best practices.',
        relevance_score: 0.92,
        engine: 'integration-stub',
      },
      {
        title: 'State Management Guide',
        url: 'https://blog.example.com/state-management',
        snippet: 'A comprehensive guide to state management in React.',
        relevance_score: 0.85,
        engine: 'integration-stub',
      },
    ] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://react.dev/hooks',
      finalUrl: 'https://react.dev/hooks',
      html: '<html><body><h1>React Hooks</h1><p>Hooks let you use state.</p></body></html>',
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

  it('end-to-end: concept search with cache + web fallback', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks let you use **state** and **lifecycle** features in function components.',
    );
    seedCache(
      'https://react.dev/components',
      'React Components',
      '# React Components\n\nBuild UIs with reusable **components** that manage their own state.',
    );

    const __r_result = await handleFindSimilar(
      { concept: 'React hooks state management' },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.total_time_ms).toBeGreaterThanOrEqual(0);
    expect(['hybrid', 'fts5', 'search']).toContain(result.method);
    expect(result.embedding_available).toBe(false);

    const sources = result.results.map(r => r.source);
    expect(sources).toContain('cache');
  });

  it('end-to-end: URL-based similarity with cache', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks let you use **state** and other React features.',
    );
    seedCache(
      'https://react.dev/context',
      'React Context',
      '# React Context\n\nContext provides a way to pass **state** through the component tree.',
    );
    seedCache(
      'https://react.dev/reducer',
      'React useReducer',
      '# useReducer Hook\n\nAn alternative to **useState** for complex state logic.',
    );

    const __r_result = await handleFindSimilar(
      {
        url: 'https://react.dev/hooks',
        include_web: false,
      },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    const urls = result.results.map(r => r.url);
    expect(urls).not.toContain('https://react.dev/hooks');
    expect(result.cache_hits).toBeGreaterThan(0);
    expect(result.search_hits).toBe(0);
  });

  it('end-to-end: domain filtering works across both sources', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state**.',
    );
    seedCache(
      'https://angular.dev/guide',
      'Angular Guide',
      '# Angular Guide\n\nAngular **state** management.',
    );

    const __r_result = await handleFindSimilar(
      {
        concept: 'state management hooks',
        include_domains: ['react.dev'],
        include_web: false,
      },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    for (const r of result.results) {
      expect(r.url).toContain('react.dev');
    }
  });

  it('end-to-end: empty cache falls back to web search', async () => {
    const __r_result = await handleFindSimilar(
      { concept: 'quantum computing latest research' },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.search_hits).toBeGreaterThan(0);
    expect(result.cache_hits).toBe(0);
    expect(searchEngine.search).toHaveBeenCalled();
  });

  it('end-to-end: both sources disabled returns empty results', async () => {
    const __r_result = await handleFindSimilar(
      {
        concept: 'anything',
        include_cache: false,
        include_web: false,
      },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results).toEqual([]);
  });

  it('end-to-end: results have valid match_signals', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state** management.',
    );

    const __r_result = await handleFindSimilar(
      { concept: 'React hooks', include_web: false },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    for (const r of result.results) {
      expect(r.match_signals).toBeDefined();
      expect(typeof r.match_signals.fused_score).toBe('number');
      if (r.source === 'cache') {
        expect(typeof r.match_signals.fts5_rank).toBe('number');
      }
    }
  });

  it('end-to-end: URL fetch failure does not crash pipeline', async () => {
    const failRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('DNS resolution failed')),
    } as unknown as SmartRouter;

    const failEngine: SearchEngine = {
      name: 'fail',
      search: vi.fn().mockRejectedValue(new Error('all engines down')),
    };

    const __r_result = await handleFindSimilar(
      { url: 'https://nonexistent.example.com/page' },
      [failEngine],
      failRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('total_time_ms');
  });

  it('end-to-end: large cache with many results respects max_results', async () => {
    for (let i = 0; i < 25; i++) {
      seedCache(
        `https://example.com/react-page-${i}`,
        `React Tutorial ${i}`,
        `# React Tutorial ${i}\n\nLearn about **React** hooks, **state**, and components.`,
      );
    }

    const __r_result = await handleFindSimilar(
      { concept: 'React hooks state', max_results: 5, include_web: false },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeLessThanOrEqual(5);
    expect(result.results.length).toBeGreaterThan(0);
  });

  it('end-to-end: results are sorted by relevance descending', async () => {
    seedCache(
      'https://a.com/hooks',
      'React Hooks Deep Dive',
      '# React Hooks\n\n**Hooks** let you use **state** in function components. The **useState** hook is fundamental.',
    );
    seedCache(
      'https://b.com/intro',
      'React Introduction',
      '# Intro to React\n\nReact is a **JavaScript** library for building user interfaces.',
    );

    const __r_result = await handleFindSimilar(
      { concept: 'React hooks state management', include_web: false },
      [searchEngine],
      mockRouter,
    );;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    for (let i = 1; i < result.results.length; i++) {
      expect(result.results[i].relevance_score).toBeLessThanOrEqual(
        result.results[i - 1].relevance_score,
      );
    }
  });

  it('end-to-end: concurrent requests do not interfere', async () => {
    seedCache('https://a.com', 'Topic A', '# Topic A\n\n**State** management.');
    seedCache('https://b.com', 'Topic B', '# Topic B\n\n**Routing** patterns.');

    const [resultA, resultB] = await Promise.all([
      handleFindSimilar(
        { concept: 'state management', include_web: false },
        [searchEngine],
        mockRouter,
      ),
      handleFindSimilar(
        { concept: 'routing patterns', include_web: false },
        [searchEngine],
        mockRouter,
      ),
    ]);

    expect(resultA.error).toBeUndefined();
    expect(resultB.error).toBeUndefined();
  });

  // Integration-boundary regression guard for the RAG case. Concept mode +
  // thin cache + no web fallback must emit
  // cold_start through the handleFindSimilar boundary.
  it('end-to-end H9: cold_start fires when concept mode returns only 1-2 weak cache hits', async () => {
    // Populated cache (>= 3 pages) but only 1 weak hit on
    // the actual concept query — the per-query thinness must surface.
    seedCache(
      'https://example.com/deployment',
      'Deployment environment',
      '# Deployment environment\n\nA deployment environment is used in the next generation of software deployment.',
    );
    for (let i = 0; i < 4; i++) {
      seedCache(
        `https://unrelated-${i}.example`,
        `Unrelated ${i}`,
        `# Unrelated topic ${i}\n\nNot related to the query.`,
      );
    }

    const __r_result = await handleFindSimilar(
      {
        concept: 'retrieval augmented generation',
        include_cache: true,
        include_web: false,
      },
      [searchEngine],
      mockRouter,
    );
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeLessThanOrEqual(2);
    expect(result.cold_start).toBeDefined();
    expect(result.cold_start).toMatch(/thin|too few|weak|sparse|cold|1 cache match|few cache match/i);
  });

  // Integration-boundary regression guard for the opt-in
  // ranking_debug field. Default off, on when input flag is true.
  it('end-to-end M10: ranking_debug is OMITTED by default', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state** management.',
    );

    const __r_result = await handleFindSimilar(
      { concept: 'React hooks state management', include_web: false },
      [searchEngine],
      mockRouter,
    );
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.ranking_debug).toBeUndefined();
    }
  });

  it('end-to-end M10: ranking_debug is EMITTED per result when include_ranking_debug=true', async () => {
    seedCache(
      'https://react.dev/hooks',
      'React Hooks',
      '# React Hooks\n\nHooks for **state** management.',
    );

    const __r_result = await handleFindSimilar(
      {
        concept: 'React hooks state management',
        include_web: false,
        include_ranking_debug: true,
      },
      [searchEngine],
      mockRouter,
    );
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.results.length).toBeGreaterThan(0);
    for (const r of result.results) {
      expect(r.ranking_debug).toBeDefined();
      expect(typeof r.ranking_debug.rrf_score).toBe('number');
    }
  });
});
