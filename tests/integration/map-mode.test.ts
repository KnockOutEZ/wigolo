import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { mapUrls } from '../../src/crawl/mapper.js';

let server: Server;
let baseUrl: string;

// Multi-page site structure:
//
//   / (home) -> /docs, /about, /blog, https://external.com
//   /docs -> /docs/getting-started, /docs/api-reference
//   /docs/getting-started -> /docs, / (circular back)
//   /docs/api-reference -> /docs/api-reference/endpoints, /docs/api-reference/auth
//   /about -> / (back to home)
//   /blog -> /blog/post-1, /blog/post-2
//   /blog/post-1 -> /blog (circular back)
//   /hidden -> (exists in sitemap but not linked from any page)

const SITE_PAGES: Record<string, string> = {
  '/': `<!DOCTYPE html>
<html><head><title>Home</title></head><body>
  <nav>
    <a href="/docs">Docs</a>
    <a href="/about">About</a>
    <a href="/blog">Blog</a>
    <a href="https://external.com">External</a>
    <a href="javascript:void(0)">JS Link</a>
    <a href="mailto:hello@example.com">Email</a>
  </nav>
  <h1>Welcome</h1>
</body></html>`,

  '/docs': `<!DOCTYPE html>
<html><head><title>Docs</title></head><body>
  <a href="/docs/getting-started">Getting Started</a>
  <a href="/docs/api-reference">API Reference</a>
  <a href="/">Home</a>
</body></html>`,

  '/docs/getting-started': `<!DOCTYPE html>
<html><head><title>Getting Started</title></head><body>
  <a href="/docs">Back to Docs</a>
  <a href="/">Home</a>
  <p>Getting started guide content</p>
</body></html>`,

  '/docs/api-reference': `<!DOCTYPE html>
<html><head><title>API Reference</title></head><body>
  <a href="/docs/api-reference/endpoints">Endpoints</a>
  <a href="/docs/api-reference/auth">Auth</a>
  <a href="/docs">Back to Docs</a>
</body></html>`,

  '/docs/api-reference/endpoints': `<!DOCTYPE html>
<html><head><title>Endpoints</title></head><body>
  <a href="/docs/api-reference">Back</a>
  <p>Endpoint documentation</p>
</body></html>`,

  '/docs/api-reference/auth': `<!DOCTYPE html>
<html><head><title>Auth</title></head><body>
  <a href="/docs/api-reference">Back</a>
  <p>Auth documentation</p>
</body></html>`,

  '/about': `<!DOCTYPE html>
<html><head><title>About</title></head><body>
  <a href="/">Home</a>
  <p>About page</p>
</body></html>`,

  '/blog': `<!DOCTYPE html>
<html><head><title>Blog</title></head><body>
  <a href="/blog/post-1">Post 1</a>
  <a href="/blog/post-2">Post 2</a>
  <a href="/">Home</a>
</body></html>`,

  '/blog/post-1': `<!DOCTYPE html>
<html><head><title>Post 1</title></head><body>
  <a href="/blog">Back to Blog</a>
  <p>Blog post 1</p>
</body></html>`,

  '/blog/post-2': `<!DOCTYPE html>
<html><head><title>Post 2</title></head><body>
  <a href="/blog">Back to Blog</a>
  <p>Blog post 2</p>
</body></html>`,

  '/hidden': `<!DOCTYPE html>
<html><head><title>Hidden Page</title></head><body>
  <p>This page is only in the sitemap</p>
</body></html>`,
};

const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>{{BASE}}/</loc></url>
  <url><loc>{{BASE}}/docs</loc></url>
  <url><loc>{{BASE}}/docs/getting-started</loc></url>
  <url><loc>{{BASE}}/docs/api-reference</loc></url>
  <url><loc>{{BASE}}/about</loc></url>
  <url><loc>{{BASE}}/blog</loc></url>
  <url><loc>{{BASE}}/hidden</loc></url>
