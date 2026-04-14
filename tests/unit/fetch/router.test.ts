import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// We import SmartRouter dynamically after mocking auth to avoid real fs checks
// Auth mock — getAuthOptions returns null by default
vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

import { SmartRouter } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import { getAuthOptions } from '../../../src/fetch/auth.js';

const FULL_HTML = `
<html><head><title>Test</title></head>
<body>
  <p>${'This is real content that is long enough to pass the empty check. '.repeat(5)}</p>
</body></html>
`.trim();

// SPA shell that contentAppearsEmpty() detects as empty
const SPA_SHELL_HTML = `<html><head></head><body><div id="root"></div></body></html>`;

function makeHttpResult(html = FULL_HTML): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    html,
    contentType: 'text/html',
    statusCode: 200,
    headers: {},
  };
}

function makeBrowserResult(url = 'https://example.com/page'): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: FULL_HTML,
    contentType: 'text/html',
    statusCode: 200,
    method: 'playwright',
    headers: {},
  };
}

describe('SmartRouter', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let router: SmartRouter;

  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
    resetConfig();

    httpClient = {
      fetch: vi.fn(async () => makeHttpResult()),
    };

    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };

    router = new SmartRouter(httpClient, browserPool);

    vi.mocked(getAuthOptions).mockResolvedValue(null);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('routes to HTTP by default for unknown domains', async () => {
    const result = await router.fetch('https://example.com/page');

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('routes to Playwright when render_js is "always"', async () => {
    const result = await router.fetch('https://example.com/page', { renderJs: 'always' });

    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('routes to HTTP only when render_js is "never"', async () => {
    const result = await router.fetch('https://example.com/page', { renderJs: 'never' });

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('does not fall back to Playwright when render_js is "never" and HTTP fails', async () => {
    vi.mocked(httpClient.fetch).mockRejectedValue(new Error('Network error'));

    await expect(router.fetch('https://example.com/page', { renderJs: 'never' })).rejects.toThrow('Network error');
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('falls back to Playwright after BROWSER_FALLBACK_THRESHOLD HTTP failures for a domain', async () => {
    vi.mocked(httpClient.fetch).mockRejectedValue(new Error('Connection refused'));

    const threshold = 3;

    // First (threshold - 1) calls should fail with HTTP error
    for (let i = 0; i < threshold - 1; i++) {
      await expect(router.fetch(`https://failing.com/page${i}`)).rejects.toThrow();
    }

    // threshold-th call should trigger fallback to Playwright
    const result = await router.fetch('https://failing.com/final');
    expect(result.method).toBe('playwright');
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
  });

  it('routes to Playwright for SPA shell content — content-based detection', async () => {
    vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(SPA_SHELL_HTML));

    const result = await router.fetch('https://spa.com/page');

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(result.method).toBe('playwright');
  });

  it('marks domain for Playwright after SPA shell detection', async () => {
    vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(SPA_SHELL_HTML));

    // First call triggers detection and marks domain
    await router.fetch('https://spa-domain.com/page1');

    // Reset mock to return real content — but domain is already marked
    vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult(FULL_HTML));
    vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://spa-domain.com/page2'));

    const result = await router.fetch('https://spa-domain.com/page2');

    // Second call should go straight to Playwright without HTTP
    expect(result.method).toBe('playwright');
    // httpClient was only used on first call (SPA detection)
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
  });

  it('render_js "auto" triggers full detection logic', async () => {
    // With good content, HTTP should be used
    const result = await router.fetch('https://example.com/page', { renderJs: 'auto' });

    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('routes auth requests to Playwright', async () => {
    const result = await router.fetch('https://example.com/protected', { useAuth: true });

    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('records domain routing decisions', async () => {
    await router.fetch('https://stats.com/page');

    const stats = router.getDomainStats('stats.com');
    expect(stats).toBeDefined();
  });

  it('handles HTTP failure → Playwright fallback in a single call', async () => {
    // Pre-mark the domain by hitting the threshold
    vi.mocked(httpClient.fetch).mockRejectedValue(new Error('Unreachable'));

    const threshold = 3;

    // Build up failure count to threshold - 1
    for (let i = 0; i < threshold - 1; i++) {
      await expect(router.fetch('https://fallback.com/pre')).rejects.toThrow();
    }

    vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://fallback.com/final'));

    // This call should hit threshold, mark domain, and return playwright result
    const result = await router.fetch('https://fallback.com/final');

    expect(result.method).toBe('playwright');
    expect(result.url).toBe('https://fallback.com/final');
  });
});

describe('SmartRouter --- actions routing', () => {
  let httpClient: HttpClient;
  let browserPool: BrowserPoolInterface;
  let router: SmartRouter;

  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
    resetConfig();

    httpClient = {
      fetch: vi.fn(async () => makeHttpResult()),
    };

    browserPool = {
      fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
    };

    router = new SmartRouter(httpClient, browserPool);
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('routes to Playwright when actions are present, even with renderJs=auto', async () => {
    const actions = [{ type: 'click' as const, selector: '.btn' }];
    const result = await router.fetch('https://example.com/page', { actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('routes to Playwright when actions are present, even with renderJs=never', async () => {
    const actions = [{ type: 'click' as const, selector: '.btn' }];
    const result = await router.fetch('https://example.com/page', { renderJs: 'never', actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('does not force Playwright when actions array is empty', async () => {
    const result = await router.fetch('https://example.com/page', { actions: [] });
    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(result.method).toBe('http');
  });

  it('does not force Playwright when actions is undefined', async () => {
    const result = await router.fetch('https://example.com/page', { actions: undefined });
    expect(httpClient.fetch).toHaveBeenCalledOnce();
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
  });

  it('passes actions through to fetchWithBrowser', async () => {
    const actions = [
      { type: 'wait_for' as const, selector: '.loaded', timeout: 3000 },
      { type: 'click' as const, selector: '.btn' },
    ];
    await router.fetch('https://example.com/page', { actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ actions }),
    );
  });

  it('routes to Playwright for actions + useAuth combined', async () => {
    vi.mocked(getAuthOptions).mockResolvedValue({ storageStatePath: '/tmp/state.json' });
    const actions = [{ type: 'click' as const, selector: '.btn' }];
    const result = await router.fetch('https://example.com/page', { useAuth: true, actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(httpClient.fetch).not.toHaveBeenCalled();
    expect(result.method).toBe('playwright');
  });

  it('passes actions alongside screenshot option', async () => {
    const actions = [{ type: 'screenshot' as const }];
    await router.fetch('https://example.com/page', { actions, screenshot: true });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({ actions, screenshot: true }),
    );
  });

  it('handles multiple action types in a single call', async () => {
    const actions = [
      { type: 'wait_for' as const, selector: '.banner' },
      { type: 'click' as const, selector: '.dismiss' },
      { type: 'wait' as const, ms: 500 },
      { type: 'scroll' as const, direction: 'down' as const, amount: 200 },
      { type: 'screenshot' as const },
    ];
    const result = await router.fetch('https://example.com/page', { actions });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    expect(result.method).toBe('playwright');
  });
});
