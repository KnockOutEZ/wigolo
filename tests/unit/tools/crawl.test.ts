import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrawlInput, CrawlOutput, FetchOutput, RawFetchResult } from '../../../src/types.js';

vi.mock('../../../src/crawl/crawler.js', () => {
  const MockCrawler = vi.fn();
  return { Crawler: MockCrawler };
});

vi.mock('../../../src/crawl/dedup.js', () => ({
  deduplicatePages: vi.fn((pages: Array<{ url: string; markdown: string }>) => pages),
  storeBoilerplate: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    respectRobotsTxt: true,
    crawlConcurrency: 2,
    crawlDelayMs: 0,
    crawlPrivateConcurrency: 10,
    crawlPrivateDelayMs: 0,
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

import { handleCrawl } from '../../../src/tools/crawl.js';
import { Crawler } from '../../../src/crawl/crawler.js';
import { deduplicatePages } from '../../../src/crawl/dedup.js';

function mockRouter() {
  return {
    fetch: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      html: '<html></html>',
      contentType: 'text/html',
      statusCode: 200,
      method: 'http' as const,
      headers: {},
    }),
    getDomainStats: vi.fn(),
  };
}

describe('handleCrawl', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const mockCrawl = vi.fn().mockResolvedValue({
      pages: [
        { url: 'https://docs.example.com', title: 'Home', markdown: '# Home\n\nWelcome.', depth: 0 },
        { url: 'https://docs.example.com/intro', title: 'Intro', markdown: '# Intro\n\nGetting started.', depth: 1 },
        { url: 'https://docs.example.com/api', title: 'API', markdown: '# API\n\nEndpoints here.', depth: 1 },
      ],
      total_found: 5,
      crawled: 3,
    });

    vi.mocked(Crawler).mockImplementation(function (this: any) {
      this.crawl = mockCrawl;
      this.crawlSitemap = vi.fn();
    } as any);
  });

  it('returns crawl results with defaults', async () => {
    const router = mockRouter();
    const input: CrawlInput = { url: 'https://docs.example.com' };

    const result = await handleCrawl(input, router as any);

    expect(result.crawled).toBe(3);
    expect(result.total_found).toBe(5);
    expect(result.pages.length).toBe(3);
    expect(result.error).toBeUndefined();
  });

  it('calls deduplicatePages', async () => {
    const router = mockRouter();
    const input: CrawlInput = { url: 'https://docs.example.com' };

    await handleCrawl(input, router as any);

    expect(vi.mocked(deduplicatePages)).toHaveBeenCalledOnce();
  });

  it('enforces max_total_chars budget', async () => {
    const mockCrawl = vi.fn().mockResolvedValue({
      pages: [
        { url: 'https://a.com/1', title: 'P1', markdown: 'A'.repeat(60000), depth: 0 },
        { url: 'https://a.com/2', title: 'P2', markdown: 'B'.repeat(60000), depth: 1 },
        { url: 'https://a.com/3', title: 'P3', markdown: 'C'.repeat(60000), depth: 1 },
      ],
      total_found: 3,
      crawled: 3,
    });

    vi.mocked(Crawler).mockImplementation(function (this: any) {
      this.crawl = mockCrawl;
      this.crawlSitemap = vi.fn();
    } as any);

    const router = mockRouter();
    const input: CrawlInput = { url: 'https://a.com', max_total_chars: 100000 };

    const result = await handleCrawl(input, router as any);

    const totalChars = result.pages.reduce((sum, p) => sum + p.markdown.length, 0);
    expect(totalChars).toBeLessThanOrEqual(100000);
    // Third page should be dropped since first two already hit ~120K
    expect(result.pages.length).toBeLessThan(3);
  });

  it('returns error response on crawler failure', async () => {
    vi.mocked(Crawler).mockImplementation(function (this: any) {
      this.crawl = vi.fn().mockRejectedValue(new Error('Crawler exploded'));
      this.crawlSitemap = vi.fn();
    } as any);

    const router = mockRouter();
    const input: CrawlInput = { url: 'https://example.com' };

    const result = await handleCrawl(input, router as any);

    expect(result.error).toBe('Crawler exploded');
    expect(result.pages).toEqual([]);
    expect(result.crawled).toBe(0);
  });

  it('uses default max_total_chars of 100000', async () => {
    const longPages = Array.from({ length: 5 }, (_, i) => ({
      url: `https://a.com/${i}`,
      title: `Page ${i}`,
      markdown: 'X'.repeat(30000),
      depth: 0,
    }));

    vi.mocked(Crawler).mockImplementation(function (this: any) {
      this.crawl = vi.fn().mockResolvedValue({ pages: longPages, total_found: 5, crawled: 5 });
      this.crawlSitemap = vi.fn();
    } as any);

    const router = mockRouter();
    const input: CrawlInput = { url: 'https://a.com' };

    const result = await handleCrawl(input, router as any);

    const totalChars = result.pages.reduce((sum, p) => sum + p.markdown.length, 0);
    expect(totalChars).toBeLessThanOrEqual(100000);
  });
});
