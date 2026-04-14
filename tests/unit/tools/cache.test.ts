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

vi.mock('../../../src/cache/change-detector.js', () => ({
  detectChange: vi.fn(),
}));

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn(),
}));

import { handleCache } from '../../../src/tools/cache.js';
import { searchCacheFiltered, getCacheStats, clearCacheEntries } from '../../../src/cache/store.js';
import { detectChange } from '../../../src/cache/change-detector.js';
import { extractContent } from '../../../src/extraction/pipeline.js';

function mockRouter(html = '<html></html>', finalUrl?: string) {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: finalUrl ?? 'https://example.com',
      finalUrl: finalUrl ?? 'https://example.com',
      html,
      contentType: 'text/html',
      statusCode: 200,
      headers: {},
    }),
  } as any;
}

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

  it('returns stats when stats=true', async () => {
    const stats: CacheStats = {
      total_urls: 5,
      total_size_mb: 1.23,
      oldest: '2026-04-10 00:00:00',
      newest: '2026-04-12 00:00:00',
    };
    vi.mocked(getCacheStats).mockReturnValue(stats);

    const result = await handleCache({ stats: true });

    expect(result.stats).toEqual(stats);
    expect(result.results).toBeUndefined();
    expect(result.cleared).toBeUndefined();
    expect(getCacheStats).toHaveBeenCalledOnce();
  });

  it('returns cleared count when clear=true', async () => {
    vi.mocked(clearCacheEntries).mockReturnValue(3);

    const result = await handleCache({ clear: true, url_pattern: '*example.com*' });

    expect(result.cleared).toBe(3);
    expect(result.results).toBeUndefined();
    expect(clearCacheEntries).toHaveBeenCalledWith({
      query: undefined,
      urlPattern: '*example.com*',
      since: undefined,
    });
  });

  it('returns search results for query', async () => {
    const cached = [makeCachedContent()];
    vi.mocked(searchCacheFiltered).mockReturnValue(cached);

    const result = await handleCache({ query: 'example' });

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

  it('passes all filters to searchCacheFiltered', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    await handleCache({ query: 'test', url_pattern: '*docs*', since: '2026-04-01' });

    expect(searchCacheFiltered).toHaveBeenCalledWith({
      query: 'test',
      urlPattern: '*docs*',
      since: '2026-04-01',
    });
  });

  it('returns empty results for no matches', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    const result = await handleCache({ query: 'nonexistent' });

    expect(result.results).toEqual([]);
  });

  it('returns error on exception', async () => {
    vi.mocked(searchCacheFiltered).mockImplementation(() => {
      throw new Error('DB error');
    });

    const result = await handleCache({ query: 'test' });

    expect(result.error).toBe('DB error');
  });

  it('rejects clear without filters', async () => {
    const result = await handleCache({ clear: true });

    expect(result.error).toBe('clear requires at least one filter (query, url_pattern, or since)');
    expect(result.cleared).toBeUndefined();
    expect(clearCacheEntries).not.toHaveBeenCalled();
  });

  it('clears with combined query + url_pattern', async () => {
    vi.mocked(clearCacheEntries).mockReturnValue(2);

    const result = await handleCache({ clear: true, query: 'test', url_pattern: '*example.com*' });

    expect(result.cleared).toBe(2);
    expect(clearCacheEntries).toHaveBeenCalledWith({
      query: 'test',
      urlPattern: '*example.com*',
      since: undefined,
    });
  });

  it('stats takes priority over clear', async () => {
    const stats: CacheStats = { total_urls: 1, total_size_mb: 0.01, oldest: '', newest: '' };
    vi.mocked(getCacheStats).mockReturnValue(stats);

    const result = await handleCache({ stats: true, clear: true });

    expect(result.stats).toBeDefined();
    expect(result.cleared).toBeUndefined();
    expect(clearCacheEntries).not.toHaveBeenCalled();
  });
});

