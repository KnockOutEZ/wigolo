import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Crawler, type FetchFn, type RawFetchFn } from '../../../src/crawl/crawler.js';
import { RateLimiter } from '../../../src/crawl/rate-limiter.js';
import type { FetchOutput, RawFetchResult } from '../../../src/types.js';
import { handleFetch } from '../../../src/tools/fetch.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: () => ({
    crawlConcurrency: 2,
    crawlDelayMs: 0,
    crawlPrivateConcurrency: 10,
    crawlPrivateDelayMs: 0,
    crawlJitterPct: 0,
    crawlCooldownFactor: 2,
    crawlCooldownMaxMs: 300000,
    respectRobotsTxt: false,
    fetchAllowPrivate: false,
    fastStaleMaxHours: 24,
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

// Mocks so the REAL handleFetch (src/tools/fetch.ts) runs its challenge-block
// early-return path without touching disk/network. The de-vacuumed cooldown
// test below drives handleFetch → r.http_status → the tools/crawl.ts closure →
// Crawler → recordResponse, so the field name mismatch that dropped the status
// can regress the test rather than pass vacuously.
vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn().mockReturnValue({ usable: false, stale: false }),
}));
vi.mock('../../../src/providers/extract-provider.js', () => ({
  getExtractProvider: vi.fn(async () => ({ name: 'v1' as const, extract: vi.fn() })),
  _resetExtractProviderForTest: vi.fn(),
}));
vi.mock('../../../src/cache/change-detector.js', () => ({
  detectChange: vi.fn().mockReturnValue({ changed: false }),
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

  it('threads content_completeness from the page fetch onto the crawl page item', async () => {
    const shellFetch: FetchFn = vi.fn(async (url: string) => ({
      ...makeFetchOutput(url, 'Shell', '# Shell', []),
      content_completeness: { level: 'shell' as const, reason: 'app_shell' as const, settled_by: 'budget' as const },
    }));
    const crawler = new Crawler(shellFetch, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 0,
      max_pages: 1,
    });
    expect(result.pages[0].content_completeness).toEqual({
      level: 'shell',
      reason: 'app_shell',
      settled_by: 'budget',
    });
  });

  it('leaves content_completeness absent on the page item when the fetch lacks it', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 0,
      max_pages: 1,
    });
    expect(result.pages[0].content_completeness).toBeUndefined();
  });

  it('threads challenge_class/solve_method from a cleared-via-solve page fetch onto the crawl item', async () => {
    const solvedFetch: FetchFn = vi.fn(async (url: string) => ({
      ...makeFetchOutput(url, 'Cleared', '# Cleared\n\nBehind a challenge.', []),
      challenge_class: 'interactive' as const,
      solve_method: 'auto-pass' as const,
    }));
    const crawler = new Crawler(solvedFetch, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 0,
      max_pages: 1,
    });
    expect(result.pages[0].challenge_class).toBe('interactive');
    expect(result.pages[0].solve_method).toBe('auto-pass');
  });

  it('leaves challenge_class/solve_method absent on a normal page (no challenge)', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 0,
      max_pages: 1,
    });
    expect(result.pages[0].challenge_class).toBeUndefined();
    expect(result.pages[0].solve_method).toBeUndefined();
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

