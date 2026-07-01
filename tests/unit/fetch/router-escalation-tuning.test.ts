/**
 * Smart-router escalation tuning regression suite.
 *
 * Background:
 *   - `render_js: never` returns in 146ms; the default Playwright
 *     path on the same URL is 8.2s (~56× slower). The router CODE PATH is
 *     correct (HTTP-first → escalate). The escalation SIGNALS fire too
 *     eagerly.
 *   - papers fetch ~36s, format=answer ~16s, research quick ~21s,
 *     agent w/ schema 30s+ — most of these are downstream consequences of
 *     over-escalation. After tuning the slow tier should not be invoked
 *     when content is reachable via HTTP.
 *
 * Each test below asserts the HTTP-first path is taken (Playwright NOT
 * invoked) when content IS reachable via HTTP, and only escalates when the
 * signal genuinely indicates a browser is required. Mocks throw if the
 * browser pool is called on the HTTP-first path so a regression is loud.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

import { SmartRouter, type HttpClient, type BrowserPoolInterface } from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';

const SUBSTANTIVE_ARTICLE = `
<html><head><title>Real Article</title></head>
<body>
  <main>
    <h1>Substantive Article</h1>
    <p>${'A page with real article content rendered server-side and long enough to be unambiguously not-empty. '.repeat(10)}</p>
  </main>
</body></html>
`.trim();

function makeHttpResult(opts: { html?: string; statusCode?: number; headers?: Record<string, string>; url?: string } = {}): Awaited<ReturnType<HttpClient['fetch']>> {
  const url = opts.url ?? 'https://example.com/page';
  return {
    url,
    finalUrl: url,
    html: opts.html ?? SUBSTANTIVE_ARTICLE,
    contentType: 'text/html',
    statusCode: opts.statusCode ?? 200,
    headers: opts.headers ?? {},
  };
}

function makeBrowserResult(url = 'https://example.com/page'): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: SUBSTANTIVE_ARTICLE,
    contentType: 'text/html',
    statusCode: 200,
    method: 'playwright',
    headers: {},
  };
}

function buildRouter(opts: {
  httpFetcher?: HttpClient['fetch'];
  browserFetcher?: BrowserPoolInterface['fetchWithBrowser'];
} = {}) {
  const httpClient: HttpClient = {
    fetch: vi.fn(opts.httpFetcher ?? (async () => makeHttpResult())),
  };
  const browserPool: BrowserPoolInterface = {
    fetchWithBrowser: vi.fn(
      opts.browserFetcher ??
        (async (url: string) => makeBrowserResult(url)),
    ),
  };
  const router = new SmartRouter({ httpClient, browserPool });
  return { router, httpClient, browserPool };
}

describe('SmartRouter escalation tuning — HTTP-first on slow-path set', () => {
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

  describe('SPA-shell heuristic — require both shell-id AND script-heavy markers', () => {
    it('keeps HTTP path when shell-id is present but the page also has substantive <noscript>', async () => {
      // noscript with real prose is NOT "please enable JS"; it's
      // a legitimate fallback. Today the router escalates whenever
      // <noscript> contains "javascript"/"enable" — even when the surrounding
      // body has substantive content. Tighten: substantive <noscript> must
      // NOT count as a JS-required marker.
      const html = `<!doctype html><html><body>
        <noscript>${'This site uses a small JavaScript enhancement; the article is fully readable below. '.repeat(8)}</noscript>
        <main>${'<p>Real article body content here that meaningfully describes the topic.</p>'.repeat(8)}</main>
      </body></html>`;
      const { router, httpClient, browserPool } = buildRouter({
        httpFetcher: async () => makeHttpResult({ html, url: 'https://substantive-noscript.example/post' }),
        browserFetcher: async () => { throw new Error('Playwright must NOT be invoked: substantive <noscript> is not a JS-required marker'); },
      });
      const result = await router.fetch('https://substantive-noscript.example/post');
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });

    it('escalates only when shell-id is present AND the body has no semantic content AND is JS-heavy', async () => {
      // True SPA shell: tiny body, <div id="root"></div>, all JS. Escalate.
      const html = `<!doctype html><html><body><div id="root"></div><script>${'var a = 1;'.repeat(500)}</script></body></html>`;
      const { router, httpClient, browserPool } = buildRouter({
        httpFetcher: async () => makeHttpResult({ html, url: 'https://true-spa.example/' }),
      });
      const result = await router.fetch('https://true-spa.example/');
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
      expect(result.method).toBe('playwright');
    });

    it('keeps HTTP path when <noscript> contains a "javascript" warning BUT the article body has 500+ chars of visible text', async () => {
      // many docs sites ship `<noscript>You need to enable
      // JavaScript</noscript>` defensively even when the article is fully
      // rendered SSR. Today this triggers escalation; tighten so the noscript
      // marker only counts when the rest of the body is thin.
      const html = `<!doctype html><html><body>
        <noscript>You need to enable JavaScript to run this app.</noscript>
        <main>${'<p>Full SSR article body with hundreds of chars of meaningful prose to defeat the empty-content threshold easily.</p>'.repeat(6)}</main>
      </body></html>`;
      const { router, httpClient, browserPool } = buildRouter({
        httpFetcher: async () => makeHttpResult({ html, url: 'https://docs-ssr.example/intro' }),
        browserFetcher: async () => { throw new Error('Playwright must NOT be invoked: defensive <noscript> alongside substantive SSR body'); },
      });
      const result = await router.fetch('https://docs-ssr.example/intro');
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });
  });

  describe('render_js: auto — extraction-chars threshold', () => {
    it('keeps HTTP path when visible text exceeds the empty-content floor even with a shell-id present', async () => {
      // audit: pages that nest <main>/<article> under <div id="root"> SSR
      // the article body. We must not escalate just because the shell-id
      // exists — measure content.
      const html = `<!doctype html><html><body>
        <div id="root">
          <main><h1>SSR Article</h1>
            <p>${'Plenty of body prose here so the visible-text scan clears the floor.'.repeat(12)}</p>
          </main>
        </div>
      </body></html>`;
      const { router, httpClient, browserPool } = buildRouter({
        httpFetcher: async () => makeHttpResult({ html, url: 'https://shell-with-content.example/post' }),
        browserFetcher: async () => { throw new Error('Playwright must NOT be invoked when SSR populates the shell with substantive content'); },
      });
      const result = await router.fetch('https://shell-with-content.example/post');
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect(result.method).toBe('http');
    });

    it('escalates when extracted body is below the empty-content floor (100 visible chars)', async () => {
      // Genuinely empty SPA shell — escalate.
      const html = `<!doctype html><html><body><div id="root">Tiny</div></body></html>`;
      const { router, httpClient, browserPool } = buildRouter({
        httpFetcher: async () => makeHttpResult({ html, url: 'https://empty.example/' }),
      });
      const result = await router.fetch('https://empty.example/');
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
      expect(result.method).toBe('playwright');
    });
  });

  describe('Anti-bot vs rate-limit — distinguish 429 from 403/503', () => {
    it('does NOT escalate to Playwright on a 429 with Retry-After (rate-limit, not anti-bot)', async () => {
      // audit-derived: a 429 with Retry-After is a rate-limit signal.
      // Playwright will hit the same rate limit. Surface the 429 to the
      // caller — DO NOT pay the Playwright cold-start cost.
      const { router, httpClient, browserPool } = buildRouter({
        httpFetcher: async () =>
          makeHttpResult({ statusCode: 429, html: '<html><body>Too Many Requests</body></html>', headers: { 'retry-after': '120' }, url: 'https://rate-limited.example/api' }),
        browserFetcher: async () => { throw new Error('Playwright must NOT be invoked on a 429 + Retry-After rate-limit'); },
      });
      const result = await router.fetch('https://rate-limited.example/api');
      expect(httpClient.fetch).toHaveBeenCalledOnce();
      expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
      expect('statusCode' in result ? result.statusCode : 0).toBe(429);
    });

    it('escalates to Playwright on a 403 with a Cloudflare challenge body (genuine anti-bot)', async () => {
      const html = `<!doctype html><html><body><div class="cf-browser-verification">Just a moment...</div></body></html>`;
      const { router, browserPool } = buildRouter({
        httpFetcher: async () =>
          makeHttpResult({ statusCode: 403, html, url: 'https://cf-protected.example/' }),
      });
      const result = await router.fetch('https://cf-protected.example/');
      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
      expect(result.method).toBe('playwright');
    });

    it('escalates to Playwright on a 503 with a Cloudflare challenge body', async () => {
      const html = `<!doctype html><html><body><script>_cfChlOpt = {};</script></body></html>`;
      const { router, browserPool } = buildRouter({
        httpFetcher: async () =>
          makeHttpResult({ statusCode: 503, html, url: 'https://cf-503.example/' }),
      });
      const result = await router.fetch('https://cf-503.example/');
      expect(browserPool.fetchWithBrowser).toHaveBeenCalledOnce();
      expect(result.method).toBe('playwright');
    });
  });

  describe('Domain learning — downgrade prefer-chromium on first HTTP success', () => {
    it('a known-SPA domain that returns substantive HTTP content on first try resets the preferPlaywright flag', async () => {
      // Setup: react.dev is in KNOWN_SPA_DOMAINS so it starts preferPlaywright=true.
      // Tuning: if Playwright fails (or the caller forces HTTP) and HTTP later
      // returns substantive content, the flag should reset so subsequent
      // requests go HTTP-first.
      let httpHits = 0;
      const browserCalls: string[] = [];
      const httpClient: HttpClient = {
        fetch: vi.fn(async (url: string) => {
          httpHits++;
          return makeHttpResult({ url, html: SUBSTANTIVE_ARTICLE });
        }),
      };
      const browserPool: BrowserPoolInterface = {
        fetchWithBrowser: vi.fn(async (url: string) => {
          browserCalls.push(url);
          return makeBrowserResult(url);
        }),
      };
      const router = new SmartRouter({ httpClient, browserPool });

      // First call: pre-marked SPA → Playwright. Suppose the user passes
      // render_js: 'never' to force HTTP. HTTP returns substantive content.
      const r1 = await router.fetch('https://react.dev/learn', { renderJs: 'never' });
      expect(r1.method).toBe('http');

      // Tuning effect: domain stats should now reflect that HTTP worked, so
      // the next default-mode fetch on the same domain skips Playwright.
      const r2 = await router.fetch('https://react.dev/reference', { renderJs: 'auto' });
      expect(r2.method).toBe('http');
      expect(browserCalls.length).toBe(0);
      expect(httpHits).toBe(2);
    });
  });
});
