import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchInput, RawSearchResult } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content\n\nExtracted content here.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

describe('integration: rerank in search pipeline', () => {
  const originalEnv = process.env;

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html><body>content</body></html>',
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

  it('search results pass through rerank without score changes', async () => {
    const engine = {
      name: 'mock',
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.com', snippet: 'first', relevance_score: 0.9, engine: 'mock' },
        { title: 'B', url: 'https://b.com', snippet: 'second', relevance_score: 0.7, engine: 'mock' },
        { title: 'C', url: 'https://c.com', snippet: 'third', relevance_score: 0.5, engine: 'mock' },
      ] satisfies RawSearchResult[]),
    };

    const input: SearchInput = { query: 'test rerank', include_content: false };
    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.results).toHaveLength(3);
    expect(output.results[0].relevance_score).toBe(0.9);
    expect(output.results[1].relevance_score).toBe(0.7);
    expect(output.results[2].relevance_score).toBe(0.5);
  });

  it('rerank passthrough preserves order when multiple engines provide results', async () => {
    const engine1 = {
      name: 'engine1',
      search: vi.fn().mockResolvedValue([
        { title: 'E1-A', url: 'https://e1a.com', snippet: 'e1a', relevance_score: 0.95, engine: 'engine1' },
        { title: 'E1-B', url: 'https://e1b.com', snippet: 'e1b', relevance_score: 0.60, engine: 'engine1' },
      ]),
    };
    const engine2 = {
      name: 'engine2',
      search: vi.fn().mockResolvedValue([
        { title: 'E2-A', url: 'https://e2a.com', snippet: 'e2a', relevance_score: 0.80, engine: 'engine2' },
      ]),
    };

    const input: SearchInput = { query: 'multi engine', include_content: false };
    const output = await handleSearch(input, [engine1, engine2], mockRouter);

    expect(output.results[0].relevance_score).toBe(0.95);
    expect(output.results[1].relevance_score).toBe(0.80);
    expect(output.results[2].relevance_score).toBe(0.60);
    expect(output.engines_used).toContain('engine1');
    expect(output.engines_used).toContain('engine2');
  });

  it('rerank passthrough works with content fetching enabled', async () => {
    const engine = {
      name: 'mock',
      search: vi.fn().mockResolvedValue([
        { title: 'With Content', url: 'https://content.com', snippet: 'has content', relevance_score: 0.9, engine: 'mock' },
      ] satisfies RawSearchResult[]),
    };

    const input: SearchInput = { query: 'content test', max_results: 1 };
    const output = await handleSearch(input, [engine], mockRouter);

    expect(output.results).toHaveLength(1);
    expect(output.results[0].markdown_content).toContain('Mock Content');
    expect(output.results[0].relevance_score).toBe(0.9);
  });

  it('full pipeline: dedup -> rerank -> validate -> slice -> fetch', async () => {
    const engine1 = {
      name: 'e1',
      search: vi.fn().mockResolvedValue([
        { title: 'Overlap', url: 'https://overlap.com', snippet: 'from e1', relevance_score: 0.7, engine: 'e1' },
        { title: 'Unique E1', url: 'https://e1only.com', snippet: 'e1 only', relevance_score: 0.6, engine: 'e1' },
      ]),
    };
    const engine2 = {
      name: 'e2',
      search: vi.fn().mockResolvedValue([
        { title: 'Overlap Better', url: 'https://overlap.com', snippet: 'from e2 better', relevance_score: 0.9, engine: 'e2' },
      ]),
    };

    const input: SearchInput = { query: 'overlap test', include_content: false, max_results: 5 };
    const output = await handleSearch(input, [engine1, engine2], mockRouter);

    const overlapResults = output.results.filter(r => r.url.includes('overlap.com'));
    expect(overlapResults).toHaveLength(1);
    expect(overlapResults[0].relevance_score).toBe(0.9);
    expect(output.engines_used).toContain('e1');
    expect(output.engines_used).toContain('e2');
  });
});
