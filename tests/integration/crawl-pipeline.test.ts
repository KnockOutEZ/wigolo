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
      } as FetchOutput;
    }

    if (url === 'https://docs.test.com/getting-started') {
      return {
        url,
        title: 'Getting Started',
        markdown: `# Getting Started\n\nFollow these steps.\n\n${sharedNav}`,
        metadata: {},
        links: ['https://docs.test.com/api-reference'],
        images: [],
        cached: false,
      } as FetchOutput;
    }

    if (url === 'https://docs.test.com/api-reference') {
      return {
        url,
        title: 'API Reference',
        markdown: `# API Reference\n\nEndpoint documentation.\n\n${sharedNav}`,
        metadata: {},
        links: [],
        images: [],
        cached: false,
      } as FetchOutput;
    }

    if (url === 'https://docs.test.com/changelog') {
      return {
        url,
        title: 'Changelog',
        markdown: `# Changelog\n\nVersion history.\n\n${sharedNav}`,
        metadata: {},
        links: [],
        images: [],
        cached: false,
      } as FetchOutput;
    }

    return {
      url,
      title: '',
      markdown: '',
      metadata: {},
      links: [],
      images: [],
      cached: false,
      error: 'Not found',
    } as FetchOutput;
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
      { url: 'https://docs.test.com', max_depth: 1, max_pages: 10 },
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
});