describe('Crawler — DFS', () => {
  let fetchFn: FetchFn;
  let rawFetchFn: RawFetchFn;

  beforeEach(() => {
    vi.clearAllMocks();

    fetchFn = vi.fn(async (url: string) => {
      if (url === 'https://docs.example.com') {
        return makeFetchOutput(url, 'Root', '# Root', [
          'https://docs.example.com/a',
          'https://docs.example.com/b',
        ]);
      }
      if (url === 'https://docs.example.com/a') {
        return makeFetchOutput(url, 'A', '# A', [
          'https://docs.example.com/a/deep',
        ]);
      }
      if (url === 'https://docs.example.com/a/deep') {
        return makeFetchOutput(url, 'A Deep', '# A Deep', []);
      }
      if (url === 'https://docs.example.com/b') {
        return makeFetchOutput(url, 'B', '# B', []);
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

  it('explores depth-first (last-discovered links visited first)', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'dfs',
      max_depth: 3,
      max_pages: 10,
    });

    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain('https://docs.example.com');
    expect(urls).toContain('https://docs.example.com/a');
    expect(urls).toContain('https://docs.example.com/a/deep');
    expect(urls).toContain('https://docs.example.com/b');

    // In DFS, /b is pushed first then /a. Pop takes /a first. /a discovers /a/deep.
    // Wait — queue pushes in order [a, b], pop takes b first (LIFO).
    // Then b has no children. Then pop a, which discovers a/deep. Pop a/deep.
    // Final order: root, b, a, a/deep
    const bIdx = urls.indexOf('https://docs.example.com/b');
    const aIdx = urls.indexOf('https://docs.example.com/a');
    expect(bIdx).toBeLessThan(aIdx); // DFS pops last-pushed first
  });

  it('tracks correct depth in DFS', async () => {
    const crawler = new Crawler(fetchFn, rawFetchFn);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'dfs',
      max_depth: 3,
      max_pages: 10,
    });

    const deepPage = result.pages.find((p) => p.url === 'https://docs.example.com/a/deep');
    expect(deepPage?.depth).toBe(2);
  });
});

