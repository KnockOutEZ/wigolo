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
import {
  SmartRouter,
  type HttpClient,
  type BrowserPoolInterface,
  type HttpFetcher,
  type TlsFetcher,
} from '../../src/fetch/router.js';
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

// --- S4 memory trap: a signal/budget threaded through router.fetch must reach
// ALL tiers, not just http/browser. The content-fetch per-URL budget is
// enforced via an AbortSignal handed to router.fetch; that signal must be
// honoured on the stealth path AND the TLS-impersonation tier (the two tiers
// prior fetch-threading slices missed), not just the plain HTTP + browser
// paths. This asserts the stealth httpFetcher stub AND the tlsFetcher stub both
// receive the caller's signal.
describe('SmartRouter — signal/budget threads through stealth + TLS tiers', () => {
  beforeEach(() => {
    resetConfig();
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
    vi.restoreAllMocks();
  });

  it('threads the caller signal into the stealth-tier httpFetcher (not just http/browser)', async () => {
    const controller = new AbortController();
    let stealthSignal: AbortSignal | undefined;
    const httpFetcher: HttpFetcher = vi.fn(async (_url, opts) => {
      stealthSignal = opts?.signal;
      return { url: 'https://stealth.example/x', html: '<html><body>' + 'a'.repeat(2000) + '</body></html>', text: 'a'.repeat(2000) };
    });
    const router = new SmartRouter({ httpFetcher });
    await router.fetch('https://stealth.example/x', { mode: 'stealth', signal: controller.signal });
    // The stealth path received the SAME signal instance the caller passed —
    // so a per-URL budget expressed as an abort would cancel this tier too.
    expect(stealthSignal).toBe(controller.signal);
  });

  it('threads the caller signal into the TLS-impersonation tier for an anti-bot domain', async () => {
    const controller = new AbortController();
    let tlsSignal: AbortSignal | undefined;
    // stackoverflow.com is in the built-in anti-bot TLS-first set → tls tier
    // is tried FIRST. The tlsFetcher stub must observe the caller's signal.
    const tlsFetcher: TlsFetcher = vi.fn(async (url, opts) => {
      tlsSignal = opts?.signal;
      return {
        url,
        finalUrl: url,
        html: '<html><body>' + 'answer '.repeat(400) + '</body></html>',
        contentType: 'text/html',
        statusCode: 200,
        headers: {},
      };
    });
    const httpClient: HttpClient = {
      fetch: vi.fn(async (url) => ({ url, finalUrl: url, html: '<html><body>http</body></html>', contentType: 'text/html', statusCode: 200, headers: {} })),
    };
    const router = new SmartRouter({ httpClient, tlsFetcher });
    await router.fetch('https://stackoverflow.com/questions/1/x', { signal: controller.signal });
    // TLS tier fired and carried the SAME signal — proving the per-URL budget
    // reaches the TLS-impersonation tier, not only http/browser.
    expect(tlsFetcher).toHaveBeenCalledOnce();
    expect(tlsSignal).toBe(controller.signal);
  });

  it('an aborted caller signal is observable on the stealth tier (budget enforcement is honoured there)', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('timeout', 'AbortError'));
    // The stealth httpFetcher receives the (already-aborted) signal instance so
    // the tier can honour the per-URL budget.
    let observed: AbortSignal | undefined;
    const httpFetcher: HttpFetcher = vi.fn(async (_url, opts) => {
      observed = opts?.signal;
      return { url: 'https://stealth2.example/x', html: '<html></html>', text: 'tiny' };
    });
    const playwrightFetcher = vi.fn(async () => ({
      html: '<html><body>' + 'x'.repeat(2000) + '</body></html>',
      text: 'x'.repeat(2000),
    }));
    const router = new SmartRouter({ httpFetcher, playwrightFetcher: playwrightFetcher as never });
    await router.fetch('https://stealth2.example/x', { mode: 'stealth', signal: controller.signal });
    expect(observed).toBe(controller.signal);
    expect(observed?.aborted).toBe(true);
  });
});
