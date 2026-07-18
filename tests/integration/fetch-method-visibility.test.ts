import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../../src/tools/fetch.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import { SmartRouter, type HttpClient, type BrowserPoolInterface } from '../../src/fetch/router.js';
import type { RawFetchResult } from '../../src/types.js';

const FULL_HTML = `
<html><head><title>Article</title></head>
<body>
  <main>
    <h1>Real Content</h1>
    <p>${'This page has substantial article content to clear the empty-content threshold. '.repeat(8)}</p>
  </main>
</body></html>
`.trim();

function makeHttpResult(): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url: 'https://method-test.example/page',
    finalUrl: 'https://method-test.example/page',
    html: FULL_HTML,
    contentType: 'text/html; charset=utf-8',
    statusCode: 200,
    headers: {},
  };
}

function makeBrowserResult(url = 'https://method-test.example/page'): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: FULL_HTML,
    contentType: 'text/html; charset=utf-8',
    statusCode: 200,
    method: 'browser',
    headers: {},
  };
}

describe('handleFetch: fetch_method visibility', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  it('tags fetch_method="http" on a fresh HTTP fetch', async () => {
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult()) };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async () => { throw new Error('should not call browser'); }),
    };
    const router = new SmartRouter({ httpClient, browserPool });

    const url = 'https://method-test.example/page';
    const out = await handleFetch({ url, force_refresh: true } as any, router);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.fetch_method).toBe('http');
  });

  it('tags fetch_method="cache" when a fetch is served from cache', async () => {
    const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult()) };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async () => { throw new Error('should not call browser'); }),
    };
    const router = new SmartRouter({ httpClient, browserPool });

    const url = 'https://method-test.example/page';

    // First fetch populates cache
    const first = await handleFetch({ url, force_refresh: true } as any, router);
    expect(first.ok).toBe(true);

    // Second fetch (no force_refresh) should hit cache
    const second = await handleFetch({ url } as any, router);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.cached).toBe(true);
    expect(second.data.fetch_method).toBe('cache');
  });

  it('tags fetch_method="browser" when a fetch routes through the browser', async () => {
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => { throw new Error('should not call http'); }),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (u: string) => makeBrowserResult(u)),
    };
    const router = new SmartRouter({ httpClient, browserPool });

    const url = 'https://method-test.example/page';
    const out = await handleFetch({ url, render_js: 'always', force_refresh: true } as any, router);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.fetch_method).toBe('browser');
  });
});
