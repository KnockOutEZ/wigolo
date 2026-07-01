import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchInput, RawFetchResult, CachedContent, ExtractionResult } from '../../../src/types.js';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn(),
}));

const extractMock = vi.fn();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
}));

vi.mock('../../../src/extraction/markdown.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/extraction/markdown.js')>(
    '../../../src/extraction/markdown.js',
  );
  return {
    ...actual,
    extractSection: vi.fn(),
  };
});

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

import { handleFetch } from '../../../src/tools/fetch.js';
import { getCachedContent, cacheContent, isCacheUsable } from '../../../src/cache/store.js';
import { extractSection } from '../../../src/extraction/markdown.js';
import { detectChange } from '../../../src/cache/change-detector.js';
import type { ChangeResult } from '../../../src/cache/change-detector.js';

function mockRouter(result?: Partial<RawFetchResult>) {
  const defaults: RawFetchResult = {
    url: 'https://example.com',
    finalUrl: 'https://example.com',
    html: '<html><body><h1>Hello</h1></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  return {
    fetch: vi.fn().mockResolvedValue({ ...defaults, ...result }),
    getDomainStats: vi.fn(),
  };
}

function makeCached(overrides: Partial<CachedContent> = {}): CachedContent {
  return {
    id: 1,
    url: 'https://example.com',
    normalizedUrl: 'https://example.com',
    title: 'Cached Page',
    markdown: '# Cached\n\nCached content here.',
    rawHtml: '<html></html>',
    metadata: JSON.stringify({ description: 'cached' }),
    links: JSON.stringify(['https://example.com/link']),
    images: JSON.stringify(['https://example.com/img.png']),
    fetchMethod: 'http',
    extractorUsed: 'defuddle',
    contentHash: 'abc123',
    fetchedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    ...overrides,
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Test Page',
    markdown: '# Hello\n\nContent from extraction.',
    metadata: { description: 'test' },
    links: ['https://example.com/link'],
    images: ['https://example.com/img.png'],
    extractor: 'defuddle',
    ...overrides,
  };
}

// Precise URL validation for fetch. Localhost URLs with a
// VALID port are accepted (docs promise local dev servers work); invalid
// ports get a clear "invalid port" message instead of a vague TypeError.
describe('handleFetch URL validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
  });

  it('rejects localhost URL with out-of-range port with an "invalid port" message', async () => {
    const router = mockRouter();
    const r = await handleFetch({ url: 'http://localhost:99999/x' }, router);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('invalid_url');
    expect(r.error_reason).toMatch(/invalid port/i);
    expect(r.error_reason).not.toMatch(/localhost not supported/i);
  });

  it('rejects localhost URL with non-numeric port with an "invalid port" message', async () => {
    const router = mockRouter();
    const r = await handleFetch({ url: 'http://localhost:abc/x' }, router);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('invalid_url');
    expect(r.error_reason).toMatch(/invalid port/i);
  });

  it('accepts localhost URL with a valid port (the docs promise this works)', async () => {
    const extraction = makeExtraction();
    extractMock.mockResolvedValue(extraction);
    const router = mockRouter({ url: 'http://localhost:3000', finalUrl: 'http://localhost:3000' });

    const r = await handleFetch({ url: 'http://localhost:3000/x' }, router);
    // The router is invoked — the validator did not pre-reject.
    expect(router.fetch).toHaveBeenCalled();
    expect(r.ok).toBe(true);
  });
});

