/**
 * Integration coverage at the fetch tool boundary.
 *
 * Router-level unit tests are necessary but not sufficient. At least one path
 * must go through `handleFetch` end-to-end to verify the tuning works at the
 * user-facing boundary, not just in isolation.
 *
 * Regression case:
 *   - `render_js: never` returns in 146ms; default Playwright path on
 *     the same URL is 8.2s. The router must NOT escalate when the HTTP
 *     response carries substantive SSR content even if a shell-id /
 *     <noscript> warning is present.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleFetch } from '../../src/tools/fetch.js';
import { initDatabase, closeDatabase } from '../../src/cache/db.js';
import { resetConfig } from '../../src/config.js';
import { SmartRouter, type HttpClient, type BrowserPoolInterface } from '../../src/fetch/router.js';
import type { RawFetchResult } from '../../src/types.js';

const SSR_BODY_WITH_DEFENSIVE_NOSCRIPT = `
<html><head><title>SSR Article</title></head>
<body>
  <noscript>You need to enable JavaScript to run this app.</noscript>
  <main>
    <h1>Real Article</h1>
    <p>${'This article is fully SSR rendered, with hundreds of chars of visible body prose so the empty-content threshold is cleared comfortably. '.repeat(6)}</p>
  </main>
</body></html>
`.trim();

function makeBrowserResult(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: SSR_BODY_WITH_DEFENSIVE_NOSCRIPT,
    contentType: 'text/html; charset=utf-8',
    statusCode: 200,
    method: 'playwright',
    headers: {},
  };
}

describe('handleFetch — router tuning at the tool boundary', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  it('does not escalate to Playwright when SSR body is substantive even though <noscript> warns about JavaScript', async () => {
    const url = 'https://ssr-with-noscript.example/article';
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => ({
        url,
        finalUrl: url,
        html: SSR_BODY_WITH_DEFENSIVE_NOSCRIPT,
        contentType: 'text/html; charset=utf-8',
        statusCode: 200,
        headers: {},
      })),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async () => {
        throw new Error('Playwright must NOT be invoked: defensive <noscript> alongside substantive SSR body');
      }),
    };
    const router = new SmartRouter({ httpClient, browserPool });

    const out = await handleFetch({ url, force_refresh: true } as never, router);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data.fetch_method).toBe('http');
    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('passes a 429 + Retry-After response through the tool boundary without paying Playwright cold-start', async () => {
    const url = 'https://rate-limited.example/api';
    const httpClient: HttpClient = {
      fetch: vi.fn(async () => ({
        url,
        finalUrl: url,
        html: '<html><body>Too Many Requests</body></html>',
        contentType: 'text/html',
        statusCode: 429,
        headers: { 'retry-after': '120' },
      })),
    };
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (u: string) => makeBrowserResult(u)),
    };
    const router = new SmartRouter({ httpClient, browserPool });

    const out = await handleFetch({ url, force_refresh: true } as never, router);
    // The tool layer maps 429 with a short body to a stage error — that's fine,
    // the load-bearing assertion is that Playwright was not invoked.
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(httpClient.fetch).toHaveBeenCalledOnce();
    // If the tool reports a stage error, surface 429 in the message.
    if (!out.ok) {
      expect(out.error).toContain('429');
    }
  });
});
