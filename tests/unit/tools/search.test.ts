import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../../src/tools/search.js';
import type { SearchInput, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { cacheSearchResults } from '../../../src/cache/store.js';

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

describe('handleSearch', () => {
  const originalEnv = process.env;

  const mockSearchBackend = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      { title: 'Result 1', url: 'https://example.com/1', snippet: 'First result', relevance_score: 0.9, engine: 'mock' },
      { title: 'Result 2', url: 'https://example.com/2', snippet: 'Second result', relevance_score: 0.7, engine: 'mock' },
      { title: 'Result 3', url: 'https://example.com/3', snippet: 'Third result', relevance_score: 0.5, engine: 'mock' },
    ] satisfies RawSearchResult[]),
  };

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

  it('returns search results with snippets (include_content=false)', async () => {
    const input: SearchInput = { query: 'test', include_content: false };
    const output = await handleSearch(input, [mockSearchBackend], mockRouter);

    expect(output.results).toHaveLength(3);
    expect(output.results[0].title).toBe('Result 1');
    expect(output.results[0].snippet).toBe('First result');
    expect(output.results[0].markdown_content).toBeUndefined();
    expect(output.query).toBe('test');
    expect(output.engines_used).toContain('mock');
    expect(output.total_time_ms).toBeGreaterThanOrEqual(0);
  });

  it('fetches content when include_content=true (default)', async () => {
    const input: SearchInput = { query: 'test', max_results: 2 };
    const output = await handleSearch(input, [mockSearchBackend], mockRouter);

    expect(output.results).toHaveLength(2);
    expect(output.results[0].markdown_content).toContain('Mock Content');
  });

  it('respects max_results', async () => {
    const input: SearchInput = { query: 'test', max_results: 1, include_content: false };
    const output = await handleSearch(input, [mockSearchBackend], mockRouter);
    expect(output.results).toHaveLength(1);
  });

  it('sets fetch_failed when content fetch throws', async () => {
    const failRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('timeout')),
    } as unknown as SmartRouter;

    const input: SearchInput = { query: 'test', max_results: 1 };
    const output = await handleSearch(input, [mockSearchBackend], failRouter);

    expect(output.results[0].markdown_content).toBeUndefined();
    expect(output.results[0].fetch_failed).toBe('timeout');
  });

  it('respects max_total_chars budget', async () => {
    const bigContentRouter = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://example.com/1',
        finalUrl: 'https://example.com/1',
        html: '<html><body>' + 'x'.repeat(60000) + '</body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'http' as const,
        headers: {},
      }),
    } as unknown as SmartRouter;

    const { extractContent } = await import('../../../src/extraction/pipeline.js');
    vi.mocked(extractContent).mockResolvedValue({
      title: 'Big',
      markdown: 'x'.repeat(60000),
      metadata: {},
      links: [],
      images: [],
      extractor: 'defuddle' as const,
    });

    const input: SearchInput = { query: 'test', max_results: 3, max_total_chars: 50000 };
    const output = await handleSearch(input, [mockSearchBackend], bigContentRouter);

    const totalChars = output.results.reduce(
      (sum, r) => sum + (r.markdown_content?.length ?? 0), 0
    );
    expect(totalChars).toBeLessThanOrEqual(50000);
    expect(output.results.some(r => r.content_truncated)).toBe(true);
  });

  it('returns error field when all engines fail', async () => {
    const failEngine = {
      name: 'failing',
      search: vi.fn().mockRejectedValue(new Error('all engines down')),
    };

    const input: SearchInput = { query: 'test' };
    const output = await handleSearch(input, [failEngine], mockRouter);

    expect(output.results).toHaveLength(0);
    expect(output.error).toBeDefined();
  });

  it('merges results from multiple engines', async () => {
    const engine2 = {
      name: 'engine2',
      search: vi.fn().mockResolvedValue([
        { title: 'E2 Result', url: 'https://other.com', snippet: 'Different', relevance_score: 0.95, engine: 'engine2' },
      ]),
    };

    const input: SearchInput = { query: 'test', include_content: false };
    const output = await handleSearch(input, [mockSearchBackend, engine2], mockRouter);

    expect(output.results.length).toBeGreaterThanOrEqual(3);
    expect(output.engines_used).toContain('mock');
    expect(output.engines_used).toContain('engine2');
  });

  it('filters engines by search_engines input parameter', async () => {
    const engine1 = {
      name: 'searxng',
      search: vi.fn().mockResolvedValue([
        { title: 'SearXNG Result', url: 'https://searxng.com', snippet: 'From SearXNG', relevance_score: 0.9, engine: 'searxng' },
      ]),
    };
    const engine2 = {
      name: 'duckduckgo',
      search: vi.fn().mockResolvedValue([
        { title: 'DDG Result', url: 'https://ddg.com', snippet: 'From DDG', relevance_score: 0.8, engine: 'duckduckgo' },
      ]),
    };

    const input: SearchInput = { query: 'test', include_content: false, search_engines: ['duckduckgo'] };
    const output = await handleSearch(input, [engine1, engine2], mockRouter);

    expect(engine1.search).not.toHaveBeenCalled();
    expect(engine2.search).toHaveBeenCalled();
    expect(output.engines_used).toContain('duckduckgo');
    expect(output.engines_used).not.toContain('searxng');
  });

  describe('force_refresh', () => {
    it('bypasses search cache when force_refresh is true', async () => {
      cacheSearchResults('test', [
        { title: 'Stale', url: 'https://cached.example/1', snippet: 'stale snippet', relevance_score: 0.9 },
      ], ['cached-engine']);

      const input: SearchInput = { query: 'test', include_content: false, force_refresh: true };
      const output = await handleSearch(input, [mockSearchBackend], mockRouter);

      expect(mockSearchBackend.search).toHaveBeenCalled();
      expect(output.engines_used).toContain('mock');
      expect(output.engines_used).not.toContain('cached-engine');
    });

    it('uses search cache when force_refresh is false/undefined', async () => {
      cacheSearchResults('test', [
        { title: 'Stale', url: 'https://cached.example/1', snippet: 'stale snippet', relevance_score: 0.9 },
      ], ['cached-engine']);

      const input: SearchInput = { query: 'test', include_content: false };
      const output = await handleSearch(input, [mockSearchBackend], mockRouter);

      expect(mockSearchBackend.search).not.toHaveBeenCalled();
      expect(output.engines_used).toContain('cached-engine');
      expect(output.results[0].title).toBe('Stale');
    });

    it('passes force_refresh to content fetching', async () => {
      const input: SearchInput = { query: 'test', max_results: 1, force_refresh: true };
      await handleSearch(input, [mockSearchBackend], mockRouter);

      expect(mockRouter.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ force_refresh: true }),
      );
    });

    it('does not pass force_refresh to content fetching when false', async () => {
      const input: SearchInput = { query: 'test', max_results: 1 };
      await handleSearch(input, [mockSearchBackend], mockRouter);

      const callArgs = vi.mocked(mockRouter.fetch).mock.calls[0][1];
      expect(callArgs?.force_refresh).toBeUndefined();
    });

    it('bypasses multi-query search cache when force_refresh is true', async () => {
      cacheSearchResults('test a | test b', [
        { title: 'Stale Multi', url: 'https://cached.example/2', snippet: 'stale', relevance_score: 0.9 },
      ], ['multi-cached']);

      const input: SearchInput = { query: ['test a', 'test b'], include_content: false, force_refresh: true };
      const output = await handleSearch(input, [mockSearchBackend], mockRouter);

      expect(mockSearchBackend.search).toHaveBeenCalled();
      expect(output.engines_used).not.toContain('multi-cached');
    });
  });

  it('uses all engines when search_engines filter matches none', async () => {
    const engine1 = {
      name: 'bing',
      search: vi.fn().mockResolvedValue([
        { title: 'Bing Result', url: 'https://bing.com', snippet: 'From Bing', relevance_score: 0.9, engine: 'bing' },
      ]),
    };

    const input: SearchInput = { query: 'test', include_content: false, search_engines: ['nonexistent'] };
    const output = await handleSearch(input, [engine1], mockRouter);

    expect(engine1.search).toHaveBeenCalled();
    expect(output.results.length).toBeGreaterThan(0);
  });
});