describe('Crawler — Sitemap', () => {
  it('fetches pages from sitemap.xml', async () => {
    const sitemapXml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/page1</loc></url>
  <url><loc>https://docs.example.com/page2</loc></url>
</urlset>`;

    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return { url, finalUrl: url, html: sitemapXml, contentType: 'text/xml', statusCode: 200, method: 'http' as const, headers: {} };
      }
      return { url, finalUrl: url, html: '', contentType: 'text/plain', statusCode: 404, method: 'http' as const, headers: {} };
    });

    const fetch: FetchFn = vi.fn(async (url) =>
      makeFetchOutput(url, `Page ${url.split('/').pop()}`, `# Content for ${url}`, []),
    );

    const crawler = new Crawler(fetch, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'sitemap',
      max_pages: 10,
    });

    expect(result.pages.length).toBe(2);
    expect(result.total_found).toBe(2);
    const urls = result.pages.map((p) => p.url);
    expect(urls).toContain('https://docs.example.com/page1');
    expect(urls).toContain('https://docs.example.com/page2');
  });

  it('falls back to BFS when no sitemap found', async () => {
    const rawFetch: RawFetchFn = vi.fn(async (url) => ({
      url,
      finalUrl: url,
      html: 'Not Found',
      contentType: 'text/plain',
      statusCode: 404,
      method: 'http' as const,
      headers: {},
    }));

    const fetch: FetchFn = vi.fn(async (url) =>
      makeFetchOutput(url, 'Home', '# Home', ['https://docs.example.com/page1']),
    );

    const crawler = new Crawler(fetch, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'sitemap',
      max_pages: 10,
      max_depth: 1,
    });

    // Should have fallen back to BFS and crawled at least the seed
    expect(result.crawled).toBeGreaterThanOrEqual(1);
  });

  it('respects max_pages for sitemap strategy', async () => {
    const urls = Array.from({ length: 50 }, (_, i) =>
      `<url><loc>https://docs.example.com/p${i}</loc></url>`,
    ).join('\n');
    const sitemapXml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;

    const rawFetch: RawFetchFn = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml')) {
        return { url, finalUrl: url, html: sitemapXml, contentType: 'text/xml', statusCode: 200, method: 'http' as const, headers: {} };
      }
      return { url, finalUrl: url, html: '', contentType: 'text/plain', statusCode: 404, method: 'http' as const, headers: {} };
    });

    const fetch: FetchFn = vi.fn(async (url) =>
      makeFetchOutput(url, 'Page', '# Page', []),
    );

    const crawler = new Crawler(fetch, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'sitemap',
      max_pages: 5,
    });

    expect(result.crawled).toBeLessThanOrEqual(5);
    expect(result.total_found).toBe(50);
  });

  it('threads challenge_class/solve_method through the sitemap/explicit-urls path', async () => {
    const sitemapXml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://docs.example.com/page1</loc></url>
</urlset>`;

    const rawFetch: RawFetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/sitemap.xml')) {
        return { url, finalUrl: url, html: sitemapXml, contentType: 'text/xml', statusCode: 200, method: 'http' as const, headers: {} };
      }
      return { url, finalUrl: url, html: '', contentType: 'text/plain', statusCode: 404, method: 'http' as const, headers: {} };
    });

    const fetch: FetchFn = vi.fn(async (url) => ({
      ...makeFetchOutput(url, 'Cleared', '# Content', []),
      challenge_class: 'interactive' as const,
      solve_method: 'auto-pass' as const,
    }));

    const crawler = new Crawler(fetch, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'sitemap',
      max_pages: 10,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].challenge_class).toBe('interactive');
    expect(result.pages[0].solve_method).toBe('auto-pass');
  });
});

describe('Crawler — canonical output URLs', () => {
  it('collapses trailing-slash duplicates from sitemap into one page', async () => {
    const sitemapXml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <url><loc>https://docs.example.com/intro</loc></url>
      <url><loc>https://docs.example.com/intro/</loc></url>
      <url><loc>https://docs.example.com/api</loc></url>
    </urlset>`;

    const rawFetch: RawFetchFn = vi.fn(async (url) => {
      if (url.endsWith('/sitemap.xml')) {
        return { url, finalUrl: url, html: sitemapXml, contentType: 'text/xml', statusCode: 200, method: 'http' as const, headers: {} };
      }
      return { url, finalUrl: url, html: '', contentType: 'text/plain', statusCode: 404, method: 'http' as const, headers: {} };
    });

    const fetch: FetchFn = vi.fn(async (url) =>
      makeFetchOutput(url, 'Page', '# Page', []),
    );

    const crawler = new Crawler(fetch, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'sitemap',
      max_pages: 10,
    });

    const urls = result.pages.map((p) => p.url);
    expect(urls).toHaveLength(2);
    expect(urls).toContain('https://docs.example.com/intro');
    expect(urls).toContain('https://docs.example.com/api');
    expect(urls.some((u) => u.endsWith('/intro/'))).toBe(false);
  });

  it('does not fetch the same page repeatedly when outbound links share canonical URL with different anchor fragments', async () => {
    // Bench: BFS returned the same page 5x because /page#a, /page#b, /page#c
    // all canonicalize to /page but the visited check fired against the
    // pre-loop snapshot, letting duplicates queue up.
    const fetchSpy: FetchFn = vi.fn(async (url: string) => {
      if (url === 'https://docs.example.com') {
        return makeFetchOutput(url, 'Home', '# Home', [
          'https://docs.example.com/page#section-1',
          'https://docs.example.com/page#section-2',
          'https://docs.example.com/page#section-3',
          'https://docs.example.com/page',
          'https://docs.example.com/page#section-4',
        ]);
      }
      // Same target URL no matter which fragment we arrived with.
      return makeFetchOutput('https://docs.example.com/page', 'Page', '# Page', []);
    });
    const rawFetch: RawFetchFn = vi.fn(async () => ({
      url: '', finalUrl: '', html: '', contentType: 'text/plain', statusCode: 200, method: 'http' as const, headers: {},
    }));

    const crawler = new Crawler(fetchSpy, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 10,
    });

    const pageHits = result.pages.filter((p) => p.url === 'https://docs.example.com/page').length;
    expect(pageHits).toBe(1);
    // fetchFn called once for seed + once for the canonical target.
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it('strips anchor fragments from emitted page URLs', async () => {
    // pages[] held two `/intro` entries because
    // fetchResult.url carried different anchor fragments (e.g. `#welcome`,
    // `#getting-started`). Anchors are intra-page navigation, not page
    // identity — emit should strip them so dedup is visible in the output.
    const fetch: FetchFn = vi.fn(async (url) => {
      if (url === 'https://docs.example.com') {
        return makeFetchOutput(url, 'Home', '# Home', [
          'https://docs.example.com/intro#welcome',
          'https://docs.example.com/intro#getting-started',
        ]);
      }
      // The page may include a fragment in its self-reported URL (e.g. a
      // server-side normalization step or a redirect to the first anchor).
      return makeFetchOutput('https://docs.example.com/intro#welcome', 'Intro', '# Intro', []);
    });
    const rawFetch: RawFetchFn = vi.fn(async () => ({
      url: '', finalUrl: '', html: '', contentType: 'text/plain', statusCode: 200, method: 'http' as const, headers: {},
    }));

    const crawler = new Crawler(fetch, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 5,
    });

    const introHits = result.pages.filter(p => p.url.startsWith('https://docs.example.com/intro'));
    expect(introHits).toHaveLength(1);
    expect(introHits[0].url).toBe('https://docs.example.com/intro');
  });

  it('dedupes anchor-fragment URLs in the link graph', async () => {
    // Docs claimed the crawl link graph deduped anchor fragments,
    // but a page that linked to /foo, /foo#section-a, /foo#section-b created
    // three separate edges. The link graph must collapse those into a single
    // entry per (from, canonical-to) pair.
    const fetchSpy: FetchFn = vi.fn(async (url: string) => {
      if (url === 'https://docs.example.com') {
        return makeFetchOutput(url, 'Home', '# Home', [
          'https://docs.example.com/foo',
          'https://docs.example.com/foo#section-a',
          'https://docs.example.com/foo#section-b',
        ]);
      }
      return makeFetchOutput(url, 'Foo', '# Foo', []);
    });
    const rawFetch: RawFetchFn = vi.fn(async () => ({
      url: '', finalUrl: '', html: '', contentType: 'text/plain', statusCode: 200, method: 'http' as const, headers: {},
    }));

    const crawler = new Crawler(fetchSpy, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com',
      strategy: 'bfs',
      max_depth: 1,
      max_pages: 5,
      extract_links: true,
    });

    expect(result.links).toBeDefined();
    const fooEdges = result.links!.filter((e) =>
      e.from === 'https://docs.example.com' &&
      e.to.startsWith('https://docs.example.com/foo'),
    );
    // Same canonical target — one edge, not three.
    expect(fooEdges).toHaveLength(1);
    // The retained edge points at the fragment-stripped form.
    expect(fooEdges[0].to).toBe('https://docs.example.com/foo');
  });

  it('strips trailing slash on emitted non-root paths', async () => {
    const fetch: FetchFn = vi.fn(async (url) => {
      if (url === 'https://docs.example.com/intro') {
        // Page returns trailing-slash variant in result.url to simulate
        // redirects/server normalization — emit should strip it.
        return makeFetchOutput('https://docs.example.com/intro/', 'Intro', '# Intro', []);
      }
      return makeFetchOutput(url, '', '', []);
    });
    const rawFetch: RawFetchFn = vi.fn(async () => ({
      url: '', finalUrl: '', html: '', contentType: 'text/plain', statusCode: 200, method: 'http' as const, headers: {},
    }));

    const crawler = new Crawler(fetch, rawFetch);
    const result = await crawler.crawl({
      url: 'https://docs.example.com/intro',
      strategy: 'bfs',
      max_pages: 5,
      max_depth: 0,
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].url).toBe('https://docs.example.com/intro');
  });
});

