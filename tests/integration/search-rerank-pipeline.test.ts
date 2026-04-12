import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchInput, RawSearchResult, SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

// Mock FlashRank subprocess to avoid requiring Python in CI
vi.mock('../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn().mockResolvedValue(true),
  flashRankRerank: vi.fn(),
  resetAvailabilityCache: vi.fn(),
}));

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock Title',
    markdown: '# Mock Content',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

import { flashRankRerank, isFlashRankAvailable } from '../../src/search/flashrank.js';

describe('integration: search + rerank pipeline', () => {
  const originalEnv = process.env;

  const mockEngine: SearchEngine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      { title: 'TypeScript Handbook', url: 'https://ts.dev/handbook', snippet: 'The official handbook', relevance_score: 0.9, engine: 'mock' },
      { title: 'TypeScript Wikipedia', url: 'https://en.wikipedia.org/typescript', snippet: 'Wikipedia article', relevance_score: 0.7, engine: 'mock' },
      { title: 'TS Config Reference', url: 'https://ts.dev/tsconfig', snippet: 'TSConfig options', relevance_score: 0.5, engine: 'mock' },
      { title: 'JS vs TS Blog Post', url: 'https://blog.dev/js-vs-ts', snippet: 'Comparison blog', relevance_score: 0.3, engine: 'mock' },
    ] satisfies RawSearchResult[]),
  };

  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://ts.dev/handbook',
      finalUrl: 'https://ts.dev/handbook',
      html: '<html><body><h1>Test</h1></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'flashrank', WIGOLO_RELEVANCE_THRESHOLD: '0' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('search results are reordered by FlashRank scores', async () => {
    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 2, score: 0.98 },
      { index: 0, score: 0.85 },
      { index: 3, score: 0.60 },
      { index: 1, score: 0.40 },
    ]);

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const output = await handleSearch(input, [mockEngine], mockRouter);

    expect(output.results.length).toBeGreaterThanOrEqual(3);
    // Verify reranking changed the order from position-based
    expect(output.results[0].title).toBe('TS Config Reference');
    expect(output.results[0].relevance_score).toBe(0.98);
  });

  it('results below threshold are filtered out', async () => {
    process.env.WIGOLO_RELEVANCE_THRESHOLD = '0.5';
    resetConfig();

    vi.mocked(flashRankRerank).mockResolvedValue([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.6 },
      { index: 2, score: 0.3 },
      { index: 3, score: 0.1 },
    ]);

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const output = await handleSearch(input, [mockEngine], mockRouter);

    expect(output.results.every(r => r.relevance_score >= 0.5)).toBe(true);
  });

  it('gracefully falls through when FlashRank not available', async () => {
    vi.mocked(isFlashRankAvailable).mockResolvedValue(false);

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const output = await handleSearch(input, [mockEngine], mockRouter);

    expect(output.results.length).toBeGreaterThan(0);
    expect(flashRankRerank).not.toHaveBeenCalled();
  });

  it('gracefully falls through when FlashRank subprocess returns null', async () => {
    vi.mocked(flashRankRerank).mockResolvedValue(null);

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const output = await handleSearch(input, [mockEngine], mockRouter);

    expect(output.results.length).toBeGreaterThan(0);
    // Original position-based order preserved
    expect(output.results[0].relevance_score).toBe(0.9);
  });
});
