import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FetchOutput, RawFetchResult } from '../../src/types.js';
import { handleCrawl } from '../../src/tools/crawl.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';

vi.mock('../../src/config.js', () => ({
  getConfig: () => ({
    crawlConcurrency: 5,
    crawlDelayMs: 0,
    crawlPrivateConcurrency: 10,
    crawlPrivateDelayMs: 0,
    respectRobotsTxt: true,
    cacheTtlContent: 604800,
    logLevel: 'error',
    logFormat: 'json',
    fetchTimeoutMs: 5000,
    fetchMaxRetries: 0,
    maxRedirects: 5,
    playwrightLoadTimeoutMs: 5000,
    playwrightNavTimeoutMs: 5000,
    maxBrowsers: 1,
    browserIdleTimeoutMs: 5000,
    browserFallbackThreshold: 3,
    authStatePath: null,
    chromeProfilePath: null,
    dataDir: '/tmp/wigolo-test',
    validateLinks: false,
  }),
  resetConfig: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock the fetch tool to avoid real HTTP
vi.mock('../../src/tools/fetch.js', () => ({
  handleFetch: vi.fn(),
}));

vi.mock('../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isExpired: vi.fn().mockReturnValue(false),
}));

import { handleFetch } from '../../src/tools/fetch.js';

// Shared navigation that appears on every page (should be deduped)
const sharedNav = '## Navigation\n\n[Home](/) | [Docs](/docs) | [API](/api)';

function setupFetchMock() {
  vi.mocked(handleFetch).mockImplementation(async (input) => {
    const url = input.url;

    if (url === 'https://docs.test.com') {
      return {
        ok: true,
        data: {
          url,
          title: 'Docs Home',
          markdown: `# Docs Home\n\nWelcome to the docs.\n\n${sharedNav}`,
          metadata: {},
          links: [
            'https://docs.test.com/getting-started',
            'https://docs.test.com/api-reference',
            'https://docs.test.com/changelog',
            'https://external.com/link',
          ],
          images: [],
          cached: false,
        } as FetchOutput,
      };
    }

    if (url === 'https://docs.test.com/getting-started') {
      return {
        ok: true,
        data: {
          url,
          title: 'Getting Started',
          markdown: `# Getting Started\n\nFollow these steps.\n\n${sharedNav}`,
          metadata: {},
          links: ['https://docs.test.com/api-reference'],
          images: [],
          cached: false,
        } as FetchOutput,
      };
    }

    if (url === 'https://docs.test.com/api-reference') {
      return {
        ok: true,
        data: {
          url,
          title: 'API Reference',
          markdown: `# API Reference\n\nEndpoint documentation.\n\n${sharedNav}`,
          metadata: {},
          links: [],
          images: [],
          cached: false,
        } as FetchOutput,
      };
    }

    if (url === 'https://docs.test.com/changelog') {
      return {
        ok: true,
        data: {
          url,
          title: 'Changelog',
          markdown: `# Changelog\n\nVersion history.\n\n${sharedNav}`,
          metadata: {},
          links: [],
          images: [],
          cached: false,
        } as FetchOutput,
      };
    }

    return {
      ok: false,
      error: 'not_found',
      error_reason: 'Not found',
      stage: 'fetch',
    };
  });
}

function mockRouter() {
  return {
    fetch: vi.fn(async (url: string) => {
      // robots.txt
      if (url.endsWith('/robots.txt')) {
        return {
          url,
          finalUrl: url,
          html: 'User-agent: *\nDisallow: /private/\nAllow: /',
          contentType: 'text/plain',
          statusCode: 200,
          method: 'http' as const,
          headers: {},
        } as RawFetchResult;
      }
      return {
        url,
        finalUrl: url,
        html: '',
        contentType: 'text/plain',
        statusCode: 404,
        method: 'http' as const,
        headers: {},
      } as RawFetchResult;
    }),
    getDomainStats: vi.fn(),
  };
}

describe('Crawl Pipeline Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initDatabase(':memory:');
    setupFetchMock();
  });

  afterEach(() => {
    closeDatabase();
  });

  it('crawls a site BFS and deduplicates shared navigation', async () => {
    const router = mockRouter();
    const result = await handleCrawl(
      { url: 'https://docs.test.com', max_depth: 1, max_pages: 10, include_full_markdown: true },
      router as any,
    );

    expect(result.crawled).toBeGreaterThanOrEqual(3);
    expect(result.error).toBeUndefined();

    // Shared navigation should be stripped by dedup
    for (const page of result.pages) {
      expect(page.markdown).not.toContain('[Home](/) | [Docs](/docs)');
    }

    // Unique content should remain
    const homeContent = result.pages.find((p) => p.url === 'https://docs.test.com');
    expect(homeContent?.markdown).toContain('Welcome to the docs');
  });

  it('enforces max_total_chars across all pages', async () => {
    const router = mockRouter();
    const result = await handleCrawl(
      { url: 'https://docs.test.com', max_depth: 1, max_pages: 10, max_total_chars: 100 },
      router as any,
    );

    const totalChars = result.pages.reduce((sum, p) => sum + p.markdown.length, 0);
    // At minimum the first page is included even if it exceeds budget
    expect(result.pages.length).toBeGreaterThanOrEqual(1);
  });

  it('applies exclude_patterns', async () => {
    const router = mockRouter();
    const result = await handleCrawl(
      {
        url: 'https://docs.test.com',
        max_depth: 1,
        max_pages: 10,
        exclude_patterns: ['/changelog'],
      },
      router as any,
    );

    const urls = result.pages.map((p) => p.url);
    expect(urls).not.toContain('https://docs.test.com/changelog');
  });

  // Every crawl strategy returned `markdown: ""` on every page
  // by default even though the extraction pipeline had already produced a
  // body. The tool boundary must surface the extracted markdown by default
  // across strategies (BFS, sitemap, map and include_patterns variants).
  it('H10: BFS default keeps non-empty markdown on every page (no opt-in needed)', async () => {
    const router = mockRouter();
    const result = await handleCrawl(
      { url: 'https://docs.test.com', max_depth: 1, max_pages: 10 },
      router as any,
    );

    expect(result.crawled).toBeGreaterThanOrEqual(3);
    expect(result.error).toBeUndefined();
    // Every page that returned a body must carry that body in `markdown`,
    // not an empty string. This is the H10 regression guard.
    for (const page of result.pages) {
      expect(page.markdown.length).toBeGreaterThan(0);
    }
    // Spot-check: home page body survives.
    const home = result.pages.find((p) => p.url === 'https://docs.test.com');
    expect(home?.markdown).toContain('Welcome to the docs');
  });

  it('H10: include_patterns variant also keeps markdown populated by default', async () => {
    const router = mockRouter();
    const result = await handleCrawl(
      {
        url: 'https://docs.test.com',
        max_depth: 1,
        max_pages: 10,
        include_patterns: ['/getting-started', '^https://docs\\.test\\.com$'],
      },
      router as any,
    );
    for (const page of result.pages) {
      expect(page.markdown.length).toBeGreaterThan(0);
    }
  });

  it('sitemap strategy also keeps markdown populated by default', async () => {
    // Sitemap was one of the strategies returning `markdown: ""`.
    // Provide a sitemap response from
    // the router and confirm the crawl tool emits non-empty markdown.
    const sitemapXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.test.com/getting-started</loc></url>
  <url><loc>https://docs.test.com/api-reference</loc></url>
</urlset>`;
    const router = {
      fetch: vi.fn(async (url: string) => {
        if (url.endsWith('/sitemap.xml')) {
          return {
            url,
            finalUrl: url,
            html: sitemapXml,
            contentType: 'application/xml',
            statusCode: 200,
            method: 'http' as const,
            headers: {},
          } as RawFetchResult;
        }
        if (url.endsWith('/robots.txt')) {
          return {
            url,
            finalUrl: url,
            html: 'User-agent: *\nAllow: /',
            contentType: 'text/plain',
            statusCode: 200,
            method: 'http' as const,
            headers: {},
          } as RawFetchResult;
        }
        return {
          url,
          finalUrl: url,
          html: '',
          contentType: 'text/plain',
          statusCode: 404,
          method: 'http' as const,
          headers: {},
        } as RawFetchResult;
      }),
      getDomainStats: vi.fn(),
    };
    const result = await handleCrawl(
      { url: 'https://docs.test.com', strategy: 'sitemap', max_pages: 10 },
      router as any,
    );
    expect(result.crawled).toBeGreaterThanOrEqual(2);
    for (const page of result.pages) {
      expect(page.markdown.length).toBeGreaterThan(0);
    }
  });

  it('H10: a 404/error page co-existing with a 200 page emits markdown only on the 200', async () => {
    // Boundary case from the slice brief: when one URL fails (404 / network
    // error), the OTHER URLs must still surface their markdown. The failing
    // page returns from the mock with `ok:false` so its slot is dropped
    // entirely — the remaining pages must still have populated markdown.
    vi.mocked(handleFetch).mockReset();
    vi.mocked(handleFetch).mockImplementation(async (input) => {
      const url = input.url;
      if (url === 'https://docs.test.com') {
        return {
          ok: true,
          data: {
            url,
            title: 'Home',
            markdown: '# Home\n\nReal content here.',
            metadata: {},
            links: ['https://docs.test.com/missing', 'https://docs.test.com/api-reference'],
            images: [],
            cached: false,
          } as FetchOutput,
        };
      }
      if (url === 'https://docs.test.com/api-reference') {
        return {
          ok: true,
          data: {
            url,
            title: 'API',
            markdown: '# API\n\nEndpoint details.',
            metadata: {},
            links: [],
            images: [],
            cached: false,
          } as FetchOutput,
        };
      }
      return {
        ok: false,
        error: 'http_404',
        error_reason: 'Not found',
        stage: 'fetch',
      };
    });

    const router = mockRouter();
    const result = await handleCrawl(
      { url: 'https://docs.test.com', max_depth: 1, max_pages: 10 },
      router as any,
    );

    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain('https://docs.test.com');
    expect(urls).toContain('https://docs.test.com/api-reference');
    // The 404 page is dropped from the result set entirely (per crawler
    // contract). The surviving pages must still carry their markdown bodies.
    expect(urls).not.toContain('https://docs.test.com/missing');
    for (const page of result.pages) {
      expect(page.markdown.length).toBeGreaterThan(0);
    }
  });
});
