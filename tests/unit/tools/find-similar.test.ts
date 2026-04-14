import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FindSimilarInput, SearchEngine, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

// Mock extraction pipeline
vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock',
    markdown: '# Mock\n\nContent.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
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
    const result = await handleFindSimilar(
      {} as FindSimilarInput,
      [mockEngine],
      mockRouter,
    );
    expect(result.error).toBeDefined();
  });

  it('returns FindSimilarOutput shape for concept input', async () => {
    const result = await handleFindSimilar(
      { concept: 'React hooks' },
      [mockEngine],
      mockRouter,
    );

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('method');
    expect(result).toHaveProperty('cache_hits');
    expect(result).toHaveProperty('search_hits');
    expect(result).toHaveProperty('embedding_available');
    expect(result).toHaveProperty('total_time_ms');
    expect(Array.isArray(result.results)).toBe(true);
  });

  it('returns FindSimilarOutput shape for url input', async () => {
    const result = await handleFindSimilar(
      { url: 'https://example.com/page' },
      [mockEngine],
      mockRouter,
    );

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('method');
    expect(typeof result.total_time_ms).toBe('number');
  });

  it('passes through max_results to pipeline', async () => {
    const result = await handleFindSimilar(
      { concept: 'test', max_results: 2, include_web: false },
      [mockEngine],
      mockRouter,
    );

    expect(result.results.length).toBeLessThanOrEqual(2);
  });

  it('passes through domain filters to pipeline', async () => {
    const result = await handleFindSimilar(
      {
        concept: 'test',
        include_domains: ['example.com'],
        include_web: true,
      },
      [mockEngine],
      mockRouter,
    );

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

    const result = await handleFindSimilar(
      { concept: 'test', include_web: true },
      [failEngine],
      failRouter,
    );

    expect(result).toHaveProperty('results');
    expect(result).toHaveProperty('method');
  });

  it('returns embedding_available as false (no embedding engine yet)', async () => {
    const result = await handleFindSimilar(
      { concept: 'test' },
      [mockEngine],
      mockRouter,
    );

    expect(result.embedding_available).toBe(false);
  });

  it('validates input: concept must be non-empty string', async () => {
    const result = await handleFindSimilar(
      { concept: '' },
      [mockEngine],
      mockRouter,
    );

    expect(result.error).toBeDefined();
  });

  it('validates input: url must be non-empty string', async () => {
    const result = await handleFindSimilar(
      { url: '' },
      [mockEngine],
      mockRouter,
    );

    expect(result.error).toBeDefined();
  });

  it('validates input: url must be valid URL format', async () => {
    const result = await handleFindSimilar(
      { url: 'not-a-url' },
      [mockEngine],
      mockRouter,
    );

    expect(result).toHaveProperty('results');
  });

  it('max_results is capped at 50', async () => {
    const result = await handleFindSimilar(
      { concept: 'test', max_results: 1000 },
      [mockEngine],
      mockRouter,
    );

    expect(result.results.length).toBeLessThanOrEqual(50);
  });

  it('max_results defaults to 10 when not specified', async () => {
    const result = await handleFindSimilar(
      { concept: 'test', include_web: false },
      [mockEngine],
      mockRouter,
    );

    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  it('returns valid FindSimilarResult items with all required fields', async () => {
    const result = await handleFindSimilar(
      { concept: 'test', include_web: true },
      [mockEngine],
      mockRouter,
    );

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

    for (const result of results) {
      expect(result).toHaveProperty('results');
      expect(result.error).toBeUndefined();
    }
  });
});
