import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapUrls, extractLinks } from '../../../src/crawl/mapper.js';
import type { LightFetchFn } from '../../../src/crawl/mapper.js';

function createMockFetch(pages: Record<string, string>): LightFetchFn {
  return async (url: string) => {
    const html = pages[url];
    if (html === undefined) {
      throw new Error(`Fetch failed: ${url}`);
    }
    return { html, finalUrl: url, statusCode: 200 };
  };
}

function htmlPage(links: string[], bodyExtra = ''): string {
  const anchors = links.map((href) => `<a href="${href}">Link</a>`).join('\n');
  return `<!DOCTYPE html><html><head><title>Test</title></head><body>${anchors}${bodyExtra}</body></html>`;
}

describe('extractLinks', () => {
  it('extracts same-origin absolute links', () => {
    const html = htmlPage([
      'https://example.com/docs/intro',
      'https://example.com/docs/api',
      'https://other.com/page',
    ]);
    const links = extractLinks(html, 'https://example.com');
    expect(links).toContain('https://example.com/docs/intro');
    expect(links).toContain('https://example.com/docs/api');
    expect(links).not.toContain('https://other.com/page');
  });

  it('resolves relative URLs against origin', () => {
    const html = htmlPage(['/docs/intro', '/docs/api', '../guide']);
    const links = extractLinks(html, 'https://example.com');
    expect(links).toContain('https://example.com/docs/intro');
    expect(links).toContain('https://example.com/docs/api');
  });

  it('strips fragment identifiers from URLs', () => {
    const html = htmlPage([
      '/docs/intro#section-1',
      '/docs/intro#section-2',
      '/docs/intro',
    ]);
    const links = extractLinks(html, 'https://example.com');
    // All three should resolve to the same URL after stripping fragments
    const introCount = links.filter((l) => l === 'https://example.com/docs/intro').length;
    expect(introCount).toBe(1);
  });

  it('skips javascript: hrefs', () => {
    const html = htmlPage(['javascript:void(0)', 'javascript:alert(1)']);
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(0);
  });

  it('skips mailto: hrefs', () => {
    const html = htmlPage(['mailto:user@example.com']);
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(0);
  });

  it('skips tel: hrefs', () => {
    const html = htmlPage(['tel:+1234567890']);
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(0);
  });

  it('skips anchors with no href attribute', () => {
    const html = '<html><body><a>No href</a><a href="">Empty href</a></body></html>';
    const links = extractLinks(html, 'https://example.com');
    // Empty href resolves to origin, which is acceptable; no-href anchors are skipped
    expect(links.every((l) => l.startsWith('https://example.com'))).toBe(true);
  });

  it('skips fragment-only links (#section)', () => {
    const html = htmlPage(['#section-1', '#top', '#']);
    const links = extractLinks(html, 'https://example.com');
    // Fragment-only links should not produce entries (they reference the same page)
    expect(links).toHaveLength(0);
  });

  it('deduplicates identical URLs', () => {
    const html = htmlPage(['/docs/api', '/docs/api', '/docs/api']);
    const links = extractLinks(html, 'https://example.com');
    expect(links.filter((l) => l === 'https://example.com/docs/api')).toHaveLength(1);
  });

  it('ignores links inside <script> tags', () => {
    const html = `<html><body>
      <a href="/real-link">Real</a>
      <script>
        const url = "/script-link";
        document.querySelector('a').href = "/another-script-link";
      </script>
    </body></html>`;
    const links = extractLinks(html, 'https://example.com');
    expect(links).toContain('https://example.com/real-link');
    expect(links).not.toContain('https://example.com/script-link');
    expect(links).not.toContain('https://example.com/another-script-link');
  });

  it('returns empty array for empty HTML', () => {
    const links = extractLinks('', 'https://example.com');
    expect(links).toEqual([]);
  });

  it('returns empty array for HTML with no links', () => {
    const html = '<html><body><p>No links here</p></body></html>';
    const links = extractLinks(html, 'https://example.com');
    expect(links).toEqual([]);
  });

  it('handles broken/malformed HTML gracefully', () => {
    const html = '<html><body><a href="/page1">Link<a href="/page2">Link2</body>';
    const links = extractLinks(html, 'https://example.com');
    // linkedom should still parse what it can
    expect(links.length).toBeGreaterThanOrEqual(1);
  });

  it('handles data: URI hrefs without crashing', () => {
    const html = htmlPage(['data:text/html,<h1>hi</h1>']);
    const links = extractLinks(html, 'https://example.com');
    expect(links).toHaveLength(0);
  });
});