describe('handleFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
  });

  it('returns markdown content for a valid URL', async () => {
    const extraction = makeExtraction();
    extractMock.mockResolvedValue(extraction);

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', include_full_markdown: true };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.url).toBe('https://example.com');
    expect(result.title).toBe('Test Page');
    expect(result.markdown).toContain('Hello');
    expect(result.cached).toBe(false);
    expect(result.error).toBeUndefined();
    expect(router.fetch).toHaveBeenCalledOnce();
  });

  it('returns error response for empty URL', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue(new Error('Invalid URL'));

    const input: FetchInput = { url: '' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeDefined();
  });

  it('returns cached: true when content served from cache', async () => {
    const knownFetchedAt = '2026-04-15T10:30:00.000Z';
    const cached = makeCached({ fetchedAt: knownFetchedAt });
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', include_full_markdown: true };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(true);
    expect(result.title).toBe('Cached Page');
    expect(result.markdown).toContain('Cached');
    expect(router.fetch).not.toHaveBeenCalled();
    expect(result.cached_at).toBeDefined();
    expect(typeof result.cached_at).toBe('string');
    expect(result.cached_at).toBe(knownFetchedAt);
  });

  it('returns cached: false when freshly fetched', async () => {
    extractMock.mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(false);
    expect(router.fetch).toHaveBeenCalledOnce();
  });

  it('passes section parameter through to extraction when fetching fresh', async () => {
    extractMock.mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', section: 'Installation' };

    await handleFetch(input, router);

    expect(extractMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ section: 'Installation' }),
    );
  });

  it('applies section extraction on cached content', async () => {
    const cached = makeCached({ markdown: '# Intro\n\nIntro text\n\n# Install\n\nInstall steps' });
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
    vi.mocked(extractSection).mockReturnValue({ content: '# Install\n\nInstall steps', matched: true });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', section: 'Install', include_full_markdown: true };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(vi.mocked(extractSection)).toHaveBeenCalledWith(cached.markdown, 'Install', undefined);
    expect(result.markdown).toBe('# Install\n\nInstall steps');
    expect(result.metadata.section_matched).toBe(true);
  });

  it('respects max_chars on fresh content', async () => {
    extractMock.mockResolvedValue(
      makeExtraction({ markdown: 'A'.repeat(500) }),
    );

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', max_chars: 100 };

    await handleFetch(input, router);

    expect(extractMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ maxChars: 100 }),
    );
  });

  it('respects max_chars on cached content', async () => {
    const cached = makeCached({ markdown: 'B'.repeat(500) });
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', max_chars: 50 };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.markdown.length).toBeLessThanOrEqual(50);
  });

  it('returns structured error response on fetch failure (never throws)', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue(new Error('Network timeout'));

    const input: FetchInput = { url: 'https://example.com/broken' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBe('fetch_failed');
    expect(result.error_reason).toBe('Network timeout');
    expect(result.stage).toBe('fetch');
  });

  it('returns structured error for non-Error throws', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue('string error');

    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBe('fetch_failed');
    expect(result.error_reason).toBe('string error');
  });

  it('fetches fresh when cache is expired', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: false, stale: false });
    extractMock.mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(false);
    expect(router.fetch).toHaveBeenCalledOnce();
  });

  it('calls cacheContent after fresh fetch', async () => {
    extractMock.mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    await handleFetch(input, router);

    expect(vi.mocked(cacheContent)).toHaveBeenCalledOnce();
  });

  it('caps links and images when max_content_chars is tight', async () => {
    const manyLinks = Array.from({ length: 500 }, (_, i) => `https://example.com/link-${i}`);
    const manyImages = Array.from({ length: 500 }, (_, i) => `https://example.com/img-${i}.png`);
    extractMock.mockResolvedValue(makeExtraction({
      links: manyLinks,
      images: manyImages,
      markdown: 'long markdown body '.repeat(2000),
    }));

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', max_content_chars: 1500 };

    const __r_result = await handleFetch(input, router);
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.links.length).toBeLessThanOrEqual(50);
    expect(result.images.length).toBeLessThanOrEqual(50);
  });

  it('also caps links/images on cached path when max_content_chars is set', async () => {
    const manyLinks = Array.from({ length: 500 }, (_, i) => `https://example.com/link-${i}`);
    const cached = makeCached({
      links: JSON.stringify(manyLinks),
      images: JSON.stringify(manyLinks),
    });
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', max_content_chars: 1500 };

    const __r_result = await handleFetch(input, router);
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.links.length).toBeLessThanOrEqual(50);
    expect(result.images.length).toBeLessThanOrEqual(50);
  });

  it('leaves links/images alone when max_content_chars is not set', async () => {
    const manyLinks = Array.from({ length: 200 }, (_, i) => `https://example.com/link-${i}`);
    extractMock.mockResolvedValue(makeExtraction({
      links: manyLinks,
      images: manyLinks,
    }));

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.links.length).toBe(200);
    expect(result.images.length).toBe(200);
  });
});

