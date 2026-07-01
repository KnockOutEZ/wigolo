import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

import {
  SmartRouter,
  type HttpClient,
  type BrowserPoolInterface,
  type TlsFetcher,
  type TlsRoutingPersistence,
} from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import type { TlsFetchResult } from '../../../src/fetch/tls-tier.js';

const FULL_HTML = `
<html><head><title>Test</title></head>
<body>
  <p>${'Real article content long enough to clear the empty-content threshold. '.repeat(5)}</p>
</body></html>
`.trim();

function makeHttpResult(
  url: string,
  opts: Partial<{ html: string; statusCode: number }> = {},
): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url,
    finalUrl: url,
    html: opts.html ?? FULL_HTML,
    contentType: 'text/html',
    statusCode: opts.statusCode ?? 200,
    headers: {},
  };
}

function makeBrowserResult(url: string): RawFetchResult {
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

function makeTlsResult(url: string, opts: Partial<{ html: string; statusCode: number }> = {}): TlsFetchResult {
  return {
    url,
    finalUrl: url,
    html: opts.html ?? FULL_HTML,
    contentType: 'text/html',
    statusCode: opts.statusCode ?? 200,
    headers: {},
  };
}

interface BuildOpts {
  preferTls?: boolean;
}

function build(opts: BuildOpts = {}) {
  const httpClient: HttpClient = { fetch: vi.fn(async (url: string) => makeHttpResult(url)) };
  const browserPool: BrowserPoolInterface = {
    fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)),
  };
  const tlsFetcher: TlsFetcher = vi.fn(async (url: string) => makeTlsResult(url));

  const recordedDomains: string[] = [];
  const tlsPersistence: TlsRoutingPersistence = {
    getPreferTls: () => opts.preferTls ?? false,
    recordSuccess: (domain) => {
      recordedDomains.push(domain);
    },
  };

  const router = new SmartRouter({ httpClient, browserPool, tlsFetcher, tlsPersistence });
  return { router, httpClient, browserPool, tlsFetcher, tlsPersistence, recordedDomains };
}

