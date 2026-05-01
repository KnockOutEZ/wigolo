import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

import { SmartRouter } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';

const SPA_SHELL_HTML = `<html><head></head><body><div id="root"></div></body></html>`;

function makeBrowserResult(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body><p>real content here</p></body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'playwright',
    headers: {},
  };
}

describe('SmartRouter mode=fast', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let router: SmartRouter;

  beforeEach(() => {
    resetConfig();
    httpClient = {
      fetch: vi.fn(async (url: string) => ({
        url,
        finalUrl: url,
        html: SPA_SHELL_HTML,
        contentType: 'text/html',
        statusCode: 200,
        headers: {},
      })),
    };
    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };
    router = new SmartRouter(httpClient, browserPool);
  });

  afterEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });

  it('does not spawn a browser even when content is a SPA shell', async () => {
    const result = await router.fetch('https://spa.test/page', { mode: 'fast' });

    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
    expect(result.jsRequired).toBe(true);
  });

  it('passes the fast timeout to the http client', async () => {
    await router.fetch('https://spa.test/page', { mode: 'fast' });

    expect(httpClient.fetch).toHaveBeenCalledWith(
      'https://spa.test/page',
      expect.objectContaining({ timeoutMs: 800 }),
    );
  });

  it('does not set jsRequired when content is rich', async () => {
    httpClient.fetch = vi.fn(async (url: string) => ({
      url,
      finalUrl: url,
      html: `<html><body><p>${'this is real prose with enough text to clear the threshold. '.repeat(10)}</p></body></html>`,
      contentType: 'text/html',
      statusCode: 200,
      headers: {},
    }));

    const result = await router.fetch('https://example.com/page', { mode: 'fast' });

    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.jsRequired).toBe(false);
  });
});
