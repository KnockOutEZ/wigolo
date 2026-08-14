import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedContent, CacheStats } from '../../../src/types.js';
import type {
  VectorStore,
  VectorSearchResult,
} from '../../../src/providers/vector-store.js';

vi.mock('../../../src/cache/store.js', () => ({
  searchCacheFiltered: vi.fn().mockReturnValue([]),
  getCacheStats: vi.fn(),
  clearCacheEntries: vi.fn(),
  ftsSearchRanked: vi.fn(),
  getCachedContentByNormalizedUrl: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/cache/change-detector.js', () => ({
  detectChange: vi.fn(),
}));

const extractMock = vi.fn();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));


vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(),
}));

vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(),
}));

import { handleCache } from '../../../src/tools/cache.js';
import {
  ftsSearchRanked,
  getCachedContentByNormalizedUrl,
} from '../../../src/cache/store.js';
import { getEmbedProvider } from '../../../src/providers/embed-provider.js';
import { getVectorStore } from '../../../src/providers/vector-store.js';

function makeCachedContent(overrides: Partial<CachedContent> = {}): CachedContent {
  return {
    id: 1,
    url: overrides.url ?? 'https://example.com',
    normalizedUrl: overrides.normalizedUrl ?? overrides.url ?? 'https://example.com',
    title: 'Example',
    markdown: '# Example',
    rawHtml: null,
    metadata: '{}',
    links: '[]',
    images: '[]',
    fetchMethod: 'http',
    extractorUsed: 'defuddle',
    contentHash: 'abc',
    fetchedAt: '2026-05-01 10:00:00',
    expiresAt: null,
    ...overrides,
  } as CachedContent;
}

function makeVectorStore(opts: {
  size: number;
  results: VectorSearchResult[];
}): VectorStore {
  return {
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    size: vi.fn().mockResolvedValue(opts.size),
    search: vi.fn().mockResolvedValue(opts.results),
  };
}

