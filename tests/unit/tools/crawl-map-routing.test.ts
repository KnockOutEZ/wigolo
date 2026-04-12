import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleCrawl } from '../../../src/tools/crawl.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';

function createMockRouter(pages: Record<string, string>): SmartRouter {
  return {
    fetch: vi.fn(async (url: string) => {
      const html = pages[url] ?? '';
      const statusCode = pages[url] !== undefined ? 200 : 404;
      return {
        url,
        finalUrl: url,
        html,
        contentType: 'text/html',
        statusCode,
        method: 'http' as const,
        headers: {},
      } as RawFetchResult;
    }),
    getDomainStats: vi.fn(),
  } as unknown as SmartRouter;
}

function htmlPage(links: string[]): string {
  const anchors = links.map((href) => `<a href="${href}">Link</a>`).join('\n');
  return `<html><body>${anchors}</body></html>`;
}

describe('handleCrawl strategy=map routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns MapOutput shape when strategy is map', async () => {
    const router = createMockRouter({
      'https://example.com': htmlPage(['/page1', '/page2']),
      'https://example.com/robots.txt': 'User-agent: *\nAllow: /',
    });

    const output = await handleCrawl(
      { url: 'https://example.com', strategy: 'map', max_depth: 1 },
      router,
    );

    // Map output has urls, total_found, sitemap_found — no pages array
    expect((output as any).urls).toBeDefined();
    expect((output as any).total_found).toBeGreaterThanOrEqual(1);
    expect((output as any).sitemap_found).toBeDefined();
    expect((output as any).pages).toBeUndefined();
  });

  it('uses HTTP-only fetch (renderJs: never) for map mode', async () => {
    const router = createMockRouter({
      'https://example.com': htmlPage(['/page1']),
    });

    await handleCrawl(
      { url: 'https://example.com', strategy: 'map', max_depth: 1 },
      router,
    );

    // Every call to router.fetch should use renderJs: 'never'
    const fetchCalls = (router.fetch as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of fetchCalls) {
      expect(call[1]).toEqual(expect.objectContaining({ renderJs: 'never' }));
    }
  });

  it('passes max_depth and max_pages to mapper', async () => {
    const router = createMockRouter({
      'https://example.com': htmlPage(
        Array.from({ length: 50 }, (_, i) => `/p${i}`),
      ),
    });

    const output = await handleCrawl(
      { url: 'https://example.com', strategy: 'map', max_depth: 1, max_pages: 5 },
      router,
    );

    expect((output as any).urls.length).toBeLessThanOrEqual(5);
  });

  it('passes include_patterns and exclude_patterns to mapper', async () => {
    const router = createMockRouter({
      'https://example.com': htmlPage(['/docs/intro', '/blog/post', '/docs/api']),
    });

    const output = await handleCrawl(
      {
        url: 'https://example.com',
        strategy: 'map',
        max_depth: 1,
        include_patterns: ['/docs/'],
        exclude_patterns: ['/api'],
      },
      router,
    );

    const urls = (output as any).urls as string[];
    const nonSeed = urls.filter((u: string) => u !== 'https://example.com');
    expect(nonSeed).toContain('https://example.com/docs/intro');
    expect(nonSeed).not.toContain('https://example.com/blog/post');
    expect(nonSeed).not.toContain('https://example.com/docs/api');
  });

  it('does not invoke Crawler class for map strategy', async () => {
    const router = createMockRouter({
      'https://example.com': htmlPage([]),
    });

    const output = await handleCrawl(
      { url: 'https://example.com', strategy: 'map', max_depth: 1 },
      router,
    );

    // Should get map result shape, not crawl result shape
    expect((output as any).urls).toBeDefined();
    expect((output as any).pages).toBeUndefined();
    expect((output as any).crawled).toBe(0);
  });

  it('returns error field when seed URL fails in map mode', async () => {
    const router = {
      fetch: vi.fn().mockRejectedValue(new Error('DNS resolution failed')),
      getDomainStats: vi.fn(),
    } as unknown as SmartRouter;

    const output = await handleCrawl(
      { url: 'https://nonexistent.example.com', strategy: 'map', max_depth: 1 },
      router,
    );

    expect((output as any).error).toBeDefined();
  });

  it('still routes bfs/dfs/sitemap to existing Crawler', async () => {
    // This test ensures the map routing doesn't break existing strategies.
    // We just verify that bfs doesn't return MapOutput shape.
    const router = createMockRouter({
      'https://example.com': htmlPage(['/page1']),
      'https://example.com/robots.txt': 'User-agent: *\nAllow: /',
    });

    // Need to mock handleFetch since Crawler uses it
    // For this test, just verify that bfs goes through different code path
    // by checking it returns pages array (even if empty due to mock limitations)
    const output = await handleCrawl(
      { url: 'https://example.com', strategy: 'bfs', max_depth: 1 },
      router,
    );

    expect(output.pages).toBeDefined();
    expect(Array.isArray(output.pages)).toBe(true);
  });
});
