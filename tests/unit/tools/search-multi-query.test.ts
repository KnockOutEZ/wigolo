import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../../src/tools/search.js';
import type { SearchInput, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

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

describe('handleSearch with multi-query array input', () => {
  const originalEnv = process.env;

  function makeMockEngine(name: string, resultsFn: (query: string) => RawSearchResult[]) {
    return {
      name,
      search: vi.fn().mockImplementation((query: string) =>
        Promise.resolve(resultsFn(query)),
      ),
    };
  }

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com/1',
      finalUrl: 'https://example.com/1',
      html: '<html><body><h1>Test</h1><p>Content</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('accepts string[] query and returns queries_executed', async () => {
    const engine = makeMockEngine('mock', (query) => [
      { title: `Result for ${query}`, url: `https://example.com/${query}`, snippet: query, relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['react hooks', 'vue composition'],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.queries_executed).toBeDefined();
    expect(output.queries_executed).toContain('react hooks');
    expect(output.queries_executed).toContain('vue composition');
    expect(output.results.length).toBeGreaterThan(0);
  });

  it('deduplicates results across queries', async () => {
    const engine = makeMockEngine('mock', () => [
      { title: 'Same Page', url: 'https://example.com/same', snippet: 'Same', relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['query one', 'query two', 'query three'],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    const urls = output.results.map(r => r.url);
    const uniqueUrls = new Set(urls);
    expect(urls.length).toBe(uniqueUrls.size);
  });

  it('normalizes duplicate queries in array', async () => {
    const engine = makeMockEngine('mock', (query) => [
      { title: `Result for ${query}`, url: `https://example.com/${encodeURIComponent(query)}`, snippet: query, relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['React Hooks', 'react hooks', 'REACT HOOKS'],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.queries_executed).toHaveLength(1);
    expect(output.queries_executed![0]).toBe('react hooks');
  });

  it('still works with single string query (backward compat)', async () => {
    const engine = makeMockEngine('mock', () => [
      { title: 'Result', url: 'https://example.com', snippet: 'test', relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = { query: 'single query', include_content: false };
    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.query).toBe('single query');
    expect(output.results.length).toBeGreaterThan(0);
    expect(output.queries_executed).toBeUndefined();
  });

  it('returns error when all queries across all engines fail', async () => {
    const engine = {
      name: 'failing',
      search: vi.fn().mockRejectedValue(new Error('engine error')),
    };

    const input: SearchInput = {
      query: ['query1', 'query2'],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.results).toHaveLength(0);
    expect(output.error).toBeDefined();
    expect(output.queries_executed).toBeDefined();
  });

  it('populates query field with first query for display', async () => {
    const engine = makeMockEngine('mock', () => [
      { title: 'R', url: 'https://r.com', snippet: 'r', relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['first query', 'second query'],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.query).toBe('first query');
  });

  it('applies domain filters to multi-query results', async () => {
    const engine = makeMockEngine('mock', () => [
      { title: 'Allowed', url: 'https://allowed.com/page', snippet: 'allowed', relevance_score: 0.9, engine: 'mock' },
      { title: 'Blocked', url: 'https://blocked.com/page', snippet: 'blocked', relevance_score: 0.8, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['q1', 'q2'],
      include_content: false,
      include_domains: ['allowed.com'],
    };

    const output = await handleSearch(input, [engine], mockRouter);

    const urls = output.results.map(r => r.url);
    expect(urls.every(u => u.includes('allowed.com'))).toBe(true);
  });

  it('fetches content for multi-query results when include_content=true', async () => {
    const engine = makeMockEngine('mock', (query) => [
      { title: `R ${query}`, url: `https://example.com/${query.replace(/\s/g, '-')}`, snippet: query, relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['react hooks', 'vue composition'],
      max_results: 2,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    const withContent = output.results.filter(r => r.markdown_content);
    expect(withContent.length).toBeGreaterThan(0);
  });

  it('context format works with multi-query', async () => {
    const engine = makeMockEngine('mock', () => [
      { title: 'Context Result', url: 'https://ctx.com', snippet: 'context snippet', relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['query one', 'query two'],
      format: 'context',
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.context_text).toBeDefined();
    expect(output.context_text!.length).toBeGreaterThan(0);
  });

  it('handles empty array query gracefully', async () => {
    const engine = makeMockEngine('mock', () => []);

    const input: SearchInput = {
      query: [] as unknown as string[],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.results).toHaveLength(0);
    expect(output.error).toBeDefined();
  });

  it('handles array of empty strings gracefully', async () => {
    const engine = makeMockEngine('mock', () => []);

    const input: SearchInput = {
      query: ['', '   ', '\t'],
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.results).toHaveLength(0);
    expect(output.error).toBeDefined();
  });

  it('respects max_results cap with multi-query', async () => {
    const engine = makeMockEngine('mock', (query) =>
      Array.from({ length: 10 }, (_, i) => ({
        title: `R${i} ${query}`,
        url: `https://example.com/${query.replace(/\s/g, '-')}/${i}`,
        snippet: `${query} ${i}`,
        relevance_score: 1.0 - i * 0.05,
        engine: 'mock',
      })),
    );

    const input: SearchInput = {
      query: ['q1', 'q2', 'q3'],
      max_results: 5,
      include_content: false,
    };

    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.results.length).toBeLessThanOrEqual(5);
  });

  it('caches multi-query results', async () => {
    const engine = makeMockEngine('mock', () => [
      { title: 'Cached', url: 'https://cached.com', snippet: 'cache me', relevance_score: 0.9, engine: 'mock' },
    ]);

    const input: SearchInput = {
      query: ['cache test one', 'cache test two'],
      include_content: false,
    };

    await handleSearch(input, [engine], mockRouter);

    const output2 = await handleSearch(input, [engine], mockRouter);
    expect(output2.results.length).toBeGreaterThan(0);
  });

  it('search_engines filter works with multi-query', async () => {
    const engine1 = { name: 'searxng', search: vi.fn().mockResolvedValue([
      { title: 'SX', url: 'https://sx.com', snippet: 'sx', relevance_score: 0.9, engine: 'searxng' },
    ]) };
    const engine2 = { name: 'bing', search: vi.fn().mockResolvedValue([
      { title: 'B', url: 'https://b.com', snippet: 'b', relevance_score: 0.8, engine: 'bing' },
    ]) };

    const input: SearchInput = {
      query: ['multi q'],
      include_content: false,
      search_engines: ['bing'],
    };

    const output = await handleSearch(input, [engine1, engine2], mockRouter);

    expect(engine1.search).not.toHaveBeenCalled();
    expect(engine2.search).toHaveBeenCalled();
    expect(output.engines_used).toContain('bing');
  });
});