describe('handleFetch --- force_refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
  });

  it('bypasses cache when force_refresh is true', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
    extractMock.mockResolvedValue(makeExtraction({ markdown: 'fresh content' }));

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', force_refresh: true, include_full_markdown: true };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(router.fetch).toHaveBeenCalledOnce();
    expect(result.cached).toBe(false);
    expect(result.markdown).toContain('fresh content');
  });

  it('still caches the fresh result after force_refresh', async () => {
    extractMock.mockResolvedValue(makeExtraction({ markdown: 'newly fetched' }));

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', force_refresh: true };

    await handleFetch(input, router);

    expect(vi.mocked(cacheContent)).toHaveBeenCalledOnce();
  });

  it('uses cache when force_refresh is false', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', force_refresh: false };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(router.fetch).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
  });

  it('uses cache when force_refresh is undefined', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(router.fetch).not.toHaveBeenCalled();
    expect(result.cached).toBe(true);
  });
});

describe('handleFetch --- actions support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
  });

  it('passes actions to router.fetch', async () => {
    extractMock.mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const actions = [
      { type: 'click' as const, selector: '.accept-cookies' },
      { type: 'wait' as const, ms: 300 },
    ];
    const input: FetchInput = { url: 'https://example.com', actions };

    await handleFetch(input, router);

    expect(router.fetch).toHaveBeenCalledWith('https://example.com', expect.objectContaining({ actions }));
  });

  it('returns action_results when present in raw result', async () => {
    const actionResults = [
      { action_index: 0, type: 'click' as const, success: true },
      { action_index: 1, type: 'wait' as const, success: true },
    ];
    extractMock.mockResolvedValue(makeExtraction());
    const router = mockRouter({ actionResults });
    const input: FetchInput = {
      url: 'https://example.com',
      actions: [{ type: 'click', selector: '.btn' }, { type: 'wait', ms: 100 }],
    };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.action_results).toBeDefined();
    expect(result.action_results).toHaveLength(2);
    expect(result.action_results![0].success).toBe(true);
  });

  it('does not include action_results when no actions provided', async () => {
    extractMock.mockResolvedValue(makeExtraction());
    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.action_results).toBeUndefined();
  });

  it('skips cache when actions are present (always fetches fresh)', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
    extractMock.mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = {
      url: 'https://example.com',
      actions: [{ type: 'click', selector: '.btn' }],
    };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(false);
    expect(router.fetch).toHaveBeenCalledOnce();
  });

  it('handles error during actions gracefully', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue(new Error('Action chain failed'));

    const input: FetchInput = {
      url: 'https://example.com',
      actions: [{ type: 'click', selector: '.nonexistent' }],
    };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error_reason).toBe('Action chain failed');
    expect(result.error).toBe('fetch_failed');
  });

  it('includes action screenshots in results', async () => {
    const actionResults = [
      { action_index: 0, type: 'screenshot' as const, success: true, screenshot: 'base64data' },
    ];
    extractMock.mockResolvedValue(makeExtraction());
    const router = mockRouter({ actionResults });
    const input: FetchInput = {
      url: 'https://example.com',
      actions: [{ type: 'screenshot' }],
    };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.action_results).toBeDefined();
    expect(result.action_results![0].screenshot).toBe('base64data');
  });

  it('handles empty actions array (no-op)', async () => {
    extractMock.mockResolvedValue(makeExtraction());
    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', actions: [] };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.action_results).toBeUndefined();
  });
});

