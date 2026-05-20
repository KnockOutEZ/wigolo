import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSearch } from '../../src/tools/search.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import type { SearchInput, RawSearchResult, SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type {
  RerankProvider,
  RerankCandidate,
} from '../../src/providers/rerank-provider.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'mock',
    markdown: '# mock',
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


// Mock rerank provider so the test runs without downloading the model.
vi.mock('../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async (): Promise<RerankProvider> => ({
    modelId: 'mock',
    rerank: vi.fn(async (_q: string, candidates: RerankCandidate[]) =>
      candidates.map((c, i) => ({ id: c.id, score: 1 - i * 0.1 })),
    ),
  })),
}));

describe('integration: cross-encoder rerank E2E', () => {
  const originalEnv = process.env;
  const router = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html></html>',
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
      WIGOLO_RERANKER: 'onnx',
      WIGOLO_RELEVANCE_THRESHOLD: '0',
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

  it('search→rerank end-to-end produces monotonically non-increasing scores', async () => {
    const engine: SearchEngine = {
      name: 'mock',
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.com', snippet: 'a', relevance_score: 0.5, engine: 'mock' },
        { title: 'B', url: 'https://b.com', snippet: 'b', relevance_score: 0.5, engine: 'mock' },
        { title: 'C', url: 'https://c.com', snippet: 'c', relevance_score: 0.5, engine: 'mock' },
      ] satisfies RawSearchResult[]),
    };
    const input: SearchInput = { query: 'test query', include_content: false };
    const __r_out = await handleSearch(input, [engine], router);
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as Record<string, unknown>);
    const results = (out as { results: { relevance_score: number }[] }).results;
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].relevance_score).toBeGreaterThanOrEqual(results[i].relevance_score);
    }
  });
});