</urlset>`;

const ROBOTS_TXT = `User-agent: *
Allow: /
Sitemap: {{BASE}}/sitemap.xml`;

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';

  if (url === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(ROBOTS_TXT.replace(/\{\{BASE\}\}/g, baseUrl));
    return;
  }

  if (url === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    res.end(SITEMAP_XML.replace(/\{\{BASE\}\}/g, baseUrl));
    return;
  }

  const html = SITE_PAGES[url];
  if (html) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
}

async function createFetchFn() {
  return async (url: string) => {
    const resp = await fetch(url);
    const html = await resp.text();
    return { html, finalUrl: url, statusCode: resp.status };
  };
}

describe('Map Mode Integration', () => {
  beforeAll(async () => {
    server = createServer(handler);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('discovers all linked pages on the test site', async () => {
    const fetchFn = await createFetchFn();

    const result = await mapUrls(
      { url: baseUrl, max_depth: 4, max_pages: 50 },
      fetchFn,
    );

    // Should discover all pages that are reachable via links
    const paths = result.urls.map((u) => new URL(u).pathname);
    expect(paths).toContain('/');
    expect(paths).toContain('/docs');
    expect(paths).toContain('/docs/getting-started');
    expect(paths).toContain('/docs/api-reference');
    expect(paths).toContain('/docs/api-reference/endpoints');
    expect(paths).toContain('/docs/api-reference/auth');
    expect(paths).toContain('/about');
    expect(paths).toContain('/blog');
    expect(paths).toContain('/blog/post-1');
    expect(paths).toContain('/blog/post-2');

    // Hidden page is in sitemap, should be found
    expect(paths).toContain('/hidden');

    // External links should NOT be in results
    expect(result.urls.every((u) => u.startsWith(baseUrl))).toBe(true);

    expect(result.error).toBeUndefined();
  });

  it('finds sitemap URLs that are not linked from any page', async () => {
    const fetchFn = await createFetchFn();

    const result = await mapUrls(
      { url: baseUrl, max_depth: 4, max_pages: 50 },
      fetchFn,
    );

    expect(result.sitemap_found).toBe(true);
    // /hidden is only in sitemap, not linked from any page
    expect(result.urls.some((u) => u.includes('/hidden'))).toBe(true);
  });

  it('handles circular links without hanging', async () => {
    const fetchFn = await createFetchFn();

    // The site has circular links: home -> docs -> getting-started -> docs (and -> home)
    const result = await mapUrls(
      { url: baseUrl, max_depth: 10, max_pages: 50 },
      fetchFn,
    );

    // Should complete without timeout/hang
    expect(result.total_found).toBeGreaterThan(0);
    // Each URL should appear exactly once
    const uniqueUrls = new Set(result.urls);
    expect(uniqueUrls.size).toBe(result.urls.length);
  });

  it('respects max_depth to limit traversal', async () => {
    const fetchFn = await createFetchFn();

    const shallowResult = await mapUrls(
      { url: baseUrl, max_depth: 1, max_pages: 50 },
      fetchFn,
    );

    const deepResult = await mapUrls(
      { url: baseUrl, max_depth: 4, max_pages: 50 },
      fetchFn,
    );

    // Deeper crawl should find more or equal URLs
    expect(deepResult.total_found).toBeGreaterThanOrEqual(shallowResult.total_found);
  });

  it('respects max_pages to limit total discovery', async () => {
    const fetchFn = await createFetchFn();

    const result = await mapUrls(
      { url: baseUrl, max_depth: 4, max_pages: 5 },
      fetchFn,
    );

    expect(result.urls.length).toBeLessThanOrEqual(5);
  });

  it('filters with include_patterns', async () => {
    const fetchFn = await createFetchFn();

    const result = await mapUrls(
      { url: baseUrl, max_depth: 4, max_pages: 50, include_patterns: ['/docs'] },
      fetchFn,
    );

    const nonSeedUrls = result.urls.filter((u) => u !== baseUrl && u !== `${baseUrl}/`);
    expect(nonSeedUrls.length).toBeGreaterThan(0);
    expect(nonSeedUrls.every((u) => u.includes('/docs'))).toBe(true);
  });

  it('filters with exclude_patterns', async () => {
    const fetchFn = await createFetchFn();

    const result = await mapUrls(
      { url: baseUrl, max_depth: 4, max_pages: 50, exclude_patterns: ['/blog'] },
      fetchFn,
    );

    expect(result.urls.every((u) => !u.includes('/blog'))).toBe(true);
    // But should still find non-blog pages
    expect(result.urls.some((u) => u.includes('/docs'))).toBe(true);
  });

  it('returns no content — only URL strings', async () => {
    const fetchFn = await createFetchFn();

    const result = await mapUrls(
      { url: baseUrl, max_depth: 2, max_pages: 50 },
      fetchFn,
    );

    // Every entry in urls should be a string URL
    for (const url of result.urls) {
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^https?:\/\//);
    }

    // No content fields
    expect((result as any).pages).toBeUndefined();
    expect((result as any).markdown).toBeUndefined();
  });

  it('depth=0 only discovers links from seed page (no traversal)', async () => {
    const fetchFn = await createFetchFn();

    const result = await mapUrls(
      { url: baseUrl, max_depth: 0, max_pages: 50 },
      fetchFn,
    );

    // Seed page links to /docs, /about, /blog (and external which is filtered)
    // Plus sitemap URLs
    const paths = result.urls.map((u) => new URL(u).pathname);
    expect(paths).toContain('/');
    expect(paths).toContain('/docs');
    expect(paths).toContain('/about');
    expect(paths).toContain('/blog');

    // Deep pages should NOT be found via BFS (depth=0 means no traversal),
    // but may still be found via sitemap
  });
});
