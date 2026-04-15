import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SearchInput, RawSearchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Cached Title',
    markdown: '# Topic\n\nArticle body about the topic.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

const cacheContentMock = vi.fn();
const embedAsyncMock = vi.fn();
const isAvailableMock = vi.fn().mockReturnValue(true);

vi.mock('../../../src/cache/store.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/cache/store.js')>(
    '../../../src/cache/store.js',
  );
  return {
    ...actual,
    cacheContent: (...args: unknown[]) => cacheContentMock(...args),
  };
});

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: () => ({
    isAvailable: () => isAvailableMock(),
    embedAsync: (...args: unknown[]) => embedAsyncMock(...args),
  }),
}));

const { handleSearch } = await import('../../../src/tools/search.js');

describe('search caches and embeds fetched results', () => {
  const originalEnv = process.env;

  const engine = {
    name: 'mock',
    search: vi.fn().mockResolvedValue([
      { title: 'R1', url: 'https://e.com/1', snippet: 's1', relevance_score: 0.9, engine: 'mock' },
    ] satisfies RawSearchResult[]),
  };

  const router = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://e.com/1', finalUrl: 'https://e.com/1',
      html: '<html></html>', contentType: 'text/html', statusCode: 200,
      method: 'http' as const, headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    process.env = { ...originalEnv, VALIDATE_LINKS: 'false', WIGOLO_RERANKER: 'none' };
    resetConfig();
    initDatabase(':memory:');
    cacheContentMock.mockClear();
    embedAsyncMock.mockClear();
    isAvailableMock.mockReturnValue(true);
    (engine.search as any).mockClear();
    (router.fetch as any).mockClear();
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
  });

  it('calls cacheContent for fetched results', async () => {
    const input: SearchInput = { query: 'test', max_results: 1 };
    await handleSearch(input, [engine], router);
    expect(cacheContentMock).toHaveBeenCalledTimes(1);
  });

  it('calls embedAsync when embedding service is available', async () => {
    const input: SearchInput = { query: 'test', max_results: 1 };
    await handleSearch(input, [engine], router);
    expect(embedAsyncMock).toHaveBeenCalledWith(
      'https://e.com/1',
      expect.stringContaining('Topic'),
    );
  });

  it('skips embedAsync when embedding unavailable', async () => {
    isAvailableMock.mockReturnValue(false);
    const input: SearchInput = { query: 'test', max_results: 1 };
    await handleSearch(input, [engine], router);
    expect(embedAsyncMock).not.toHaveBeenCalled();
  });
});
