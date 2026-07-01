import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CrawlInput, CrawlOutput, FetchOutput, RawFetchResult } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

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

  describe('evidence shape', () => {
    const longMd =
      '# Page Title\n\n' +
      'TypeScript is a strongly typed programming language that builds on JavaScript. ' +
      'It compiles to plain JavaScript and runs in any browser, Node.js, or anywhere ' +
      'JavaScript runs at all.\n\nTypeScript adds static typing to JavaScript.';

    beforeEach(() => {
      const mockCrawl = vi.fn().mockResolvedValue({
        pages: [
          { url: 'https://docs.example.com', title: 'Home', markdown: longMd, depth: 0 },
          { url: 'https://docs.example.com/intro', title: 'Intro', markdown: longMd, depth: 1 },
        ],
        total_found: 2,
        crawled: 2,
      });
      vi.mocked(Crawler).mockImplementation(function (this: any) {
        this.crawl = mockCrawl;
        this.crawlSitemap = vi.fn();
      } as unknown as typeof Crawler);
    });

    it('default keeps page markdown populated (extraction pipeline output survives)', async () => {
      // Every strategy returned `markdown: ""` on every page even
      // though the extraction pipeline had already run. Default behavior must
      // now surface the extracted body so callers see the actual page content.
      const router = mockRouter();
      const input: CrawlInput = { url: 'https://docs.example.com' };

      const result = await handleCrawl(input, router as unknown as SmartRouter) as CrawlOutput;

      const pagesWithEvidence = result.pages.filter((p) => p.evidence && p.evidence.length > 0);
      expect(pagesWithEvidence.length).toBeGreaterThan(0);
      // Each page that has evidence should carry exactly its own item(s)
      for (const p of pagesWithEvidence) {
        expect(p.evidence!.length).toBeGreaterThan(0);
        const ev = p.evidence![0];
        expect(ev.url).toBe(p.url);
        expect(ev.excerpt.length).toBeGreaterThan(0);
        expect(ev.citation_id).toMatch(/^[a-f0-9]{12}$/);
        expect(ev.source_span.end).toBeGreaterThan(ev.source_span.start);
      }
      // H10 fix: every page carries its extracted markdown body by default.
      for (const p of result.pages) {
        expect(p.markdown.length).toBeGreaterThan(0);
        expect(p.markdown).toContain('TypeScript');
      }
    });

    it('include_full_markdown=true (explicit) keeps page markdown', async () => {
      const router = mockRouter();
      const input: CrawlInput = {
        url: 'https://docs.example.com',
        include_full_markdown: true,
      };

      const result = await handleCrawl(input, router as unknown as SmartRouter) as CrawlOutput;

      const pagesWithEvidence = result.pages.filter((p) => p.evidence && p.evidence.length > 0);
      expect(pagesWithEvidence.length).toBeGreaterThan(0);
      expect(result.pages.every((p) => p.markdown.length > 0)).toBe(true);
    });

    it('include_full_markdown=false drops markdown but surfaces excerpt', async () => {
      // Explicit opt-out for callers that only want the evidence + excerpt
      // envelope. Mirrors handleFetch's include_full_markdown contract.
      const router = mockRouter();
      const input: CrawlInput = {
        url: 'https://docs.example.com',
        include_full_markdown: false,
      };

      const result = await handleCrawl(input, router as unknown as SmartRouter) as CrawlOutput;
      for (const p of result.pages) {
        expect(p.markdown).toBe('');
      }
    });
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
    // crawled reflects pages actually returned, not raw fetch count
    expect(result.crawled).toBe(result.pages.length);
    // dropped_over_budget surfaces pages excluded by max_total_chars budget
    expect(result.dropped_over_budget).toBe(5 - result.pages.length);
  });
});
