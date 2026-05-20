import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchInput, RawSearchResult, SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

// Mock ONNX reranker so the test does not need real model assets
vi.mock('../../src/search/reranker/onnx.js', () => ({
  onnxRerank: vi.fn(),
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

import { onnxRerank } from '../../src/search/reranker/onnx.js';

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
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'onnx', WIGOLO_RELEVANCE_THRESHOLD: '0' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('search results are reordered by ONNX reranker scores', async () => {
    vi.mocked(onnxRerank).mockResolvedValue([
      { index: 2, score: 0.98 },
      { index: 0, score: 0.85 },
      { index: 3, score: 0.60 },
      { index: 1, score: 0.40 },
    ]);

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const __r_output = await handleSearch(input, [mockEngine], mockRouter);;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(output.results.length).toBeGreaterThanOrEqual(3);
    // Verify reranking changed the order from position-based
    expect(output.results[0].title).toBe('TS Config Reference');
    // Post-rerank score gets authority/consensus/recency boosts; assert ≥ ONNX score
    expect(output.results[0].relevance_score).toBeGreaterThanOrEqual(0.98);
  });

  it('results below threshold are filtered out', async () => {
    process.env.WIGOLO_RELEVANCE_THRESHOLD = '0.5';
    resetConfig();

    vi.mocked(onnxRerank).mockResolvedValue([
      { index: 0, score: 0.9 },
      { index: 1, score: 0.6 },
      { index: 2, score: 0.3 },
      { index: 3, score: 0.1 },
    ]);

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const __r_output = await handleSearch(input, [mockEngine], mockRouter);;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(output.results.every(r => r.relevance_score >= 0.5)).toBe(true);
  });

  it('gracefully falls through when ONNX reranker throws', async () => {
    vi.mocked(onnxRerank).mockRejectedValue(new Error('model not available'));

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const __r_output = await handleSearch(input, [mockEngine], mockRouter);;
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as any);

    expect(output.results.length).toBeGreaterThan(0);
    // Original position-based order preserved (raw 0.9 + boosts)
    expect(output.results[0].relevance_score).toBeGreaterThanOrEqual(0.9);
  });
});
