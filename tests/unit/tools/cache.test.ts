import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CachedContent, CacheStats } from '../../../src/types.js';

vi.mock('../../../src/cache/store.js', () => ({
  searchCacheFiltered: vi.fn(),
  getCacheStats: vi.fn(),
  clearCacheEntries: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleCache } from '../../../src/tools/cache.js';
import { searchCacheFiltered, getCacheStats, clearCacheEntries } from '../../../src/cache/store.js';

function makeCachedContent(overrides: Partial<CachedContent> = {}): CachedContent {
  return {
    id: 1,
    url: 'https://example.com',
    normalizedUrl: 'https://example.com',
    title: 'Example',
    markdown: '# Example\n\nContent here.',
    rawHtml: '<html></html>',
    metadata: '{}',
    links: '[]',
    images: '[]',
    fetchMethod: 'http',
    extractorUsed: 'defuddle',
    contentHash: 'abc123',
    fetchedAt: '2026-04-12 10:00:00',
    expiresAt: null,
    ...overrides,
  };
}

describe('handleCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns stats when stats=true', () => {
    const stats: CacheStats = {
      total_urls: 5,
      total_size_mb: 1.23,
      oldest: '2026-04-10 00:00:00',
      newest: '2026-04-12 00:00:00',
    };
    vi.mocked(getCacheStats).mockReturnValue(stats);

    const result = handleCache({ stats: true });

    expect(result.stats).toEqual(stats);
    expect(result.results).toBeUndefined();
    expect(result.cleared).toBeUndefined();
    expect(getCacheStats).toHaveBeenCalledOnce();
  });

  it('returns cleared count when clear=true', () => {
    vi.mocked(clearCacheEntries).mockReturnValue(3);

    const result = handleCache({ clear: true, url_pattern: '*example.com*' });

    expect(result.cleared).toBe(3);
    expect(result.results).toBeUndefined();
    expect(clearCacheEntries).toHaveBeenCalledWith({
      query: undefined,
      urlPattern: '*example.com*',
      since: undefined,
    });
  });

  it('returns search results for query', () => {
    const cached = [makeCachedContent()];
    vi.mocked(searchCacheFiltered).mockReturnValue(cached);

    const result = handleCache({ query: 'example' });

    expect(result.results).toHaveLength(1);
    expect(result.results![0].url).toBe('https://example.com');
    expect(result.results![0].title).toBe('Example');
    expect(result.results![0].markdown).toBe('# Example\n\nContent here.');
    expect(result.results![0].fetched_at).toBe('2026-04-12 10:00:00');
    expect(searchCacheFiltered).toHaveBeenCalledWith({
      query: 'example',
      urlPattern: undefined,
      since: undefined,
    });
  });

  it('passes all filters to searchCacheFiltered', () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    handleCache({ query: 'test', url_pattern: '*docs*', since: '2026-04-01' });

    expect(searchCacheFiltered).toHaveBeenCalledWith({
      query: 'test',
      urlPattern: '*docs*',
      since: '2026-04-01',
    });
  });

  it('returns empty results for no matches', () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    const result = handleCache({ query: 'nonexistent' });

    expect(result.results).toEqual([]);
  });

  it('returns error on exception', () => {
    vi.mocked(searchCacheFiltered).mockImplementation(() => {
      throw new Error('DB error');
    });

    const result = handleCache({ query: 'test' });

    expect(result.error).toBe('DB error');
  });

  it('rejects clear without filters', () => {
    const result = handleCache({ clear: true });

    expect(result.error).toBe('clear requires at least one filter (query, url_pattern, or since)');
    expect(result.cleared).toBeUndefined();
    expect(clearCacheEntries).not.toHaveBeenCalled();
  });

  it('clears with combined query + url_pattern', () => {
    vi.mocked(clearCacheEntries).mockReturnValue(2);

    const result = handleCache({ clear: true, query: 'test', url_pattern: '*example.com*' });

    expect(result.cleared).toBe(2);
    expect(clearCacheEntries).toHaveBeenCalledWith({
      query: 'test',
      urlPattern: '*example.com*',
      since: undefined,
    });
  });

  it('stats takes priority over clear', () => {
    const stats: CacheStats = { total_urls: 1, total_size_mb: 0.01, oldest: '', newest: '' };
    vi.mocked(getCacheStats).mockReturnValue(stats);

    const result = handleCache({ stats: true, clear: true });

    expect(result.stats).toBeDefined();
    expect(result.cleared).toBeUndefined();
    expect(clearCacheEntries).not.toHaveBeenCalled();
  });
});
