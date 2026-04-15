import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchInput, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock',
    markdown: '# Mock\n\nContent.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const { handleSearch } = await import('../../../src/tools/search.js');

describe('handleSearch timing metadata', () => {
  const originalEnv = process.env;

  const engine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      { title: 'R1', url: 'https://e.com/1', snippet: 's1', relevance_score: 0.9, engine: 'mock' },
      { title: 'R2', url: 'https://e.com/2', snippet: 's2', relevance_score: 0.8, engine: 'mock' },
      { title: 'R3', url: 'https://e.com/3', snippet: 's3', relevance_score: 0.7, engine: 'mock' },
      { title: 'R4', url: 'https://e.com/4', snippet: 's4', relevance_score: 0.6, engine: 'mock' },
      { title: 'R5', url: 'https://e.com/5', snippet: 's5', relevance_score: 0.5, engine: 'mock' },
    ] satisfies RawSearchResult[]),
  };

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'none' };
    resetConfig();
    initDatabase(':memory:');
    vi.clearAllMocks();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('includes search_time_ms and fetch_time_ms when include_content=true', async () => {
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://e.com/1', finalUrl: 'https://e.com/1',
        html: '<html></html>', contentType: 'text/html', statusCode: 200,
        method: 'http' as const, headers: {},
      }),
    } as unknown as SmartRouter;

    const input: SearchInput = { query: 'test', max_results: 2 };
    const out = await handleSearch(input, [engine], router);

    expect(out.search_time_ms).toBeGreaterThanOrEqual(0);
    expect(out.fetch_time_ms).toBeGreaterThanOrEqual(0);
    expect(out.total_time_ms).toBeGreaterThanOrEqual(out.search_time_ms! + out.fetch_time_ms! - 5);
  });

  it('search_time_ms present but fetch_time_ms is 0 when include_content=false', async () => {
    const router = { fetch: vi.fn() } as unknown as SmartRouter;

    const input: SearchInput = { query: 'test', include_content: false };
    const out = await handleSearch(input, [engine], router);

    expect(out.search_time_ms).toBeGreaterThanOrEqual(0);
    expect(out.fetch_time_ms).toBe(0);
    expect(router.fetch).not.toHaveBeenCalled();
  });

  it('fetches all results in parallel (5×200ms fetch stays under 500ms)', async () => {
    const router = {
      fetch: vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 200));
        return {
          url: 'https://e.com/x', finalUrl: 'https://e.com/x',
          html: '<html></html>', contentType: 'text/html', statusCode: 200,
          method: 'http' as const, headers: {},
        };
      }),
    } as unknown as SmartRouter;

    const input: SearchInput = { query: 'test', max_results: 5 };
    const start = Date.now();
    const out = await handleSearch(input, [engine], router);
    const elapsed = Date.now() - start;

    expect(out.results).toHaveLength(5);
    // If parallel: ~200ms + overhead. If sequential: ~1000ms+.
    expect(elapsed).toBeLessThan(600);
  });

  it('still applies budget in relevance (not completion) order', async () => {
    const router = {
      fetch: vi.fn().mockImplementation(async (url: string) => {
        // higher-relevance URLs sleep LONGER, so completion order != relevance order
        const n = parseInt(url.split('/').pop() ?? '1', 10);
        await new Promise(r => setTimeout(r, (6 - n) * 30));
        return {
          url, finalUrl: url,
          html: '<html></html>', contentType: 'text/html', statusCode: 200,
          method: 'http' as const, headers: {},
        };
      }),
    } as unknown as SmartRouter;

    const { extractContent } = await import('../../../src/extraction/pipeline.js');
    vi.mocked(extractContent).mockImplementation(async (_html: any, url: string) => ({
      title: url, markdown: 'x'.repeat(20000), metadata: {}, links: [], images: [],
      extractor: 'defuddle' as const,
    } as any));

    const input: SearchInput = { query: 'test', max_results: 5, max_total_chars: 50000 };
    const out = await handleSearch(input, [engine], router);

    // top 2 (R1, R2) should be present; tail should be truncated or empty
    const r1 = out.results.find(r => r.url === 'https://e.com/1');
    const r2 = out.results.find(r => r.url === 'https://e.com/2');
    expect(r1?.markdown_content).toBeDefined();
    expect(r2?.markdown_content).toBeDefined();

    const total = out.results.reduce((s, r) => s + (r.markdown_content?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(50000);
  });
});
