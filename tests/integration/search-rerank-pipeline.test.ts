import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import type { SearchInput, RawSearchResult, SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import type {
  RerankProvider,
  RerankCandidate,
  RerankResult,
} from '../../src/providers/rerank-provider.js';

// Mock rerank provider so the test does not need real model assets
const rerankMock = vi.fn();
vi.mock('../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async (): Promise<RerankProvider> => ({
    modelId: 'mock',
    rerank: rerankMock,
  })),
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
vi.mock('../../src/providers/extract-provider.js', async () => {
  const pipeline = await import('../../src/extraction/pipeline.js');
  return {
    getExtractProvider: vi.fn(async () => ({
      name: 'v1' as const,
      extract: (html: string, url: string, opts?: unknown) =>
        (pipeline as { extractContent: (...a: unknown[]) => unknown }).extractContent(html, url, opts),
    })),
    _resetExtractProviderForTest: vi.fn(),
  };
});


// Helper: take ids in the order the provider returned them and map to scores.
const byIds = (ids: number[], scores: number[]): RerankResult[] =>
  ids.map((id, i) => ({ id: String(id), score: scores[i] }));

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
    rerankMock.mockReset();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('search results are reordered by rerank scores', async () => {
    rerankMock.mockResolvedValue(byIds([2, 0, 3, 1], [0.98, 0.85, 0.6, 0.4]));

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const __r_output = await handleSearch(input, [mockEngine], mockRouter);
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as Record<string, unknown>);

    expect((output as { results: unknown[] }).results.length).toBeGreaterThanOrEqual(3);
    expect((output as { results: { title: string }[] }).results[0].title).toBe('TS Config Reference');
    expect((output as { results: { relevance_score: number }[] }).results[0].relevance_score).toBeGreaterThanOrEqual(0.98);
  });

  it('results below threshold are filtered out', async () => {
    process.env.WIGOLO_RELEVANCE_THRESHOLD = '0.5';
    resetConfig();

    rerankMock.mockImplementation(async (_q: string, candidates: RerankCandidate[]) => {
      const indices = candidates.map((c) => Number(c.id));
      return indices.map((idx) => ({
        id: String(idx),
        score: [0.9, 0.6, 0.3, 0.1][idx],
      }));
    });

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const __r_output = await handleSearch(input, [mockEngine], mockRouter);
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as Record<string, unknown>);

    expect((output as { results: { relevance_score: number }[] }).results.every((r) => r.relevance_score >= 0.5)).toBe(true);
  });

  it('gracefully falls through when rerank provider throws', async () => {
    rerankMock.mockRejectedValue(new Error('model not available'));

    const input: SearchInput = { query: 'typescript tutorial', include_content: false };
    const __r_output = await handleSearch(input, [mockEngine], mockRouter);
    const output = __r_output.ok ? __r_output.data : ({ ...__r_output } as Record<string, unknown>);

    expect((output as { results: unknown[] }).results.length).toBeGreaterThan(0);
    expect((output as { results: { relevance_score: number }[] }).results[0].relevance_score).toBeGreaterThanOrEqual(0.9);
  });
});