describe('handleCache --- check_changes mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(detectChange).mockReturnValue({ changed: false });
    vi.mocked(extractContent).mockResolvedValue({
      title: 'Test',
      markdown: 'new content',
      metadata: {},
      links: [],
      images: [],
    });
  });

  it('returns changes array when check_changes is true', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([
      {
        id: 1,
        url: 'https://example.com/a',
        normalizedUrl: 'https://example.com/a',
        title: 'Page A',
        markdown: 'content A',
        rawHtml: '',
        metadata: '{}',
        links: '[]',
        images: '[]',
        fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const,
        contentHash: 'abc123',
        fetchedAt: '2026-04-14T00:00:00',
        expiresAt: null,
      },
    ]);

    vi.mocked(detectChange).mockReturnValue({ changed: false });
    const router = mockRouter();

    const result = await handleCache({
      check_changes: true,
      url_pattern: '*example.com*',
    }, router);

    expect(result.changes).toBeDefined();
    expect(result.changes).toHaveLength(1);
    expect(result.changes![0].url).toBe('https://example.com/a');
    expect(result.changes![0].changed).toBe(false);
    expect(router.fetch).toHaveBeenCalledWith('https://example.com/a', { renderJs: 'auto' });
  });

  it('reports changed=true for URLs with different content', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([
      {
        id: 1,
        url: 'https://example.com/b',
        normalizedUrl: 'https://example.com/b',
        title: 'Page B',
        markdown: 'old content',
        rawHtml: '',
        metadata: '{}',
        links: '[]',
        images: '[]',
        fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const,
        contentHash: 'old-hash',
        fetchedAt: '2026-04-14T00:00:00',
        expiresAt: null,
      },
    ]);

    vi.mocked(detectChange).mockReturnValue({
      changed: true,
      previousHash: 'old-hash',
      diffSummary: '3 lines added, 1 line removed, 0 lines modified',
    });
    const router = mockRouter();

    const result = await handleCache({
      check_changes: true,
      url_pattern: '*example.com*',
    }, router);

    expect(result.changes![0].changed).toBe(true);
    expect(result.changes![0].previous_hash).toBe('old-hash');
    expect(result.changes![0].diff_summary).toContain('3 lines added');
  });

  it('handles multiple cached URLs', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([
      {
        id: 1, url: 'https://a.com', normalizedUrl: 'https://a.com',
        title: 'A', markdown: 'a', rawHtml: '', metadata: '{}',
        links: '[]', images: '[]', fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const, contentHash: 'ha',
        fetchedAt: '2026-04-14T00:00:00', expiresAt: null,
      },
      {
        id: 2, url: 'https://b.com', normalizedUrl: 'https://b.com',
        title: 'B', markdown: 'b', rawHtml: '', metadata: '{}',
        links: '[]', images: '[]', fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const, contentHash: 'hb',
        fetchedAt: '2026-04-14T00:00:00', expiresAt: null,
      },
    ]);

    vi.mocked(detectChange)
      .mockReturnValueOnce({ changed: false })
      .mockReturnValueOnce({ changed: true, previousHash: 'hb', diffSummary: '1 line added' });

    const result = await handleCache({ check_changes: true }, mockRouter());

    expect(result.changes).toHaveLength(2);
    expect(result.changes![0].changed).toBe(false);
    expect(result.changes![1].changed).toBe(true);
  });

  it('returns empty changes array when no cached entries match', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    const result = await handleCache({ check_changes: true, url_pattern: '*nonexistent*' }, mockRouter());

    expect(result.changes).toBeDefined();
    expect(result.changes).toHaveLength(0);
  });

  it('uses query and url_pattern to scope entries', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    await handleCache({
      check_changes: true,
      query: 'react',
      url_pattern: '*docs*',
    }, mockRouter());

    expect(vi.mocked(searchCacheFiltered)).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'react',
        urlPattern: '*docs*',
      }),
    );
  });

  it('handles fetch error for individual URLs', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([
      {
        id: 1, url: 'https://error.com', normalizedUrl: 'https://error.com',
        title: 'Error Page', markdown: 'content', rawHtml: '', metadata: '{}',
        links: '[]', images: '[]', fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const, contentHash: 'h',
        fetchedAt: '2026-04-14T00:00:00', expiresAt: null,
      },
    ]);

    const router = { fetch: vi.fn().mockRejectedValue(new Error('Network error')) } as any;

    const result = await handleCache({ check_changes: true }, router);

    expect(result.changes).toHaveLength(1);
    expect(result.changes![0].error).toContain('Network error');
    expect(result.changes![0].changed).toBe(false);
  });

  it('check_changes takes priority over stats', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    const result = await handleCache({ check_changes: true, stats: true }, mockRouter());

    expect(result.changes).toBeDefined();
    expect(result.stats).toBeUndefined();
  });

  it('check_changes takes priority over clear', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([]);

    const result = await handleCache({ check_changes: true, clear: true }, mockRouter());

    expect(result.changes).toBeDefined();
    expect(result.cleared).toBeUndefined();
  });

  it('includes current_hash in change report', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([
      {
        id: 1, url: 'https://example.com/c', normalizedUrl: 'https://example.com/c',
        title: 'C', markdown: 'content', rawHtml: '', metadata: '{}',
        links: '[]', images: '[]', fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const, contentHash: 'current-h',
        fetchedAt: '2026-04-14T00:00:00', expiresAt: null,
      },
    ]);

    vi.mocked(detectChange).mockReturnValue({ changed: false });

    const result = await handleCache({ check_changes: true }, mockRouter());

    expect(result.changes![0].current_hash).toBe('current-h');
  });

  it('reports error when no router provided', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([
      {
        id: 1, url: 'https://example.com', normalizedUrl: 'https://example.com',
        title: 'X', markdown: 'x', rawHtml: '', metadata: '{}',
        links: '[]', images: '[]', fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const, contentHash: 'h',
        fetchedAt: '2026-04-14T00:00:00', expiresAt: null,
      },
    ]);

    const result = await handleCache({ check_changes: true });

    expect(result.changes![0].error).toBe('no router available for re-fetch');
    expect(result.changes![0].changed).toBe(false);
  });

  it('passes re-fetched content to detectChange', async () => {
    vi.mocked(searchCacheFiltered).mockReturnValue([
      {
        id: 1, url: 'https://example.com', normalizedUrl: 'https://example.com',
        title: 'X', markdown: 'old', rawHtml: '', metadata: '{}',
        links: '[]', images: '[]', fetchMethod: 'http' as const,
        extractorUsed: 'defuddle' as const, contentHash: 'h',
        fetchedAt: '2026-04-14T00:00:00', expiresAt: null,
      },
    ]);

    vi.mocked(extractContent).mockResolvedValue({
      title: 'X',
      markdown: 'freshly fetched content',
      metadata: {},
      links: [],
      images: [],
    });

    const result = await handleCache({ check_changes: true }, mockRouter());

    expect(vi.mocked(detectChange)).toHaveBeenCalledWith('https://example.com', 'freshly fetched content');
  });
});