describe('handleFetch --- change detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
    vi.mocked(detectChange).mockReturnValue({ changed: false });
  });

  it('calls detectChange after extraction for fresh fetch', async () => {
    const extraction = makeExtraction({ markdown: '# New Content' });
    extractMock.mockResolvedValue(extraction);

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com/page' };

    await handleFetch(input, router);

    expect(vi.mocked(detectChange)).toHaveBeenCalledWith(
      expect.any(String),
      '# New Content',
      // detectChange now receives upstream status code so it
      // can flag 200→404 status flips as changes alongside body-hash diffs.
      expect.any(Number),
    );
  });

  it('includes changed=true in response when content changed', async () => {
    extractMock.mockResolvedValue(makeExtraction());
    vi.mocked(detectChange).mockReturnValue({
      changed: true,
      previousHash: 'abc123def456',
      diffSummary: '2 lines added, 1 line removed, 0 lines modified',
    });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com/page' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.changed).toBe(true);
    expect(result.previous_hash).toBe('abc123def456');
    expect(result.diff_summary).toContain('2 lines added');
  });

  it('does not include change fields when content is unchanged', async () => {
    extractMock.mockResolvedValue(makeExtraction());
    vi.mocked(detectChange).mockReturnValue({ changed: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com/page' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.changed).toBeUndefined();
    expect(result.previous_hash).toBeUndefined();
    expect(result.diff_summary).toBeUndefined();
  });

  it('does not call detectChange when serving from cache', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(true);
    expect(vi.mocked(detectChange)).not.toHaveBeenCalled();
  });

  it('handles detectChange throwing gracefully', async () => {
    extractMock.mockResolvedValue(makeExtraction());
    vi.mocked(detectChange).mockImplementation(() => { throw new Error('DB error'); });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.error).toBeUndefined();
    expect(result.changed).toBeUndefined();
    expect(result.markdown).toBeDefined();
  });

  it('includes change detection fields alongside existing output fields', async () => {
    extractMock.mockResolvedValue(makeExtraction({
      title: 'My Page',
      markdown: '# Updated',
    }));
    vi.mocked(detectChange).mockReturnValue({
      changed: true,
      previousHash: 'prev123',
      diffSummary: '1 line modified',
    });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', include_full_markdown: true };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.title).toBe('My Page');
    expect(result.markdown).toBe('# Updated');
    expect(result.cached).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.previous_hash).toBe('prev123');
    expect(result.diff_summary).toBe('1 line modified');
  });

  it('detects change after cache expiry triggers re-fetch', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: false, stale: false });
    extractMock.mockResolvedValue(makeExtraction({ markdown: 'new content' }));
    vi.mocked(detectChange).mockReturnValue({
      changed: true,
      previousHash: 'old-hash',
      diffSummary: '5 lines added, 3 lines removed, 0 lines modified',
    });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(false);
    expect(result.changed).toBe(true);
    expect(vi.mocked(detectChange)).toHaveBeenCalled();
  });

  it('returns changed=false for first-time fetch (no prior cache)', async () => {
    extractMock.mockResolvedValue(makeExtraction());
    vi.mocked(detectChange).mockReturnValue({ changed: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://brand-new-site.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.changed).toBeUndefined();
  });
});

describe('handleFetch --- evidence shape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });
  });

  const longMarkdown =
    '# Hello World\n\n' +
    'TypeScript is a strongly typed programming language that builds on JavaScript, ' +
    'giving you better tooling at any scale. It compiles to plain JavaScript and runs ' +
    'in any browser, in Node.js, or wherever JavaScript runs at all.\n\n' +
    'TypeScript adds static typing to JavaScript so you can catch errors during build.';

  it('default response includes evidence with citation_id and source_span', async () => {
    extractMock.mockResolvedValue(makeExtraction({ markdown: longMarkdown }));
    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.evidence).toBeDefined();
    expect(result.evidence!.length).toBeGreaterThan(0);
    const ev = result.evidence![0];
    expect(ev.excerpt.length).toBeGreaterThan(0);
    expect(ev.citation_id).toMatch(/^[a-f0-9]{12}$/);
    expect(ev.source_span.end).toBeGreaterThan(ev.source_span.start);
  });

  it('default response preserves full markdown body alongside evidence', async () => {
    extractMock.mockResolvedValue(makeExtraction({ markdown: longMarkdown }));
    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.markdown).toBe(longMarkdown);
    expect(result.evidence).toBeDefined();
  });

  it('include_full_markdown=false strips the full markdown body', async () => {
    extractMock.mockResolvedValue(makeExtraction({ markdown: longMarkdown }));
    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', include_full_markdown: false };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.markdown).toBe('');
  });

  it('cached response emits evidence and preserves markdown by default', async () => {
    const cached = makeCached({ markdown: longMarkdown });
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const __r_result = await handleFetch(input, router);;
    const result = __r_result.ok ? __r_result.data : ({ ...__r_result } as any);

    expect(result.cached).toBe(true);
    expect(result.markdown).toBe(longMarkdown);
    expect(result.evidence).toBeDefined();
    expect(result.evidence![0].citation_id).toMatch(/^[a-f0-9]{12}$/);
  });
});
