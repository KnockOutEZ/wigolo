import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Crawler, type FetchFn, type RawFetchFn } from '../../../src/crawl/crawler.js';
import type { FetchOutput } from '../../../src/types.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    crawlConcurrency: 2,
    crawlDelayMs: 0,
    crawlPrivateConcurrency: 10,
    crawlPrivateDelayMs: 0,
    respectRobotsTxt: false,
    logLevel: 'error',
    logFormat: 'json',
  }),
  resetConfig: vi.fn(),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeFetchOutput(url: string, title: string, markdown: string, links: string[] = []): FetchOutput {
  return {
    url,
    title,
    markdown,
    metadata: {},
    links,
    images: [],
    cached: false,
  };
}

describe('Crawler — BFS', () => {
  let fetchFn: FetchFn;
  let rawFetchFn: RawFetchFn;

  beforeEach(() => {
    vi.clearAllMocks();

    fetchFn = vi.fn(async (url: string) => {
      if (url === 'https://docs.example.com') {
        return makeFetchOutput(url, 'Docs Home', '# Docs\n\nWelcome.', [
          'https://docs.example.com/intro',
          'https://docs.example.com/api',
          'https://other.example.com/external',
        ]);
      }
      if (url === 'https://docs.example.com/intro') {
        return makeFetchOutput(url, 'Intro', '# Intro\n\nGetting started.', [
          'https://docs.example.com/api',
          'https://docs.example.com/deep/nested',
        ]);
      }
      if (url === 'https://docs.example.com/api') {
        return makeFetchOutput(url, 'API', '# API\n\nEndpoints.', []);
      }
      if (url === 'https://docs.example.com/deep/nested') {
        return makeFetchOutput(url, 'Nested', '# Nested\n\nDeep page.', []);
      }
      return makeFetchOutput(url, '', '', []);
    });

    rawFetchFn = vi.fn(async () => ({
      url: '',
      finalUrl: '',
      html: '',
      contentType: 'text/plain',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }));
  });

  it('crawls seed URL and discovers linked pages (BFS)', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 10,
    });

    expect(result.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.pages[0].url).toBe('https://docs.example.com');
    expect(result.pages[0].depth).toBe(0);
    expect(result.crawled).toBeGreaterThanOrEqual(1);
  });

  it('respects max_depth', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 0,
      max_pages: 10,
    });

    // depth=0 means only seed page
    expect(result.crawled).toBe(1);
    expect(result.pages[0].url).toBe('https://docs.example.com');
  });

  it('respects max_pages', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 5,
      max_pages: 2,
    });

    expect(result.crawled).toBeLessThanOrEqual(2);
    expect(result.pages.length).toBeLessThanOrEqual(2);
  });

  it('only follows same-origin links', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 10,
    });

    const urls = result.pages.map((p) => p.url);
    expect(urls).not.toContain('https://other.example.com/external');
  });

  it('does not visit the same URL twice', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 2,
      max_pages: 10,
    });

    // api is linked from both seed and intro — should only be fetched once
    const apiCalls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === 'https://docs.example.com/api',
    );
    expect(apiCalls).toHaveLength(1);
  });

  it('applies include_patterns filter', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 2,
      max_pages: 10,
      include_patterns: ['/intro'],
    });

    const urls = result.pages.map((p) => p.url);
    // Seed is always included; only /intro should be discovered beyond seed
    expect(urls).toContain('https://docs.example.com');
    // Pages not matching /intro should be excluded (api, deep/nested)
    expect(urls).not.toContain('https://docs.example.com/api');
  });

  it('applies exclude_patterns filter', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 2,
      max_pages: 10,
      exclude_patterns: ['/api'],
    });

    const urls = result.pages.map((p) => p.url);
    expect(urls).not.toContain('https://docs.example.com/api');
  });

  it('returns extract_links when requested', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 10,
      extract_links: true,
    });

    expect(result.links).toBeDefined();
    expect(result.links!.length).toBeGreaterThan(0);
    expect(result.links![0]).toHaveProperty('from');
    expect(result.links![0]).toHaveProperty('to');
  });

  it('skips pages that return errors and continues crawling', async () => {
    const failingFetch: FetchFn = vi.fn(async (url) => {
      if (url === 'https://docs.example.com') {
        return makeFetchOutput(url, 'Home', '# Home', [
          'https://docs.example.com/good',
          'https://docs.example.com/bad',
        ]);
      }
      if (url === 'https://docs.example.com/bad') {
        return { ...makeFetchOutput(url, '', '', []), error: 'Network timeout' };
      }
      if (url === 'https://docs.example.com/good') {
        return makeFetchOutput(url, 'Good', '# Good\n\nWorks.', []);
      }
      return makeFetchOutput(url, '', '', []);
    });

    const crawler = new Crawler(failingFetch, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 10,
    });

    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain('https://docs.example.com');
    expect(urls).toContain('https://docs.example.com/good');
    // Bad page should not appear in results
    expect(urls).not.toContain('https://docs.example.com/bad');
  });

  it('reports total_found including pages not crawled', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 2,
    });

    // Seed discovers 2 same-origin links, but max_pages=2 limits crawling
    expect(result.total_found).toBeGreaterThanOrEqual(result.crawled);
  });
});