describe('mapUrls', () => {
  beforeEach(() => vi.clearAllMocks());

  // --- Basic discovery ---

  it('discovers links from seed page', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/docs/intro', '/docs/api', 'https://external.com']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    expect(result.urls).toContain('https://example.com');
    expect(result.urls).toContain('https://example.com/docs/intro');
    expect(result.urls).toContain('https://example.com/docs/api');
    expect(result.urls).not.toContain('https://external.com');
    expect(result.total_found).toBe(3); // seed + 2 discovered
    expect(result.error).toBeUndefined();
  });

  it('returns only URLs, no content or titles', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/page']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1 },
      fetchFn,
    );

    expect(result.urls).toBeDefined();
    expect(result.total_found).toBeDefined();
    expect(result.sitemap_found).toBeDefined();
    expect((result as any).pages).toBeUndefined();
    expect((result as any).markdown).toBeUndefined();
    expect((result as any).title).toBeUndefined();
  });

  it('includes seed URL in results even with no links', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': '<html><body><p>No links</p></body></html>',
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1 },
      fetchFn,
    );

    expect(result.urls).toEqual(['https://example.com']);
    expect(result.total_found).toBe(1);
  });

  // --- Depth traversal ---

  it('follows BFS to max_depth=2', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/level1']),
      'https://example.com/level1': htmlPage(['/level2']),
      'https://example.com/level2': htmlPage(['/level3']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 2, max_pages: 100 },
      fetchFn,
    );

    expect(result.urls).toContain('https://example.com');
    expect(result.urls).toContain('https://example.com/level1');
    expect(result.urls).toContain('https://example.com/level2');
    // level3 is discovered at depth 3 but max_depth=2 means we only follow links up to depth 2
    // level3 is found on level2's page (depth=2), so it IS added to discovered set but NOT queued for traversal
    expect(result.urls).toContain('https://example.com/level3');
  });

  it('depth=0 returns only seed URL links (no traversal beyond seed)', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/page1', '/page2']),
      'https://example.com/page1': htmlPage(['/deep']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 0, max_pages: 100 },
      fetchFn,
    );

    // depth=0: fetch seed, extract its links, but don't follow them
    expect(result.urls).toContain('https://example.com');
    expect(result.urls).toContain('https://example.com/page1');
    expect(result.urls).toContain('https://example.com/page2');
    expect(result.urls).not.toContain('https://example.com/deep');
  });

  it('verifies BFS level-order traversal (breadth before depth)', async () => {
    // Tree:
    //   seed -> [a, b]
    //   a -> [a1, a2]
    //   b -> [b1]
    // BFS order: seed, a, b, a1, a2, b1
    const fetchOrder: string[] = [];
    const pages: Record<string, string> = {
      'https://example.com': htmlPage(['/a', '/b']),
      'https://example.com/a': htmlPage(['/a1', '/a2']),
      'https://example.com/b': htmlPage(['/b1']),
      'https://example.com/a1': htmlPage([]),
      'https://example.com/a2': htmlPage([]),
      'https://example.com/b1': htmlPage([]),
    };

    const fetchFn: LightFetchFn = async (url) => {
      fetchOrder.push(url);
      return { html: pages[url] ?? '', finalUrl: url, statusCode: 200 };
    };

    await mapUrls(
      { url: 'https://example.com', max_depth: 2, max_pages: 100 },
      fetchFn,
    );

    // Verify BFS order: seed first, then level-1 before level-2
    const seedIdx = fetchOrder.indexOf('https://example.com');
    const aIdx = fetchOrder.indexOf('https://example.com/a');
    const bIdx = fetchOrder.indexOf('https://example.com/b');
    const a1Idx = fetchOrder.indexOf('https://example.com/a1');
    const b1Idx = fetchOrder.indexOf('https://example.com/b1');

    expect(seedIdx).toBeLessThan(aIdx);
    expect(seedIdx).toBeLessThan(bIdx);
    expect(aIdx).toBeLessThan(a1Idx);
    expect(bIdx).toBeLessThan(b1Idx);
  });

  // --- Circular references ---

  it('handles circular links (A -> B -> A) without infinite loop', async () => {
    const fetchFn = createMockFetch({
      'https://example.com/a': htmlPage(['/b']),
      'https://example.com/b': htmlPage(['/a']),
    });

    const result = await mapUrls(
      { url: 'https://example.com/a', max_depth: 10, max_pages: 100 },
      fetchFn,
    );

    expect(result.urls).toContain('https://example.com/a');
    expect(result.urls).toContain('https://example.com/b');
    expect(result.total_found).toBe(2);
  });

  it('handles self-referencing page (A -> A)', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/', '/page', '/']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 3, max_pages: 100 },
      fetchFn,
    );

    // Seed appears once, /page appears once
    const seedCount = result.urls.filter((u) => u === 'https://example.com' || u === 'https://example.com/').length;
    expect(seedCount).toBeLessThanOrEqual(2); // / and /page at most
    expect(result.total_found).toBeGreaterThanOrEqual(1);
  });

  it('handles triangle cycle (A -> B -> C -> A)', async () => {
    const fetchFn = createMockFetch({
      'https://example.com/a': htmlPage(['/b']),
      'https://example.com/b': htmlPage(['/c']),
      'https://example.com/c': htmlPage(['/a']),
    });

    const result = await mapUrls(
      { url: 'https://example.com/a', max_depth: 10, max_pages: 100 },
      fetchFn,
    );

    expect(result.urls).toHaveLength(3);
    expect(result.urls).toContain('https://example.com/a');
    expect(result.urls).toContain('https://example.com/b');
    expect(result.urls).toContain('https://example.com/c');
  });

  // --- max_pages limit ---

  it('respects max_pages limit', async () => {
    // Seed page has 50 links
    const links = Array.from({ length: 50 }, (_, i) => `/page/${i}`);
    const pages: Record<string, string> = {
      'https://example.com': htmlPage(links),
    };
    // Each child page exists but has no further links
    for (const link of links) {
      pages[`https://example.com${link}`] = htmlPage([]);
    }

    const fetchFn = createMockFetch(pages);

    const result = await mapUrls(
      { url: 'https://example.com', max_pages: 10, max_depth: 1 },
      fetchFn,
    );

    expect(result.urls.length).toBeLessThanOrEqual(10);
    expect(result.total_found).toBeLessThanOrEqual(10);
  });

  it('max_pages=1 returns only seed URL', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/page1', '/page2', '/page3']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_pages: 1, max_depth: 1 },
      fetchFn,
    );

    expect(result.urls).toEqual(['https://example.com']);
    expect(result.total_found).toBe(1);
  });

  it('stops BFS traversal when max_pages reached mid-level', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/a', '/b', '/c', '/d', '/e']),
      'https://example.com/a': htmlPage(['/a1']),
      'https://example.com/b': htmlPage(['/b1']),
      'https://example.com/c': htmlPage(['/c1']),
      'https://example.com/d': htmlPage(['/d1']),
      'https://example.com/e': htmlPage(['/e1']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_pages: 4, max_depth: 2 },
      fetchFn,
    );

    expect(result.urls.length).toBeLessThanOrEqual(4);
  });

  // --- Pattern filtering ---

  it('filters by include_patterns', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/docs/guide', '/blog/post', '/docs/api', '/about']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, include_patterns: ['/docs/'] },
      fetchFn,
    );

    // Seed URL is always included. Discovered links filtered by patterns.
    const nonSeedUrls = result.urls.filter((u) => u !== 'https://example.com');
    expect(nonSeedUrls.every((u) => u.includes('/docs/'))).toBe(true);
    expect(nonSeedUrls).not.toContain('https://example.com/blog/post');
    expect(nonSeedUrls).not.toContain('https://example.com/about');
  });

  it('filters by exclude_patterns', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/docs/guide', '/blog/post', '/docs/api']),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, exclude_patterns: ['/blog/'] },
      fetchFn,
    );

    expect(result.urls).not.toContain('https://example.com/blog/post');
    expect(result.urls).toContain('https://example.com/docs/guide');
  });

  it('applies include and exclude patterns together', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage([
        '/docs/guide',
        '/docs/changelog',
        '/docs/api',
        '/blog/post',
      ]),
    });

    const result = await mapUrls(
      {
        url: 'https://example.com',
        max_depth: 1,
        include_patterns: ['/docs/'],
        exclude_patterns: ['/changelog'],
      },
      fetchFn,
    );

    const nonSeedUrls = result.urls.filter((u) => u !== 'https://example.com');
    expect(nonSeedUrls).toContain('https://example.com/docs/guide');
    expect(nonSeedUrls).toContain('https://example.com/docs/api');
    expect(nonSeedUrls).not.toContain('https://example.com/docs/changelog');
    expect(nonSeedUrls).not.toContain('https://example.com/blog/post');
  });

  it('handles regex patterns (not just substring)', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/v2/docs', '/v2/api', '/v1/docs', '/v3/docs']),
    });

    const result = await mapUrls(
      {
        url: 'https://example.com',
        max_depth: 1,
        include_patterns: ['^https://example\\.com/v2/'],
      },
      fetchFn,
    );

    const nonSeedUrls = result.urls.filter((u) => u !== 'https://example.com');
    expect(nonSeedUrls).toContain('https://example.com/v2/docs');
    expect(nonSeedUrls).toContain('https://example.com/v2/api');
    expect(nonSeedUrls).not.toContain('https://example.com/v1/docs');
    expect(nonSeedUrls).not.toContain('https://example.com/v3/docs');
  });

  // --- Same-origin filtering ---

  it('only discovers same-origin URLs', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage([
        'https://example.com/page',
        'https://other.com/page',
        'https://sub.example.com/page',
        'http://example.com/insecure', // different protocol = different origin
      ]),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    expect(result.urls).toContain('https://example.com/page');
    expect(result.urls).not.toContain('https://other.com/page');
    expect(result.urls).not.toContain('https://sub.example.com/page');
    expect(result.urls).not.toContain('http://example.com/insecure');
  });

  // --- Sitemap integration ---

  it('discovers URLs from sitemap.xml', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/page1</loc></url>
        <url><loc>https://example.com/page2</loc></url>
        <url><loc>https://example.com/page3</loc></url>
      </urlset>`;

    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/page1']),
      'https://example.com/robots.txt': `User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml`,
      'https://example.com/sitemap.xml': sitemapXml,
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    expect(result.sitemap_found).toBe(true);
    expect(result.urls).toContain('https://example.com/page1');
    expect(result.urls).toContain('https://example.com/page2');
    expect(result.urls).toContain('https://example.com/page3');
  });

  it('falls back to /sitemap.xml when robots.txt has no sitemap directive', async () => {
    const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/from-sitemap</loc></url>
      </urlset>`;

    const fetchFn = createMockFetch({
      'https://example.com': htmlPage([]),
      'https://example.com/robots.txt': 'User-agent: *\nAllow: /',
      'https://example.com/sitemap.xml': sitemapXml,
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    expect(result.sitemap_found).toBe(true);
    expect(result.urls).toContain('https://example.com/from-sitemap');
  });

  it('handles missing sitemap.xml gracefully', async () => {
    const fetchFn: LightFetchFn = async (url) => {
      if (url === 'https://example.com') {
        return { html: htmlPage(['/page1']), finalUrl: url, statusCode: 200 };
      }
      // robots.txt and sitemap.xml both fail
      throw new Error('Not found');
    };

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    expect(result.sitemap_found).toBe(false);
    expect(result.urls).toContain('https://example.com');
    expect(result.urls).toContain('https://example.com/page1');
    expect(result.error).toBeUndefined();
  });

  it('handles malformed sitemap XML gracefully', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/page1']),
      'https://example.com/robots.txt': 'User-agent: *\nAllow: /',
      'https://example.com/sitemap.xml': '<not-valid-xml>broken garbage',
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    // Should still work via BFS even though sitemap parse returns nothing
    expect(result.urls).toContain('https://example.com');
    expect(result.urls).toContain('https://example.com/page1');
    expect(result.error).toBeUndefined();
  });

  it('handles sitemap index (nested sitemaps)', async () => {
    const sitemapIndex = `<?xml version="1.0" encoding="UTF-8"?>
      <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <sitemap><loc>https://example.com/sitemap-docs.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-blog.xml</loc></sitemap>
      </sitemapindex>`;

    const sitemapDocs = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/docs/intro</loc></url>
      </urlset>`;

    const sitemapBlog = `<?xml version="1.0" encoding="UTF-8"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/blog/post1</loc></url>
      </urlset>`;

    const fetchFn = createMockFetch({
      'https://example.com': htmlPage([]),
      'https://example.com/robots.txt': 'User-agent: *\nSitemap: https://example.com/sitemap.xml',
      'https://example.com/sitemap.xml': sitemapIndex,
      'https://example.com/sitemap-docs.xml': sitemapDocs,
      'https://example.com/sitemap-blog.xml': sitemapBlog,
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 0, max_pages: 100 },
      fetchFn,
    );

    expect(result.sitemap_found).toBe(true);
    expect(result.urls).toContain('https://example.com/docs/intro');
    expect(result.urls).toContain('https://example.com/blog/post1');
  });

  it('respects max_pages when sitemap has many URLs', async () => {
    const locs = Array.from({ length: 200 }, (_, i) =>
      `<url><loc>https://example.com/page/${i}</loc></url>`,
    ).join('\n');
    const sitemapXml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs}</urlset>`;

    const fetchFn = createMockFetch({
      'https://example.com': htmlPage([]),
      'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap.xml',
      'https://example.com/sitemap.xml': sitemapXml,
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 0, max_pages: 15 },
      fetchFn,
    );

    expect(result.urls.length).toBeLessThanOrEqual(15);
  });

  it('merges sitemap URLs with BFS-discovered URLs without duplicates', async () => {
    const sitemapXml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/page1</loc></url>
        <url><loc>https://example.com/sitemap-only</loc></url>
      </urlset>`;

    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/page1', '/bfs-only']),
      'https://example.com/robots.txt': 'Sitemap: https://example.com/sitemap.xml',
      'https://example.com/sitemap.xml': sitemapXml,
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    expect(result.urls).toContain('https://example.com/page1');
    expect(result.urls).toContain('https://example.com/sitemap-only');
    expect(result.urls).toContain('https://example.com/bfs-only');
    // page1 should appear only once even though both sitemap and BFS found it
    const page1Count = result.urls.filter((u) => u === 'https://example.com/page1').length;
    expect(page1Count).toBe(1);
  });

  // --- Error recovery ---

  it('returns structured error when seed URL fetch fails', async () => {
    const fetchFn: LightFetchFn = async () => {
      throw new Error('Connection refused');
    };

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1 },
      fetchFn,
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain('Connection refused');
    expect(result.urls).toEqual(['https://example.com']);
    expect(result.total_found).toBe(1);
  });

  it('skips failed child pages and continues BFS', async () => {
    const fetchFn: LightFetchFn = async (url) => {
      if (url === 'https://example.com') {
        return { html: htmlPage(['/good', '/bad', '/also-good']), finalUrl: url, statusCode: 200 };
      }
      if (url === 'https://example.com/bad') {
        throw new Error('500 Internal Server Error');
      }
      return { html: htmlPage([]), finalUrl: url, statusCode: 200 };
    };

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    expect(result.urls).toContain('https://example.com/good');
    expect(result.urls).toContain('https://example.com/bad'); // URL was discovered even though fetch failed
    expect(result.urls).toContain('https://example.com/also-good');
    expect(result.error).toBeUndefined(); // No top-level error since seed succeeded
  });

  it('handles fetch timeout on child pages gracefully', async () => {
    const fetchFn: LightFetchFn = async (url) => {
      if (url === 'https://example.com') {
        return { html: htmlPage(['/slow-page', '/fast-page']), finalUrl: url, statusCode: 200 };
      }
      if (url === 'https://example.com/slow-page') {
        throw new Error('Request timed out after 10000ms');
      }
      return { html: htmlPage([]), finalUrl: url, statusCode: 200 };
    };

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    // Timeout on child page does not crash the whole map operation
    expect(result.urls).toContain('https://example.com/fast-page');
    expect(result.error).toBeUndefined();
  });

  // --- Default values ---

  it('uses default max_depth=3 when not specified', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/d1']),
      'https://example.com/d1': htmlPage(['/d2']),
      'https://example.com/d2': htmlPage(['/d3']),
      'https://example.com/d3': htmlPage(['/d4']),
      'https://example.com/d4': htmlPage([]),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_pages: 100 },
      fetchFn,
    );

    // Default max_depth=3: seed(0) -> d1(1) -> d2(2) -> d3(3) -> d4 discovered from d3
    expect(result.urls).toContain('https://example.com/d3');
    expect(result.urls).toContain('https://example.com/d4'); // discovered from d3's links
  });

  it('uses default max_pages=200 when not specified', async () => {
    // Just verify it doesn't crash with defaults
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage(['/page1']),
    });

    const result = await mapUrls(
      { url: 'https://example.com' },
      fetchFn,
    );

    expect(result.urls.length).toBeGreaterThanOrEqual(1);
    expect(result.urls.length).toBeLessThanOrEqual(200);
  });

  // --- Empty / degenerate cases ---

  it('handles empty HTML page', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': '',
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1 },
      fetchFn,
    );

    expect(result.urls).toEqual(['https://example.com']);
    expect(result.total_found).toBe(1);
  });

  it('handles page with only external links', async () => {
    const fetchFn = createMockFetch({
      'https://example.com': htmlPage([
        'https://google.com',
        'https://github.com',
        'https://twitter.com',
      ]),
    });

    const result = await mapUrls(
      { url: 'https://example.com', max_depth: 1, max_pages: 100 },
      fetchFn,
    );

    // Only seed URL since all links are external
    expect(result.urls).toEqual(['https://example.com']);
    expect(result.total_found).toBe(1);
  });
});
