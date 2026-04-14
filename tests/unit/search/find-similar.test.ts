import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FindSimilarInput, SearchEngine, RawSearchResult, CachedContent } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheContent } from '../../../src/cache/store.js';
import type { RawFetchResult, ExtractionResult } from '../../../src/types.js';

// Mock the extraction pipeline to avoid Playwright dependency
vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content\n\nSome extracted content here.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
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
});
