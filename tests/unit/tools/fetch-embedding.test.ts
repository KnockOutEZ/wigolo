import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/fetch/router.js', () => ({}));

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn().mockResolvedValue({
    title: 'Test',
    markdown: 'Test content for embedding hook verification',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle' as const,
  }),
}));

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isExpired: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/cache/change-detector.js', () => ({
  detectChange: vi.fn().mockReturnValue({ changed: false }),
}));

vi.mock('../../../src/embedding/embed.js', () => ({
  getEmbeddingService: vi.fn().mockReturnValue({
    embedAsync: vi.fn(),
    isAvailable: vi.fn().mockReturnValue(true),
  }),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import { getEmbeddingService } from '../../../src/embedding/embed.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

describe('handleFetch embedding hook', () => {
  const mockRouter = {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html><body><h1>Test</h1><p>Content</p></body></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEmbeddingService).mockReturnValue({
      embedAsync: vi.fn(),
      isAvailable: vi.fn().mockReturnValue(true),
    } as any);
  });

  it('calls embedAsync after successful fetch', async () => {
    const embeddingService = getEmbeddingService();

    await handleFetch({ url: 'https://example.com' }, mockRouter);

    expect(embeddingService.embedAsync).toHaveBeenCalledWith(
      'https://example.com',
      expect.stringContaining('Test content'),
    );
  });

  it('does not call embedAsync when embedding service is not available', async () => {
    const service = getEmbeddingService();
    vi.mocked(service.isAvailable).mockReturnValue(false);

    await handleFetch({ url: 'https://example.com' }, mockRouter);

    expect(service.embedAsync).not.toHaveBeenCalled();
  });

  it('does not call embedAsync on fetch error', async () => {
    const failRouter = {
      fetch: vi.fn().mockRejectedValue(new Error('network error')),
    } as unknown as SmartRouter;

    const service = getEmbeddingService();

    await handleFetch({ url: 'https://error.com' }, failRouter);

    expect(service.embedAsync).not.toHaveBeenCalled();
  });

  it('does not block fetch response for embedding', async () => {
    const service = getEmbeddingService();
    vi.mocked(service.embedAsync).mockImplementation(() => {
      setTimeout(() => {}, 1000);
    });

    const start = Date.now();
    await handleFetch({ url: 'https://example.com' }, mockRouter);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
    expect(service.embedAsync).toHaveBeenCalled();
  });

  it('does not call embedAsync for cached responses', async () => {
    const { getCachedContent } = await import('../../../src/cache/store.js');
    vi.mocked(getCachedContent).mockReturnValue({
      id: 1,
      url: 'https://cached.com',
      normalizedUrl: 'https://cached.com',
      title: 'Cached',
      markdown: 'Cached content',
      rawHtml: '<html>',
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'abc',
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const service = getEmbeddingService();

    await handleFetch({ url: 'https://cached.com' }, mockRouter);

    expect(service.embedAsync).not.toHaveBeenCalled();
  });
});
