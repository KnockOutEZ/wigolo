import { describe, it, expect, vi } from 'vitest';
import type { FetchInput, RawFetchResult, ExtractionResult } from '../../../src/types.js';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn().mockReturnValue({ usable: false, stale: false }),
}));

const extractMock = vi.fn();
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({
    name: 'v1' as const,
    extract: extractMock,
  })),
  _resetExtractProviderForTest: vi.fn(),
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
  detectChange: vi.fn().mockReturnValue({ changed: false }),
}));

import { handleFetch } from '../../../src/tools/fetch.js';

function makeRouter(overrides: Partial<RawFetchResult> = {}): { fetch: ReturnType<typeof vi.fn> } {
  const defaults: RawFetchResult = {
    url: 'https://example.com',
    finalUrl: 'https://example.com',
    html: '<html><body><h1>Hello</h1><p>body</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'http',
    headers: {},
  };
  return {
    fetch: vi.fn().mockResolvedValue({ ...defaults, ...overrides }),
  };
}

function makeExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    title: 'Some Title',
    markdown: '# Some Title\n\nBody.',
    metadata: {},
    links: [],
    images: [],
    extractor: 'defuddle',
    ...overrides,
  };
}

// --- C2: http_status surfacing on FetchOutput ---
//
// WHY: 404 pages that render as HTML used to come back as `ok: true` with no
// status code at all. Cache + change-detection then treated a successful 200
// and a missing-page 404 as the same row when their bodies happened to hash
// identically. Surfacing `http_status` lets callers, the cache, and
// change-detection distinguish status-changed pages from body-changed pages.

describe('fetch surfaces http_status (C2)', () => {
  it('emits http_status: 200 on a normal fresh fetch', async () => {
    extractMock.mockResolvedValue(makeExtraction());
    const router = makeRouter({ statusCode: 200 });
    const input: FetchInput = { url: 'https://example.com', force_refresh: true };

    const r = await handleFetch(input, router as never);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.http_status).toBe(200);
    }
  });

  it('emits http_status: 404 when HTML 404 page returned but extraction still succeeds', async () => {
    extractMock.mockResolvedValue(
      makeExtraction({ title: 'Page Not Found', markdown: '# Page not found' }),
    );
    const router = makeRouter({
      statusCode: 404,
      html: '<html><body><h1>Page not found</h1></body></html>',
    });
    const input: FetchInput = { url: 'https://example.com/missing', force_refresh: true };

    const r = await handleFetch(input, router as never);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.http_status).toBe(404);
    }
  });

  it('emits http_status: 500 on HTML server-error pages', async () => {
    extractMock.mockResolvedValue(
      makeExtraction({ title: 'Server error', markdown: '# 500' }),
    );
    const router = makeRouter({
      statusCode: 500,
      html: '<html><body><h1>Server error</h1></body></html>',
    });
    const input: FetchInput = { url: 'https://example.com/oops', force_refresh: true };

    const r = await handleFetch(input, router as never);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.http_status).toBe(500);
    }
  });
});

// --- C3: section extraction silent failure ---
//
// WHY: when callers pass `section: "X"` and no heading matches, the old path
// silently returned the entire page body alongside `section_matched: false`,
// which looks identical to a successful match to any client that branches on
// content. The guard now nulls the body so downstream code is forced to react
// to the miss instead of consuming the whole page as if it were the section.

describe('fetch returns null body on section miss (C3)', () => {
  it('cached path: section_matched=false yields markdown="" and section_matched=false', async () => {
    const { getCachedContent, isCacheUsable } = await import('../../../src/cache/store.js');
    vi.mocked(getCachedContent).mockReturnValue({
      id: 1,
      url: 'https://example.com',
      normalizedUrl: 'https://example.com',
      title: 'Cached',
      markdown: '# Intro\n\nIntro text\n\n# Other\n\nOther text',
      rawHtml: '<html></html>',
      metadata: '{}',
      links: '[]',
      images: '[]',
      fetchMethod: 'http',
      extractorUsed: 'defuddle',
      contentHash: 'hash',
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    vi.mocked(isCacheUsable).mockReturnValue({ usable: true, stale: false });

    const router = makeRouter();
    const input: FetchInput = {
      url: 'https://example.com',
      section: 'NoSuchSection',
      include_full_markdown: true,
    };

    const r = await handleFetch(input, router as never);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.metadata.section_matched).toBe(false);
      expect(r.data.markdown).toBe('');
    }
  });

  it('fresh-fetch path: section_matched=false in metadata yields markdown=""', async () => {
    // Reset cache mock so we go down the fresh path.
    const { getCachedContent } = await import('../../../src/cache/store.js');
    vi.mocked(getCachedContent).mockReturnValue(null);

    // Simulated extractor: caller asked for a section, no heading matched,
    // so the extractor (v1 or markdown-fallback) reports section_matched=false
    // and the full body. The tool layer is what must guard.
    extractMock.mockResolvedValue(
      makeExtraction({
        markdown: '# A\n\nfoo\n\n# B\n\nbar',
        metadata: { section_matched: false } as ExtractionResult['metadata'],
      }),
    );

    const router = makeRouter();
    const input: FetchInput = {
      url: 'https://example.com',
      section: 'Nope',
      force_refresh: true,
      include_full_markdown: true,
    };

    const r = await handleFetch(input, router as never);

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.metadata.section_matched).toBe(false);
      expect(r.data.markdown).toBe('');
    }
  });
});