describe('SmartRouter — anti-bot domain TLS-first routing', () => {
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

  describe('built-in anti-bot allowlist tries TLS first even with WIGOLO_TLS_TIER=off', () => {
    it('routes stackoverflow.com question pages to TLS first, skipping the doomed HTTP call', async () => {
      // Global TLS tier OFF — the curated anti-bot allowlist must still opt in,
      // because forcing the doomed HTTP call burns the per-fetch budget on a
      // connection that Stack Overflow times out before answering.
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool, recordedDomains } = build();
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult('https://stackoverflow.com/questions/123'));

      const result = await router.fetch('https://stackoverflow.com/questions/123');

      expect(tlsFetcher).toHaveBeenCalledOnce();
      // HTTP must NOT be called — the doomed connection-timeout call is skipped.
      expect(httpClient.fetch).not.toHaveBeenCalled();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('tls-impersonation');
      expect(recordedDomains).toContain('stackoverflow.com');
    });

    it('routes a Stack Exchange network subdomain to TLS first', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult('https://serverfault.com/questions/9'));

      const result = await router.fetch('https://serverfault.com/questions/9');

      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(httpClient.fetch).not.toHaveBeenCalled();
      expect(result.method).toBe('tls-impersonation');
    });

    it('does NOT TLS-first a domain outside the allowlist when tier is off', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      const result = await router.fetch('https://example.com/page');

      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(result.method).toBe('http');
    });

    // Security boundary: the allowlist match is anchored — exact host OR a
    // `.<domain>` subdomain suffix only. A lookalike must NOT be routed through
    // the TLS tier. These pin the NEGATIVE half of the anchoring contract so a
    // future refactor to includes()/unanchored endsWith() fails loudly instead
    // of silently routing attacker-controlled lookalikes through TLS.
    it('does NOT match a lookalike where the boundary char is not a dot (evil-stackoverflow.com)', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      const result = await router.fetch('https://evil-stackoverflow.com/questions/1');

      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(result.method).toBe('http');
    });

    it('does NOT match a lookalike where the allowlist domain is only a prefix (stackoverflow.com.attacker.test)', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      const result = await router.fetch('https://stackoverflow.com.attacker.test/questions/1');

      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(result.method).toBe('http');
    });
  });

  describe('TLS-first failure on an allowlist domain falls back to HTTP', () => {
    it('falls back to HTTP when TLS tier is unavailable (no native binary)', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { TlsTierUnavailableError } = await import('../../../src/fetch/tls-tier.js');
      const { router, httpClient, tlsFetcher } = build();
      vi.mocked(tlsFetcher).mockRejectedValue(new TlsTierUnavailableError(new Error('not installed')));
      vi.mocked(httpClient.fetch).mockResolvedValue(makeHttpResult('https://stackoverflow.com/questions/1'));

      const result = await router.fetch('https://stackoverflow.com/questions/1');

      expect(tlsFetcher).toHaveBeenCalledOnce();
      // TLS unavailable → HTTP fallback so the fetch still has a chance.
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(result.method).toBe('http');
    });
  });

  describe('timeout-as-escalation-signal', () => {
    it('escalates an HTTP connection timeout to TLS before Playwright (tier=auto, non-allowlist domain)', async () => {
      // tier=auto means TLS-first is NOT tried for a cold non-allowlist domain,
      // so HTTP runs first. When HTTP times out at the connection level (no
      // status to react to), the timeout itself must escalate to the TLS tier.
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher, browserPool, recordedDomains } = build();
      const timeoutErr = Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
      vi.mocked(httpClient.fetch).mockRejectedValue(timeoutErr);
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult('https://flaky.example/page'));

      const result = await router.fetch('https://flaky.example/page');

      // HTTP (timeout) → TLS retry (success), never Playwright.
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('tls-impersonation');
      expect(recordedDomains).toContain('flaky.example');
    });

    it('escalates a socket ETIMEDOUT (error code, no status) to TLS on tier=auto', async () => {
      process.env.WIGOLO_TLS_TIER = 'auto';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      const sockErr = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
      vi.mocked(httpClient.fetch).mockRejectedValue(sockErr);
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult('https://flaky.example/page'));

      const result = await router.fetch('https://flaky.example/page');
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(result.method).toBe('tls-impersonation');
    });

    it('does NOT escalate a timeout to TLS for a non-allowlist domain when tier is off', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      const timeoutErr = Object.assign(new Error('Request timed out'), { name: 'TimeoutError' });
      vi.mocked(httpClient.fetch).mockRejectedValue(timeoutErr);

      await expect(router.fetch('https://plain.example/page')).rejects.toThrow(/timed out/i);
      expect(tlsFetcher).not.toHaveBeenCalled();
    });

    it('escalates a timeout to TLS for ANY domain when the global tier is on', async () => {
      process.env.WIGOLO_TLS_TIER = 'on';
      resetConfig();

      const { router, tlsFetcher } = build();
      // tier=on already tries TLS-first; assert it does so for a generic domain.
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult('https://generic.example/page'));

      const result = await router.fetch('https://generic.example/page');
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(result.method).toBe('tls-impersonation');
    });
  });

  describe('WIGOLO_TLS_DOMAINS env override', () => {
    it('adds custom domains to the TLS-first allowlist', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      process.env.WIGOLO_TLS_DOMAINS = 'mycustom.example, another.test';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult('https://mycustom.example/x'));

      const result = await router.fetch('https://mycustom.example/x');
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(httpClient.fetch).not.toHaveBeenCalled();
      expect(result.method).toBe('tls-impersonation');
    });

    it('matches subdomains of a custom allowlist entry', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      process.env.WIGOLO_TLS_DOMAINS = 'custom.test';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      vi.mocked(tlsFetcher).mockResolvedValue(makeTlsResult('https://docs.custom.test/x'));

      const result = await router.fetch('https://docs.custom.test/x');
      expect(tlsFetcher).toHaveBeenCalledOnce();
      expect(httpClient.fetch).not.toHaveBeenCalled();
      expect(result.method).toBe('tls-impersonation');
    });
  });

  describe('budget discipline', () => {
    it('passes the caller abort signal into the TLS attempt (shared per-fetch deadline)', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, tlsFetcher } = build();
      const controller = new AbortController();
      vi.mocked(tlsFetcher).mockImplementation(async (_url, optsArg) => {
        // The router must forward the caller's signal so the TLS attempt shares
        // the same per-fetch budget rather than running unbounded.
        expect(optsArg?.signal).toBe(controller.signal);
        return makeTlsResult('https://stackoverflow.com/questions/55');
      });

      await router.fetch('https://stackoverflow.com/questions/55', { signal: controller.signal });
      expect(tlsFetcher).toHaveBeenCalledOnce();
    });
  });

  describe('explicit renderJs override still wins over the anti-bot allowlist', () => {
    it('renderJs=never skips the TLS-first allowlist routing', async () => {
      process.env.WIGOLO_TLS_TIER = 'off';
      resetConfig();

      const { router, httpClient, tlsFetcher } = build();
      const result = await router.fetch('https://stackoverflow.com/questions/2', { renderJs: 'never' });

      expect(tlsFetcher).not.toHaveBeenCalled();
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(result.method).toBe('http');
    });
  });
});
