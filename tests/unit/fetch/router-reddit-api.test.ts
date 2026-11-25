import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

// Mock the reddit-api module so the router test never mints a real token or
// touches the network. isRedditUrl must keep its real behavior (the router
// gates on it), so we re-export the real one and only stub the fetch fn.
const { fetchViaRedditApiMock } = vi.hoisted(() => ({ fetchViaRedditApiMock: vi.fn() }));
vi.mock('../../../src/fetch/reddit-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/reddit-api.js')>();
  return {
    ...actual,
    fetchViaRedditApi: fetchViaRedditApiMock,
  };
});

import { SmartRouter } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import { RedditRateLimitError } from '../../../src/fetch/reddit-api.js';

function httpResult(url = 'https://www.reddit.com/r/rust'): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url,
    finalUrl: url,
    html: '<html><body>blocked by network security</body></html>',
    contentType: 'text/html',
    statusCode: 403,
    headers: {},
  };
}

const REDDIT_API_RESULT: RawFetchResult = {
  url: 'https://www.reddit.com/r/rust',
  finalUrl: 'https://www.reddit.com/r/rust',
  html: '# r/rust\n\n- a post',
  contentType: 'text/markdown',
  statusCode: 200,
  method: 'reddit-api',
  headers: {},
};

describe('SmartRouter — reddit-api routing', () => {
  const originalEnv = process.env;
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let router: SmartRouter;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_REDDIT_CLIENT_ID;
    delete process.env.WIGOLO_REDDIT_CLIENT_SECRET;
    fetchViaRedditApiMock.mockReset();
    fetchViaRedditApiMock.mockResolvedValue(REDDIT_API_RESULT);
    resetConfig();

    httpClient = { fetch: vi.fn(async () => httpResult()) };
    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => ({
        url,
        finalUrl: url,
        html: '<html><body>x</body></html>',
        contentType: 'text/html',
        statusCode: 200,
        method: 'browser' as const,
        headers: {},
      })),
    };
    router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('routes reddit URLs to the API when credentials are configured', async () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid';
    process.env.WIGOLO_REDDIT_CLIENT_SECRET = 'secret';
    resetConfig();

    const result = await router.fetch('https://www.reddit.com/r/rust');
    expect(fetchViaRedditApiMock).toHaveBeenCalledOnce();
    expect(result.method).toBe('reddit-api');
    // The honest block path (http/browser) was never touched.
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('does NOT route to the API when credentials are absent (falls through to normal ladder)', async () => {
    // No reddit env vars set.
    const result = await router.fetch('https://www.reddit.com/r/rust');
    expect(fetchViaRedditApiMock).not.toHaveBeenCalled();
    expect(httpClient.fetch).toHaveBeenCalled();
    expect(result.method).not.toBe('reddit-api');
  });

  it('never routes a non-reddit URL to the API even with creds configured', async () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid';
    process.env.WIGOLO_REDDIT_CLIENT_SECRET = 'secret';
    resetConfig();
    httpClient = {
      fetch: vi.fn(async () => ({
        url: 'https://example.com',
        finalUrl: 'https://example.com',
        html: '<html><body>hello world this is real content that passes the empty check nicely</body></html>',
        contentType: 'text/html',
        statusCode: 200,
        headers: {},
      })),
    };
    router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });

    const result = await router.fetch('https://example.com');
    expect(fetchViaRedditApiMock).not.toHaveBeenCalled();
    expect(result.method).not.toBe('reddit-api');
  });

  it('falls through to the normal ladder when the API path returns null (unsupported shape)', async () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid';
    process.env.WIGOLO_REDDIT_CLIENT_SECRET = 'secret';
    resetConfig();
    fetchViaRedditApiMock.mockResolvedValue(null);

    const result = await router.fetch('https://www.reddit.com/r/rust');
    expect(fetchViaRedditApiMock).toHaveBeenCalledOnce();
    expect(httpClient.fetch).toHaveBeenCalled();
    expect(result.method).not.toBe('reddit-api');
  });

  it('falls through to the normal ladder when the API path throws', async () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid';
    process.env.WIGOLO_REDDIT_CLIENT_SECRET = 'secret';
    resetConfig();
    fetchViaRedditApiMock.mockRejectedValue(new Error('token failed'));

    const result = await router.fetch('https://www.reddit.com/r/rust');
    expect(httpClient.fetch).toHaveBeenCalled();
    expect(result.method).not.toBe('reddit-api');
  });

  it('falls through to the normal ladder when the API path rate-limits (429)', async () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid';
    process.env.WIGOLO_REDDIT_CLIENT_SECRET = 'secret';
    resetConfig();
    // Distinct from the generic-Error case: a RedditRateLimitError should be
    // info-logged and swallowed by tryRedditApi (returns null), so the router
    // continues down the normal ladder rather than surfacing the rate limit.
    fetchViaRedditApiMock.mockRejectedValue(new RedditRateLimitError(120));

    const result = await router.fetch('https://www.reddit.com/r/rust');
    expect(fetchViaRedditApiMock).toHaveBeenCalledOnce();
    expect(httpClient.fetch).toHaveBeenCalled();
    expect(result.method).not.toBe('reddit-api');
  });

  it('does not route to the API for a screenshot request (API cannot serve it)', async () => {
    process.env.WIGOLO_REDDIT_CLIENT_ID = 'cid';
    process.env.WIGOLO_REDDIT_CLIENT_SECRET = 'secret';
    resetConfig();

    await router.fetch('https://www.reddit.com/r/rust', { screenshot: true, renderJs: 'always' });
    expect(fetchViaRedditApiMock).not.toHaveBeenCalled();
    expect(browserPool.fetchWithBrowser).toHaveBeenCalled();
  });
});
