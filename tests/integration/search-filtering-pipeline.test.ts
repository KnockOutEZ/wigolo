import { describe, it, expect, vi } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchEngine, RawSearchResult } from '../../src/types.js';

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    searchTotalTimeoutMs: 30000,
    searchFetchTimeoutMs: 10000,
    searxngQueryTimeoutMs: 5000,
  }),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../src/cache/store.js', () => ({
  getCachedSearchResults: vi.fn().mockReturnValue(null),
  cacheSearchResults: vi.fn(),
  normalizeUrl: vi.fn((url: string) => url),
}));

vi.mock('../../src/search/validator.js', () => ({
  validateLinks: vi.fn((results: unknown[]) => results),
}));

vi.mock('../../src/search/query.js', () => ({
  decomposeQuery: vi.fn((q: string) => [q]),
}));

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({ markdown: 'mock content', title: 'Test' }),
}));

const mockRouter = {
  fetch: vi.fn().mockResolvedValue({
    html: '<p>test content</p>',
    finalUrl: 'https://test.com',
    contentType: 'text/html',
  }),
} as any;

describe('search filtering pipeline integration', () => {
  it('full pipeline: two engines -> dedup -> domain filter -> validate -> output', async () => {
    const searxngEngine: SearchEngine = {
      name: 'searxng',
      search: vi.fn().mockResolvedValue([
        { title: 'React Docs', url: 'https://react.dev/learn', snippet: 'Learn React', relevance_score: 0.95, engine: 'searxng' },
        { title: 'React Blog', url: 'https://react.dev/blog', snippet: 'Blog post', relevance_score: 0.85, engine: 'searxng' },
        { title: 'Medium React', url: 'https://medium.com/react', snippet: 'Tutorial', relevance_score: 0.80, engine: 'searxng' },
        { title: 'GH React', url: 'https://github.com/facebook/react', snippet: 'Source code', relevance_score: 0.75, engine: 'searxng' },
        { title: 'SO Question', url: 'https://stackoverflow.com/q/react', snippet: 'Q&A', relevance_score: 0.70, engine: 'searxng' },
      ]),
    };

    const ddgEngine: SearchEngine = {
      name: 'duckduckgo',
      search: vi.fn().mockResolvedValue([
        { title: 'React Docs', url: 'https://react.dev/learn', snippet: 'Official docs', relevance_score: 0.90, engine: 'duckduckgo' },
        { title: 'W3Schools React', url: 'https://w3schools.com/react', snippet: 'Tutorial', relevance_score: 0.65, engine: 'duckduckgo' },
        { title: 'Dev.to React', url: 'https://dev.to/react-guide', snippet: 'Guide', relevance_score: 0.60, engine: 'duckduckgo' },
      ]),
    };

    const output = await handleSearch(
      {
        query: 'react hooks tutorial',
        include_domains: ['react.dev', 'github.com'],
        category: 'docs',
        include_content: false,
        max_results: 10,
      },
      [searxngEngine, ddgEngine],
      mockRouter,
    );

    // After dedup: react.dev/learn merged, ~7 unique URLs
    // After domain filter (react.dev, github.com): react.dev/learn, react.dev/blog, github.com/facebook/react
    expect(output.results).toHaveLength(3);
    expect(output.results.every(r =>
      r.url.includes('react.dev') || r.url.includes('github.com')
    )).toBe(true);
    // Verify dedup picked the higher score for react.dev/learn
    const learnResult = output.results.find(r => r.url.includes('react.dev/learn'));
    expect(learnResult).toBeDefined();
    expect(learnResult!.relevance_score).toBe(0.95);
    // Both engines used
    expect(output.engines_used).toContain('searxng');
    expect(output.engines_used).toContain('duckduckgo');
    // Category passed to both engines
    expect(searxngEngine.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: 'docs' }),
    );
    expect(ddgEngine.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ category: 'docs' }),
    );
  });

  it('full pipeline: exclude_domains removes results after dedup', async () => {
    const engine: SearchEngine = {
      name: 'test',
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://react.dev/a', snippet: 'a', relevance_score: 0.9, engine: 'test' },
        { title: 'B', url: 'https://medium.com/b', snippet: 'b', relevance_score: 0.8, engine: 'test' },
        { title: 'C', url: 'https://medium.com/c', snippet: 'c', relevance_score: 0.7, engine: 'test' },
        { title: 'D', url: 'https://github.com/d', snippet: 'd', relevance_score: 0.6, engine: 'test' },
      ]),
    };

    const output = await handleSearch(
      {
        query: 'react',
        exclude_domains: ['medium.com'],
        include_content: false,
      },
      [engine],
      mockRouter,
    );

    expect(output.results).toHaveLength(2);
    expect(output.results.every(r => !r.url.includes('medium.com'))).toBe(true);
  });

  it('full pipeline: combined include + exclude + date filters', async () => {
    const engine: SearchEngine = {
      name: 'test',
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://docs.react.dev/a', snippet: 'a', relevance_score: 0.9, engine: 'test' },
        { title: 'B', url: 'https://blog.react.dev/b', snippet: 'b', relevance_score: 0.8, engine: 'test' },
        { title: 'C', url: 'https://stackoverflow.com/c', snippet: 'c', relevance_score: 0.7, engine: 'test' },
      ]),
    };

    const output = await handleSearch(
      {
        query: 'react hooks',
        include_domains: ['react.dev'],
        from_date: '2026-01-01',
        to_date: '2026-04-01',
        include_content: false,
      },
      [engine],
      mockRouter,
    );

    // Domain filter: docs.react.dev and blog.react.dev match react.dev
    // Date filter: best-effort pass-through (all kept)
    expect(output.results).toHaveLength(2);
    expect(output.results.every(r => r.url.includes('react.dev'))).toBe(true);
    // Verify date params passed to engine
    expect(engine.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        fromDate: '2026-01-01',
        toDate: '2026-04-01',
      }),
    );
  });

  it('full pipeline: no filters applied preserves existing behavior', async () => {
    const engine: SearchEngine = {
      name: 'test',
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://react.dev/a', snippet: 'a', relevance_score: 0.9, engine: 'test' },
        { title: 'B', url: 'https://medium.com/b', snippet: 'b', relevance_score: 0.8, engine: 'test' },
        { title: 'C', url: 'https://github.com/c', snippet: 'c', relevance_score: 0.7, engine: 'test' },
      ]),
    };

    const output = await handleSearch(
      { query: 'react', include_content: false },
      [engine],
      mockRouter,
    );

    expect(output.results).toHaveLength(3);
  });

  it('full pipeline: filter attrition triggers overfetch factor', async () => {
    const engine: SearchEngine = {
      name: 'test',
      search: vi.fn().mockResolvedValue([]),
    };

    await handleSearch(
      { query: 'react', max_results: 5, include_domains: ['react.dev'], include_content: false },
      [engine],
      mockRouter,
    );

    // With domain filters: maxResults * 3 = 15
    expect(engine.search).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxResults: 15 }),
    );
  });
});
