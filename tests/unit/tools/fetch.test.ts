import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FetchInput, RawFetchResult, CachedContent, ExtractionResult } from '../../../src/types.js';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn(),
  cacheContent: vi.fn(),
  isExpired: vi.fn(),
}));

vi.mock('../../../src/extraction/pipeline.js', () => ({
  extractContent: vi.fn(),
}));

vi.mock('../../../src/extraction/markdown.js', () => ({
  extractSection: vi.fn(),
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
import { getCachedContent, cacheContent, isExpired } from '../../../src/cache/store.js';
import { extractContent } from '../../../src/extraction/pipeline.js';
import { extractSection } from '../../../src/extraction/markdown.js';

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

describe('handleFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
  });

  it('returns markdown content for a valid URL', async () => {
    const extraction = makeExtraction();
    vi.mocked(extractContent).mockResolvedValue(extraction);

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const result = await handleFetch(input, router);

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

    const result = await handleFetch(input, router);

    expect(result.error).toBeDefined();
    expect(result.markdown).toBe('');
    expect(result.cached).toBe(false);
  });

  it('returns cached: true when content served from cache', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isExpired).mockReturnValue(false);

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const result = await handleFetch(input, router);

    expect(result.cached).toBe(true);
    expect(result.title).toBe('Cached Page');
    expect(result.markdown).toContain('Cached');
    expect(router.fetch).not.toHaveBeenCalled();
  });

  it('returns cached: false when freshly fetched', async () => {
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const result = await handleFetch(input, router);

    expect(result.cached).toBe(false);
    expect(router.fetch).toHaveBeenCalledOnce();
  });

  it('passes section parameter through to extraction when fetching fresh', async () => {
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', section: 'Installation' };

    await handleFetch(input, router);

    expect(vi.mocked(extractContent)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ section: 'Installation' }),
    );
  });

  it('applies section extraction on cached content', async () => {
    const cached = makeCached({ markdown: '# Intro\n\nIntro text\n\n# Install\n\nInstall steps' });
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isExpired).mockReturnValue(false);
    vi.mocked(extractSection).mockReturnValue({ content: '# Install\n\nInstall steps', matched: true });

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', section: 'Install' };

    const result = await handleFetch(input, router);

    expect(vi.mocked(extractSection)).toHaveBeenCalledWith(cached.markdown, 'Install', undefined);
    expect(result.markdown).toBe('# Install\n\nInstall steps');
    expect(result.metadata.section_matched).toBe(true);
  });

  it('respects max_chars on fresh content', async () => {
    vi.mocked(extractContent).mockResolvedValue(
      makeExtraction({ markdown: 'A'.repeat(500) }),
    );

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', max_chars: 100 };

    await handleFetch(input, router);

    expect(vi.mocked(extractContent)).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ maxChars: 100 }),
    );
  });

  it('respects max_chars on cached content', async () => {
    const cached = makeCached({ markdown: 'B'.repeat(500) });
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isExpired).mockReturnValue(false);

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', max_chars: 50 };

    const result = await handleFetch(input, router);

    expect(result.markdown.length).toBeLessThanOrEqual(50);
  });

  it('returns structured error response on fetch failure (never throws)', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue(new Error('Network timeout'));

    const input: FetchInput = { url: 'https://example.com/broken' };

    const result = await handleFetch(input, router);

    expect(result.error).toBe('Network timeout');
    expect(result.url).toBe('https://example.com/broken');
    expect(result.markdown).toBe('');
    expect(result.cached).toBe(false);
    expect(result.links).toEqual([]);
    expect(result.images).toEqual([]);
  });

  it('returns structured error for non-Error throws', async () => {
    const router = mockRouter();
    router.fetch.mockRejectedValue('string error');

    const input: FetchInput = { url: 'https://example.com' };

    const result = await handleFetch(input, router);

    expect(result.error).toBe('string error');
    expect(result.cached).toBe(false);
  });

  it('fetches fresh when cache is expired', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isExpired).mockReturnValue(true);
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const result = await handleFetch(input, router);

    expect(result.cached).toBe(false);
    expect(router.fetch).toHaveBeenCalledOnce();
  });

  it('calls cacheContent after fresh fetch', async () => {
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    await handleFetch(input, router);

    expect(vi.mocked(cacheContent)).toHaveBeenCalledOnce();
  });
});

describe('handleFetch --- actions support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedContent).mockReturnValue(null);
    vi.mocked(isExpired).mockReturnValue(false);
  });

  it('passes actions to router.fetch', async () => {
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());

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
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());
    const router = mockRouter({ actionResults });
    const input: FetchInput = {
      url: 'https://example.com',
      actions: [{ type: 'click', selector: '.btn' }, { type: 'wait', ms: 100 }],
    };

    const result = await handleFetch(input, router);

    expect(result.action_results).toBeDefined();
    expect(result.action_results).toHaveLength(2);
    expect(result.action_results![0].success).toBe(true);
  });

  it('does not include action_results when no actions provided', async () => {
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());
    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com' };

    const result = await handleFetch(input, router);

    expect(result.action_results).toBeUndefined();
  });

  it('skips cache when actions are present (always fetches fresh)', async () => {
    const cached = makeCached();
    vi.mocked(getCachedContent).mockReturnValue(cached);
    vi.mocked(isExpired).mockReturnValue(false);
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());

    const router = mockRouter();
    const input: FetchInput = {
      url: 'https://example.com',
      actions: [{ type: 'click', selector: '.btn' }],
    };

    const result = await handleFetch(input, router);

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

    const result = await handleFetch(input, router);

    expect(result.error).toBe('Action chain failed');
    expect(result.cached).toBe(false);
  });

  it('includes action screenshots in results', async () => {
    const actionResults = [
      { action_index: 0, type: 'screenshot' as const, success: true, screenshot: 'base64data' },
    ];
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());
    const router = mockRouter({ actionResults });
    const input: FetchInput = {
      url: 'https://example.com',
      actions: [{ type: 'screenshot' }],
    };

    const result = await handleFetch(input, router);

    expect(result.action_results).toBeDefined();
    expect(result.action_results![0].screenshot).toBe('base64data');
  });

  it('handles empty actions array (no-op)', async () => {
    vi.mocked(extractContent).mockResolvedValue(makeExtraction());
    const router = mockRouter();
    const input: FetchInput = { url: 'https://example.com', actions: [] };

    const result = await handleFetch(input, router);

    expect(result.error).toBeUndefined();
    expect(result.action_results).toBeUndefined();
  });
});