describe('handleCache --- hybrid mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fuses FTS5 + vector rankings and hydrates results in fused order', async () => {
    vi.mocked(ftsSearchRanked).mockReturnValue([
      { url: 'https://a', score: 10 },
      { url: 'https://b', score: 8 },
      { url: 'https://c', score: 5 },
    ]);

    vi.mocked(getEmbedProvider).mockResolvedValue({
      modelId: 'test',
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array([1, 0, 0, 0])]),
    });

    vi.mocked(getVectorStore).mockResolvedValue(
      makeVectorStore({
        size: 3,
        results: [
          { id: 'c', score: 0.9, metadata: { url: 'https://c', contentHash: 'hc', modelId: 'test' } },
          { id: 'd', score: 0.6, metadata: { url: 'https://d', contentHash: 'hd', modelId: 'test' } },
          { id: 'a', score: 0.5, metadata: { url: 'https://a', contentHash: 'ha', modelId: 'test' } },
        ],
      }),
    );

    vi.mocked(getCachedContentByNormalizedUrl).mockImplementation((url: string) =>
      makeCachedContent({ url, normalizedUrl: url }),
    );

    const out = await handleCache({ query: 'foo', mode: 'hybrid', limit: 4 });

    expect(out.results).toBeDefined();
    const urls = out.results!.map(r => r.url);
    // a + c appear in both rankings -> they fuse to the top two
    expect(urls.slice(0, 2).sort()).toEqual(['https://a', 'https://c']);
    // b (fts-only) + d (vec-only) both appear, fts/vec singletons tie
    expect(urls.slice(2).sort()).toEqual(['https://b', 'https://d']);
  });

  it('falls back to FTS5 when vector index is empty', async () => {
    vi.mocked(getEmbedProvider).mockResolvedValue({
      modelId: 'test',
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array([1, 0, 0, 0])]),
    });
    vi.mocked(getVectorStore).mockResolvedValue(makeVectorStore({ size: 0, results: [] }));

    const out = await handleCache({ query: 'foo', mode: 'hybrid' });

    // Falling through to FTS-only means searchCacheFiltered was used,
    // which is mocked to return []. The hybrid runner returns null and
    // the existing FTS branch handles the response.
    expect(out.results).toEqual([]);
    expect(ftsSearchRanked).not.toHaveBeenCalled();
  });

  it('falls back to FTS5 when embedding provider fails', async () => {
    vi.mocked(getEmbedProvider).mockRejectedValue(new Error('provider unavailable'));
    vi.mocked(getVectorStore).mockResolvedValue(makeVectorStore({ size: 3, results: [] }));

    const out = await handleCache({ query: 'foo', mode: 'hybrid' });
    expect(out.results).toEqual([]);
    expect(out.error).toBeUndefined();
  });

  it('does not run hybrid when no query is provided', async () => {
    const out = await handleCache({ mode: 'hybrid' });
    expect(getVectorStore).not.toHaveBeenCalled();
    expect(getEmbedProvider).not.toHaveBeenCalled();
    expect(out.results).toEqual([]);
  });

  it('respects limit when hydrating fused results', async () => {
    vi.mocked(ftsSearchRanked).mockReturnValue([
      { url: 'https://a', score: 5 },
      { url: 'https://b', score: 4 },
      { url: 'https://c', score: 3 },
    ]);
    vi.mocked(getEmbedProvider).mockResolvedValue({
      modelId: 'test',
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array([1, 0, 0, 0])]),
    });
    vi.mocked(getVectorStore).mockResolvedValue(
      makeVectorStore({
        size: 3,
        results: [
          { id: 'a', score: 0.9, metadata: { url: 'https://a', contentHash: 'ha', modelId: 'test' } },
          { id: 'b', score: 0.7, metadata: { url: 'https://b', contentHash: 'hb', modelId: 'test' } },
          { id: 'c', score: 0.5, metadata: { url: 'https://c', contentHash: 'hc', modelId: 'test' } },
        ],
      }),
    );
    vi.mocked(getCachedContentByNormalizedUrl).mockImplementation((url: string) =>
      makeCachedContent({ url, normalizedUrl: url }),
    );

    const out = await handleCache({ query: 'foo', mode: 'hybrid', limit: 2 });
    expect(out.results).toHaveLength(2);
  });

  it('skips URLs missing from the cache during hydration', async () => {
    vi.mocked(ftsSearchRanked).mockReturnValue([{ url: 'https://a', score: 5 }]);
    vi.mocked(getEmbedProvider).mockResolvedValue({
      modelId: 'test',
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array([1, 0, 0, 0])]),
    });
    vi.mocked(getVectorStore).mockResolvedValue(
      makeVectorStore({
        size: 2,
        results: [
          { id: 'b', score: 0.9, metadata: { url: 'https://b', contentHash: 'hb', modelId: 'test' } },
          { id: 'a', score: 0.5, metadata: { url: 'https://a', contentHash: 'ha', modelId: 'test' } },
        ],
      }),
    );
    vi.mocked(getCachedContentByNormalizedUrl).mockImplementation((url: string) =>
      url === 'https://b' ? null : makeCachedContent({ url, normalizedUrl: url }),
    );

    const out = await handleCache({ query: 'foo', mode: 'hybrid', limit: 3 });
    expect(out.results!.map(r => r.url)).toEqual(['https://a']);
  });

  // The hybrid path is its own return site in the handler. A budget wired to
  // only the FTS site would leave every `query`-driven hybrid call unbounded,
  // and no FTS-driven test can tell the difference.
  it('applies the same output budget on the hybrid return path', async () => {
    const big = '# Guide\n\n' + 'The pool keeps a bounded set of open sockets. '.repeat(4000);
    vi.mocked(ftsSearchRanked).mockReturnValue([
      { url: 'https://a', score: 10 },
      { url: 'https://b', score: 8 },
    ]);
    vi.mocked(getEmbedProvider).mockResolvedValue({
      modelId: 'test',
      dim: 4,
      embed: vi.fn().mockResolvedValue([new Float32Array([1, 0, 0, 0])]),
    });
    vi.mocked(getVectorStore).mockResolvedValue(
      makeVectorStore({
        size: 2,
        results: [
          { id: 'a', score: 0.9, metadata: { url: 'https://a', contentHash: 'ha', modelId: 'test' } },
          { id: 'b', score: 0.5, metadata: { url: 'https://b', contentHash: 'hb', modelId: 'test' } },
        ],
      }),
    );
    vi.mocked(getCachedContentByNormalizedUrl).mockImplementation((url: string) =>
      makeCachedContent({ url, normalizedUrl: url, markdown: big }),
    );
    const { countTokens } = await import('../../../src/search/tokens.js');
    const { DEFAULT_CACHE_MAX_TOKENS_OUT } = await import('../../../src/cache/output-budget.js');

    const out = await handleCache({ query: 'foo', mode: 'hybrid' });

    expect(out.results!.length).toBeGreaterThan(0);
    const total = out.results!.reduce((n, r) => n + countTokens(r.markdown), 0);
    expect(total).toBeLessThanOrEqual(DEFAULT_CACHE_MAX_TOKENS_OUT);
    expect(out.truncation).toBeDefined();
    expect(out.truncation!.dropped_chars).toBeGreaterThan(0);
  });
});
