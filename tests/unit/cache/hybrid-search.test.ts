import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedContent } from '../../../src/types.js';
import type { VectorStore } from '../../../src/providers/vector-store.js';

vi.mock('../../../src/cache/store.js', () => ({
  searchCacheFiltered: vi.fn(),
  ftsSearchRanked: vi.fn(),
  getCachedContentByNormalizedUrl: vi.fn(),
}));
vi.mock('../../../src/providers/embed-provider.js', () => ({ getEmbedProvider: vi.fn() }));
vi.mock('../../../src/providers/vector-store.js', () => ({ getVectorStore: vi.fn() }));
vi.mock('../../../src/cache/artifact-registry.js', () => ({
  ensureArtifactProviders: vi.fn(),
  isArtifactKey: vi.fn(() => false),
  resolveArtifact: vi.fn(),
  searchArtifactKeys: vi.fn(() => []),
}));
vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
}));

import { runHybridSearch } from '../../../src/cache/hybrid-search.js';
import {
  ftsSearchRanked,
  getCachedContentByNormalizedUrl,
  searchCacheFiltered,
} from '../../../src/cache/store.js';
import { getEmbedProvider } from '../../../src/providers/embed-provider.js';
import { getVectorStore } from '../../../src/providers/vector-store.js';

function cached(url: string): CachedContent {
  return {
    id: 1,
    url,
    normalizedUrl: url,
    title: 'Result',
    markdown: 'body',
    rawHtml: '',
    metadata: '{}',
    links: '[]',
    images: '[]',
    fetchMethod: 'http',
    extractorUsed: 'defuddle',
    contentHash: 'hash',
    fetchedAt: '2026-09-03 00:00:00',
    expiresAt: null,
    httpStatus: 200,
  };
}

describe('runHybridSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns FTS results with an explicit degradation method', async () => {
    vi.mocked(getEmbedProvider).mockRejectedValue(new Error('unavailable'));
    vi.mocked(searchCacheFiltered).mockReturnValue([cached('https://example.com/fts')]);

    const result = await runHybridSearch({ query: 'needle', limit: 3 });

    expect(result.method).toBe('fts');
    expect(result.results.map((row) => row.url)).toEqual(['https://example.com/fts']);
  });

  it('returns fused results with the hybrid method', async () => {
    vi.mocked(getEmbedProvider).mockResolvedValue({
      modelId: 'test',
      dim: 2,
      embed: vi.fn().mockResolvedValue([new Float32Array([1, 0])]),
    });
    const store: VectorStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      size: vi.fn().mockResolvedValue(1),
      search: vi.fn().mockResolvedValue([
        { id: 'one', score: 1, metadata: { url: 'https://example.com/one', contentHash: 'h', modelId: 'test' } },
      ]),
    };
    vi.mocked(getVectorStore).mockResolvedValue(store);
    vi.mocked(ftsSearchRanked).mockReturnValue([{ url: 'https://example.com/one', score: 1 }]);
    vi.mocked(getCachedContentByNormalizedUrl).mockReturnValue(cached('https://example.com/one'));

    const result = await runHybridSearch({ query: 'needle' });

    expect(result.method).toBe('hybrid');
    expect(result.results.map((row) => row.url)).toEqual(['https://example.com/one']);
  });
});
