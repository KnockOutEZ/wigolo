import { describe, it, expect, vi } from 'vitest';
import { handleSearch } from '../../../src/tools/search.js';
import type { SearchEngine, RawSearchResult } from '../../../src/types.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    searchTotalTimeoutMs: 30000,
    searchFetchTimeoutMs: 10000,
    searxngQueryTimeoutMs: 5000,
  }),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/cache/store.js', () => ({
  getCachedSearchResults: vi.fn().mockReturnValue(null),
  cacheSearchResults: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

vi.mock('../../../src/search/validator.js', () => ({
  validateLinks: vi.fn((results: unknown[]) => results),
}));

vi.mock('../../../src/search/query.js', () => ({
  decomposeQuery: vi.fn((q: string) => [q]),
}));

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn(),
}));

function makeEngine(results: RawSearchResult[]): SearchEngine {
  return {
    name: 'test',
    search: vi.fn().mockResolvedValue(results),
  };
}

const mockRouter = {
  fetch: vi.fn().mockResolvedValue({ html: '<p>test</p>', finalUrl: 'https://test.com', contentType: 'text/html' }),
} as any;

describe('search pipeline filtering', () => {
  // 1. include_domains filters results in pipeline output
  it('filters results by include_domains in pipeline', async () => {
    const engine = makeEngine([
      { title: 'React Docs', url: 'https://react.dev/docs', snippet: 'docs', relevance_score: 0.9, engine: 'test' },
      { title: 'Medium Post', url: 'https://medium.com/react', snippet: 'post', relevance_score: 0.8, engine: 'test' },
      { title: 'GH Repo', url: 'https://github.com/react', snippet: 'repo', relevance_score: 0.7, engine: 'test' },
    ]);

    const output = await handleSearch(
      { query: 'react', include_domains: ['react.dev'], include_content: false },
      [engine],
      mockRouter,
    );

    expect(output.results).toHaveLength(1);
    expect(output.results[0].url).toContain('react.dev');
  });

  // 2. exclude_domains removes matched results from pipeline
  it('filters results by exclude_domains in pipeline', async () => {
    const engine = makeEngine([
      { title: 'React Docs', url: 'https://react.dev/docs', snippet: 'docs', relevance_score: 0.9, engine: 'test' },
      { title: 'Medium Post', url: 'https://medium.com/react', snippet: 'post', relevance_score: 0.8, engine: 'test' },
    ]);

    const output = await handleSearch(
      { query: 'react', exclude_domains: ['medium.com'], include_content: false },
      [engine],
      mockRouter,
    );

    expect(output.results).toHaveLength(1);
    expect(output.results[0].url).toContain('react.dev');
  });

  // 3. category is passed through to engine options
  it('passes category to engine search options', async () => {
    const engine = makeEngine([]);

    await handleSearch(
      { query: 'react', category: 'code', include_content: false },
      [engine],
      mockRouter,
    );

    expect(engine.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({ category: 'code' }),
    );
  });

  // 4. from_date and to_date are passed through to engine options
  it('passes from_date and to_date to engine search options', async () => {
    const engine = makeEngine([]);

    await handleSearch(
      { query: 'react', from_date: '2026-01-01', to_date: '2026-04-01', include_content: false },
      [engine],
      mockRouter,
    );

    expect(engine.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({
        fromDate: '2026-01-01',
        toDate: '2026-04-01',
      }),
    );
  });

  // 5. Filters that remove all results return empty output (not error)
  it('returns empty results when all filtered out (no error)', async () => {
    const engine = makeEngine([
      { title: 'A', url: 'https://medium.com/a', snippet: 's', relevance_score: 0.9, engine: 'test' },
    ]);

    const output = await handleSearch(
      { query: 'react', include_domains: ['nonexistent.dev'], include_content: false },
      [engine],
      mockRouter,
    );

    expect(output.results).toEqual([]);
    expect(output.error).toBeUndefined();
  });

  // 6. Overfetch: engines receive maxResults * 3 when domain filters active
  it('overfetches from engines when domain filters are active', async () => {
    const engine = makeEngine([]);

    await handleSearch(
      { query: 'react', max_results: 5, include_domains: ['react.dev'], include_content: false },
      [engine],
      mockRouter,
    );

    expect(engine.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({
        maxResults: 15, // 5 * 3
      }),
    );
  });

  // 7. Without domain filters, engines receive maxResults * 2 (existing behavior)
  it('uses standard overfetch factor when no domain filters', async () => {
    const engine = makeEngine([]);

    await handleSearch(
      { query: 'react', max_results: 5, include_content: false },
      [engine],
      mockRouter,
    );

    expect(engine.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({
        maxResults: 10, // 5 * 2
      }),
    );
  });

  // 8. include_domains passed to engine for SearXNG native filtering
  it('passes include_domains to engine options for SearXNG', async () => {
    const engine = makeEngine([]);

    await handleSearch(
      { query: 'react', include_domains: ['react.dev', 'github.com'], include_content: false },
      [engine],
      mockRouter,
    );

    expect(engine.search).toHaveBeenCalledWith(
      'react',
      expect.objectContaining({
        includeDomains: ['react.dev', 'github.com'],
      }),
    );
  });
});
