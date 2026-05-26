import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

import { SmartRouter, type HttpClient, type BrowserPoolInterface, type TlsFetcher, type TlsRoutingPersistence } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import type { TlsFetchResult } from '../../../src/fetch/tls-tier.js';

const FULL_HTML = `
<html><head><title>Test</title></head>
<body>
  <p>${'Real article content long enough to clear the empty-content threshold. '.repeat(5)}</p>
</body></html>
`.trim();

function makeHttpResult(opts: Partial<{ html: string; statusCode: number }> = {}): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    html: opts.html ?? FULL_HTML,
    contentType: 'text/html',
    statusCode: opts.statusCode ?? 200,
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

function makeTlsResult(opts: Partial<{ html: string; statusCode: number; url: string }> = {}): TlsFetchResult {
  return {
    url: opts.url ?? 'https://example.com/page',
    finalUrl: opts.url ?? 'https://example.com/page',
    html: opts.html ?? FULL_HTML,
    contentType: 'text/html',
    statusCode: opts.statusCode ?? 200,
    headers: {},
  };
}

interface BuildOpts {
  tlsMode?: 'off' | 'auto' | 'on';
  preferTls?: boolean;
  threshold?: number;
}

function build(opts: BuildOpts = {}) {
  const httpClient: HttpClient = { fetch: vi.fn(async () => makeHttpResult()) };
  const browserPool: BrowserPoolInterface = { fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)) };
  const tlsFetcher: TlsFetcher = vi.fn(async (url: string) => makeTlsResult({ url }));

  const recordedDomains: string[] = [];
  const tlsPersistence: TlsRoutingPersistence = {
    getPreferTls: () => opts.preferTls ?? false,
    recordSuccess: (domain) => {
      recordedDomains.push(domain);
    },
  };

  const router = new SmartRouter({
    httpClient,
    browserPool,
    tlsFetcher,
    tlsPersistence,
  });
  return { router, httpClient, browserPool, tlsFetcher, tlsPersistence, recordedDomains };
}

describe('SmartRouter — TLS tier (Slice D2)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, BROWSER_FALLBACK_THRESHOLD: '3' };
    resetConfig();
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  describe('WIGOLO_TLS_TIER=off (default)', () => {
    it('never invokes the TLS tier, even when HTTP returns 403', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, browserPool, tlsFetcher } = build();
      // Substantive body so contentAppearsEmpty() does NOT fire — we want to
      // assert tls-tier-off keeps the legacy 403 passthrough behaviour.
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult({ statusCode: 403 }));

      const result = await router.fetch('https://blocked.com/page');

      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      // 403 with substantive body is returned as-is (content not empty)
      expect(result.method).toBe('http');
    });

    it('keeps the existing HTTP-first behavior on healthy pages', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool } = build();
      const result = await router.fetch('https://example.com/page');

      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });
  });

  describe('WIGOLO_TLS_TIER=auto', () => {
    it('does NOT invoke TLS tier on a normal 200 page', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool } = build();
      const result = await router.fetch('https://example.com/page');

      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });

    it('escalates to TLS tier on HTTP 403', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool, recordedDomains } = build();
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult({ statusCode: 403, html: 'forbidden' }));
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult({ url: 'https://blocked.com/page' }));

      const result = await router.fetch('https://blocked.com/page');

      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(result.method).toBe('tls-impersonation');
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(recordedDomains).toContain('blocked.com');
    });

    it('escalates to TLS tier on Cloudflare challenge body', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      vi.mocked(httpClient.fetch).mockResolvedValue(
        makeHttpResult({ statusCode: 200, html: '<html><body>cf-browser-verification</body></html>' }),
      );
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult({ url: 'https://cf.com/page' }));

      const result = await router.fetch('https://cf.com/page');
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(result.method).toBe('tls-impersonation');
    });

    it('escalates HTTP → TLS → Playwright when TLS also returns 403', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool, recordedDomains } = build();
      // Slice 5 (audit H4): use 403 + Cloudflare challenge body to trigger
      // anti-bot escalation. A bare 429 is now treated as a rate-limit and
      // does NOT escalate to Playwright — see router-escalation-tuning.test.ts.
      vi.mocked(httpClient.fetch).mockResolvedValue(
        makeHttpResult({ statusCode: 403, html: '<html><body>cf-browser-verification</body></html>' }),
      );
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult({ statusCode: 403, html: 'still blocked' }));
      vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://hard.com/page'));

      const result = await router.fetch('https://hard.com/page');

      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
      expect(result.method).toBe('playwright');
      // TLS returned anti-bot → no success recorded.
      expect(recordedDomains).not.toContain('hard.com');
    });

    it('escalates HTTP → TLS → Playwright when TLS throws TlsTierUnavailableError', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { TlsTierUnavailableError } = await import('../../../src/fetch/tls-tier.js');
      const { router, httpClient, tlsFetcher, browserPool } = build();
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult({ statusCode: 403 }));
      vi.mocked(tlsFetcher).mockRejectedValue(new TlsTierUnavailableError(new Error('not installed')));
      vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://hard.com/page'));

      const result = await router.fetch('https://hard.com/page');
      expect(result.method).toBe('playwright');
      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
    });

    it('escalates to Playwright on TLS generic error', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool } = build();
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult({ statusCode: 503 }));
      vi.mocked(tlsFetcher).mockRejectedValue(new Error('network unreachable'));
      vi.mocked(browserPool.fetchWithBrowser).mockResolvedValue(makeBrowserResult('https://x.com/page'));

      const result = await router.fetch('https://x.com/page');
      expect(result.method).toBe('playwright');
    });

    it('uses TLS tier first when domain has prefer_tls_impersonation=1', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build({ preferTls: true });
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult({ url: 'https://promoted.com/page' }));

      const result = await router.fetch('https://promoted.com/page');

      // TLS first, HTTP never called.
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(httpClient.fetch).not.toHaveBeenCalled();
      expect(result.method).toBe('tls-impersonation');
    });
  });

  describe('WIGOLO_TLS_TIER=on', () => {
    it('tries TLS first for cold domains, never touching HTTP on success', async () => {
      process.env.WIGOLO_TLS_TIER = 'on';
      resetConfig();

      const { router, httpClient, tlsFetcher, recordedDomains } = build();
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult({ url: 'https://cold.com/page' }));

      const result = await router.fetch('https://cold.com/page');
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(httpClient.fetch).not.toHaveBeenCalled();
      expect(result.method).toBe('tls-impersonation');
      expect(recordedDomains).toContain('cold.com');
    });

    it('falls back to HTTP if TLS fails on cold domain', async () => {
      process.env.WIGOLO_TLS_TIER = 'on';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult({ statusCode: 403, html: 'cf-browser-verification' }));
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult());

      const result = await router.fetch('https://cold.com/page');
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(result.method).toBe('http');
    });
  });

  describe('renderJs explicit override', () => {
    it('renderJs=never skips TLS tier entirely even on 403', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool } = build();
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult({ statusCode: 403 }));

      const result = await router.fetch('https://x.com/page', { renderJs: 'never' });
      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });
  });
});
