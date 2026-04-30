import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { handleSearch } from '../../src/tools/search.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import type { SearchInput, RawSearchResult, SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';

vi.mock('node:child_process', async (orig) => {
  const real = (await orig()) as typeof import('node:child_process');
  return { ...real, spawn: vi.fn(real.spawn) };
});

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

// Mock onnxRerank so the test runs without downloading the model.
vi.mock('../../src/search/reranker/onnx.js', () => ({
  onnxRerank: vi.fn(async (_q: string, docs: { text: string }[]) =>
    docs.map((_, i) => ({ index: i, score: 1 - i * 0.1 })),
  ),
}));

describe('integration: onnx rerank E2E', () => {
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
    const out = await handleSearch(input, [engine], router);
    expect(out.results.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < out.results.length; i++) {
      expect(out.results[i - 1].relevance_score).toBeGreaterThanOrEqual(out.results[i].relevance_score);
    }
  });

  it('does NOT spawn a python subprocess during rerank', async () => {
    const engine: SearchEngine = {
      name: 'mock',
      search: vi.fn().mockResolvedValue([
        { title: 'A', url: 'https://a.com', snippet: 'a', relevance_score: 0.5, engine: 'mock' },
      ] satisfies RawSearchResult[]),
    };
    await handleSearch({ query: 'q', include_content: false }, [engine], router);
    const pythonCalls = vi.mocked(spawn).mock.calls.filter(([cmd]) =>
      typeof cmd === 'string' && /python/.test(cmd),
    );
    expect(pythonCalls).toHaveLength(0);
  });
});
