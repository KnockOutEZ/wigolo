import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/cache/store.js', () => ({
  getCachedContent: vi.fn().mockReturnValue(null),
  cacheContent: vi.fn(),
  isCacheUsable: vi.fn().mockReturnValue({ usable: false, stale: false }),
}));

import { handleFetch } from '../../../src/tools/fetch.js';
import type { SmartRouter } from '../../../src/fetch/router.js';

function makeRouter(opts: { statusCode: number; html: string; contentType: string }): SmartRouter {
  return {
    fetch: async () => ({
      url: 'https://raw.githubusercontent.com/foo/bar/main/README.md',
      finalUrl: 'https://raw.githubusercontent.com/foo/bar/main/README.md',
      html: opts.html,
      contentType: opts.contentType,
      statusCode: opts.statusCode,
      method: 'http' as const,
      headers: {},
    }),
  } as unknown as SmartRouter;
}

describe('fetch surfaces HTTP errors for plain-text endpoints', () => {
  it('returns http_404 error instead of treating "404: Not Found" as markdown content', async () => {
    const router = makeRouter({
      statusCode: 404,
      html: '404: Not Found',
      contentType: 'text/plain; charset=utf-8',
    });
    const result = await handleFetch(
      { url: 'https://raw.githubusercontent.com/foo/bar/main/README.md', force_refresh: true },
      router,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('http_404');
      expect(result.error_reason).toMatch(/HTTP 404/);
    }
  });

  it('still extracts HTML 404 landing pages (those often have useful content)', async () => {
    const router = makeRouter({
      statusCode: 404,
      html: '<html><body><h1>Page not found</h1><p>Try the docs index.</p></body></html>',
      contentType: 'text/html',
    });
    const result = await handleFetch(
      { url: 'https://example.com/missing', force_refresh: true },
      router,
    );
    // HTML 404 pages are usually a rendered "not found" page with useful
    // navigation — we extract them rather than erroring out.
    expect(result.ok).toBe(true);
  });
});
