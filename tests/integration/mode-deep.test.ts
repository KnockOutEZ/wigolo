import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import type { RawSearchResult } from '../../src/types.js';

vi.mock('../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Mock',
    markdown: 'full body content paragraph',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

import { handleSearch } from '../../src/tools/search.js';
import * as multiQueryMod from '../../src/search/multi-query.js';

describe('search mode=deep — query expansion', () => {
  beforeEach(() => {
    process.env.VALIDATE_LINKS = 'false';
    process.env.WIGOLO_RERANKER = 'none';
    initDatabase(':memory:');
    resetConfig();
  });
  afterEach(() => {
    closeDatabase();
    resetConfig();
    delete process.env.VALIDATE_LINKS;
    delete process.env.WIGOLO_RERANKER;
  });

  it('expands a single string query into 3-5 variants before fan-out', async () => {
    const fanOutSpy = vi.spyOn(multiQueryMod, 'fanOutSearch');
    const engine = {
      name: 'eng',
      search: vi.fn().mockResolvedValue([{
        title: 't', url: 'https://x.test/', snippet: 's',
        relevance_score: 0.5, engine: 'eng',
      }] satisfies RawSearchResult[]),
    };
    const router = {
      fetch: vi.fn().mockResolvedValue({
        url: 'https://x.test/', finalUrl: 'https://x.test/',
        html: '<html><body><p>full body</p></body></html>',
        contentType: 'text/html', statusCode: 200, method: 'http', headers: {},
      }),
    } as unknown as SmartRouter;

    await handleSearch({ query: 'go generics', mode: 'deep' }, [engine], router);

    expect(fanOutSpy).toHaveBeenCalled();
    const queriesArg = fanOutSpy.mock.calls[0][0];
    expect(queriesArg.length).toBeGreaterThanOrEqual(3);
    expect(queriesArg.length).toBeLessThanOrEqual(5);
    fanOutSpy.mockRestore();
  });

  it('fetches full bodies for the top-K=5 results in deep mode', async () => {
    const router = {
      fetch: vi.fn().mockImplementation((url: string) => Promise.resolve({
        url, finalUrl: url,
        html: '<html><body><article><p>full body content paragraph</p></article></body></html>',
        contentType: 'text/html', statusCode: 200, method: 'http', headers: {},
      })),
    } as unknown as SmartRouter;
    const engine = {
      name: 'e',
      search: vi.fn().mockResolvedValue(
        Array.from({ length: 8 }, (_, i) => ({
          title: `t${i}`, url: `https://x.test/${i}`, snippet: 'snippet',
          relevance_score: 1 - i * 0.1, engine: 'e',
        })) satisfies RawSearchResult[],
      ),
    };
    const __r_out = await handleSearch(
      { query: 'topic', mode: 'deep', max_results: 10, include_full_markdown: true },
      [engine],
      router,
    );;
    const out = __r_out.ok ? __r_out.data : ({ ...__r_out } as any);
    expect(router.fetch).toHaveBeenCalled();
    // K cap: at most 5 fetches even though 8 candidates exist (max_results=10)
    expect((router.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(5);
    // At least one result has markdown_content from the body
    const withContent = out.results.find(r => (r.markdown_content ?? '').length > 0);
    expect(withContent).toBeTruthy();
  });
});