describe('Crawler — adaptive cooldown wiring', () => {
  beforeEach(() => vi.restoreAllMocks());

  // Rebuild the EXACT fetchFn closure tools/crawl.ts hands the Crawler: it calls
  // the real handleFetch and, on a failure carrying an upstream status, spreads
  // r.http_status onto the crawler FetchOutput. Driving the real handleFetch (via
  // a mocked router.fetch returning a StageError) exercises the whole handoff —
  // router StageError → fetch.ts field copy → r.http_status → this closure →
  // Crawler → recordResponse — so a field-name regression in fetch.ts fails here
  // instead of passing on a fabricated FetchOutput.http_status.
  function crawlFetchFn(router: { fetch: ReturnType<typeof vi.fn> }): FetchFn {
    return async (url: string): Promise<FetchOutput> => {
      const r = await handleFetch(
        { url, include_full_markdown: true } as never,
        router as never,
      );
      if (!r.ok) {
        return {
          url,
          title: '',
          markdown: '',
          metadata: {},
          links: [],
          images: [],
          cached: false,
          error: r.error_reason,
          ...(typeof r.http_status === 'number' ? { http_status: r.http_status } : {}),
        };
      }
      return r.data;
    };
  }

  const rawFetchStub: RawFetchFn = vi.fn(async (): Promise<RawFetchResult> => ({
    url: '', finalUrl: '', html: '', contentType: 'text/plain',
    statusCode: 200, method: 'http' as const, headers: {},
  }));

  it('feeds a challenge-block 429 through the real handleFetch handoff into the limiter', async () => {
    const recordSpy = vi.spyOn(RateLimiter.prototype, 'recordResponse');

    // The router returns a challenge-block StageError carrying http_status — the
    // exact shape the anti-bot tier produces. handleFetch must copy that status
    // onto its { ok:false } envelope for the crawl cooldown to see it.
    const router = {
      fetch: vi.fn().mockResolvedValue({
        error: 'blocked_by_challenge',
        error_reason: 'Blocked by an anti-bot challenge',
        stage: 'fetch',
        http_status: 429,
      }),
    };

    const crawler = new Crawler(crawlFetchFn(router), rawFetchStub);
    await crawler.crawl({ url: 'https://blocked.example.com', strategy: 'bfs', max_depth: 0, max_pages: 1 });

    expect(recordSpy).toHaveBeenCalledWith('blocked.example.com', 429);
  });

  it('does not call recordResponse when the challenge-block carries no status', async () => {
    const recordSpy = vi.spyOn(RateLimiter.prototype, 'recordResponse');

    // A StageError with no numeric status (SSRF/validation, or a 2xx-served
    // challenge) must leave http_status unset all the way through.
    const router = {
      fetch: vi.fn().mockResolvedValue({
        error: 'blocked_by_challenge',
        error_reason: 'Blocked by an anti-bot challenge',
        stage: 'fetch',
      }),
    };

    const crawler = new Crawler(crawlFetchFn(router), rawFetchStub);
    await crawler.crawl({ url: 'https://nostatus.example.com', strategy: 'bfs', max_depth: 0, max_pages: 1 });

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('a recorded 429 grows the domain next wait (end-to-end effect)', () => {
    // Proves the limiter method the crawler wires into actually raises pace.
    const limiter = new RateLimiter({ jitterPct: 0, cooldownFactor: 2, cooldownMaxMs: 300000 });
    // base delay comes from the mocked config (crawlDelayMs 0), so use a real
    // delay via robots floor to make the multiplier observable.
    limiter.setRobotsCrawlDelay('blocked.example.com', 0.1); // 100ms floor
    limiter.registerDomain('https://blocked.example.com/a');
    const before = limiter.nextWaitMs('blocked.example.com', () => 0.5);
    limiter.recordResponse('blocked.example.com', 429);
    const after = limiter.nextWaitMs('blocked.example.com', () => 0.5);
    expect(after).toBeGreaterThan(before);
  });
});
