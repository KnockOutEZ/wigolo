import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawFetchResult } from '../../../src/types.js';

vi.mock('../../../src/extraction/extract.js', () => ({
  extractMetadata: vi.fn(),
  extractSelector: vi.fn(),
  extractTables: vi.fn(),
}));

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(),
  isExpired: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { handleExtract } from '../../../src/tools/extract.js';
import { extractMetadata, extractSelector, extractTables } from '../../../src/extraction/extract.js';
import { getCachedContent, isExpired } from '../../../src/cache/store.js';

function mockRouter(html = '<html><body>Hello</body></html>') {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html,
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    } satisfies RawFetchResult),
    getDomainStats: vi.fn(),
  };
}

describe('handleExtract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
  });

  it('returns error when neither url nor html provided', async () => {
    const result = await handleExtract({}, mockRouter());
    expect(result.error).toBe('Either url or html must be provided');
  });

  it('returns error when mode=selector but no css_selector', async () => {
    const result = await handleExtract(
      { html: '<html></html>', mode: 'selector' },
      mockRouter(),
    );
    expect(result.error).toBe('css_selector is required when mode is "selector"');
  });

  it('uses metadata mode by default', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Test' });

    const result = await handleExtract(
      { html: '<html><head><title>Test</title></head></html>' },
      mockRouter(),
    );

    expect(result.mode).toBe('metadata');
    expect(extractMetadata).toHaveBeenCalledOnce();
  });

  it('fetches URL when url provided', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Fetched' });
    const router = mockRouter();

    const result = await handleExtract({ url: 'https://example.com' }, router);

    expect(router.fetch).toHaveBeenCalledWith('https://example.com', expect.any(Object));
    expect(result.source_url).toBe('https://example.com');
  });

  it('uses provided html when no url', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Direct' });
    const router = mockRouter();

    const result = await handleExtract(
      { html: '<html><head><title>Direct</title></head></html>' },
      router,
    );

    expect(router.fetch).not.toHaveBeenCalled();
    expect(result.source_url).toBeUndefined();
  });

  it('prefers url over html when both provided', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'From URL' });
    const router = mockRouter();

    await handleExtract(
      { url: 'https://example.com', html: '<html>ignored</html>' },
      router,
    );

    expect(router.fetch).toHaveBeenCalled();
  });

  it('uses cached HTML when available for URL', async () => {
    vi.mocked(getCachedContent).mockReturnValue({
      id: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: 'Cached',
      markdown: '',
      rawHtml: '<html><head><title>Cached</title></head></html>',
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'abc',
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });

    vi.mocked(extractMetadata).mockReturnValue({ title: 'Cached' });
    const router = mockRouter();

    await handleExtract({ url: 'https://example.com' }, router);

    expect(router.fetch).not.toHaveBeenCalled();
    expect(extractMetadata).toHaveBeenCalledWith(
      '<html><head><title>Cached</title></head></html>',
    );
  });

  it('dispatches to extractSelector for mode=selector', async () => {
    vi.mocked(extractSelector).mockReturnValue('matched text');

    const result = await handleExtract(
      { html: '<html><body><p>test</p></body></html>', mode: 'selector', css_selector: 'p' },
      mockRouter(),
    );

    expect(result.mode).toBe('selector');
    expect(extractSelector).toHaveBeenCalledWith(expect.any(String), 'p', false);
    expect(result.data).toBe('matched text');
  });

  it('passes multiple=true to extractSelector', async () => {
    vi.mocked(extractSelector).mockReturnValue(['a', 'b']);

    const result = await handleExtract(
      { html: '<html></html>', mode: 'selector', css_selector: 'p', multiple: true },
      mockRouter(),
    );

    expect(extractSelector).toHaveBeenCalledWith(expect.any(String), 'p', true);
    expect(result.data).toEqual(['a', 'b']);
  });

  it('dispatches to extractTables for mode=tables', async () => {
    vi.mocked(extractTables).mockReturnValue([{ headers: ['A'], rows: [{ A: '1' }] }]);

    const result = await handleExtract(
      { html: '<html><body><table></table></body></html>', mode: 'tables' },
      mockRouter(),
    );

    expect(result.mode).toBe('tables');
    expect(extractTables).toHaveBeenCalledOnce();
  });

  it('accepts schema parameter without error (v2 forward-compat)', async () => {
    vi.mocked(extractMetadata).mockReturnValue({ title: 'Test' });

    const result = await handleExtract(
      { html: '<html></html>', mode: 'metadata', schema: { type: 'object' } },
      mockRouter(),
    );

    expect(result.error).toBeUndefined();
    expect(result.mode).toBe('metadata');
  });

  it('returns structured error on fetch failure', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue(new Error('Network timeout'));

    const result = await handleExtract({ url: 'https://example.com/broken' }, router);

    expect(result.error).toBe('Network timeout');
    expect(result.mode).toBe('metadata');
  });
});
