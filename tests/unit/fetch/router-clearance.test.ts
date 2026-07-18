import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

// Browser-acquire mock — report the engine "ready" without a real install so
// browser-tier paths reach the mocked browserPool. On a browserless CI runner
// the real ensureBrowser() attempts an install and hangs past the test timeout.
// Tests needing the "unavailable" branch spy on their own instance to override.
vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

import {
  SmartRouter,
  type HttpClient,
  type BrowserPoolInterface,
  type TlsFetcher,
  type ClearanceStore,
} from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import type { TlsFetchResult } from '../../../src/fetch/tls-tier.js';
import type { DomainClearance } from '../../../src/cache/store.js';
import { resolveStealthUA } from '../../../src/fetch/stealth.js';

const FULL_HTML =
  '<html><head><title>Test</title></head><body><p>' +
  'Real article content long enough to clear the empty-content threshold. '.repeat(5) +
  '</p></body></html>';

const CHROME_UA = resolveStealthUA();
const FIREFOX_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

function future(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}
function past(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

function makeHttpResult(): Awaited<ReturnType<HttpClient['fetch']>> {
  return {
    url: 'https://example.com/page',
    finalUrl: 'https://example.com/page',
    html: FULL_HTML,
    contentType: 'text/html',
    statusCode: 200,
    headers: {},
  };
}
function makeBrowserResult(url = 'https://example.com/page'): RawFetchResult {
  return { url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, method: 'browser', headers: {} };
}
function makeTlsResult(url = 'https://example.com/page'): TlsFetchResult {
  return { url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, headers: {} };
}

interface Built {
  router: SmartRouter;
  httpClient: { fetch: ReturnType<typeof vi.fn> };
  browserPool: { fetchWithBrowser: ReturnType<typeof vi.fn> };
  tlsFetcher: ReturnType<typeof vi.fn>;
  cleared: string[];
}

function build(stored: Record<string, DomainClearance>, tlsResultHtml?: string): Built {
  const httpClient = { fetch: vi.fn(async () => makeHttpResult()) };
  const browserPool = { fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)) };
  const tlsFetcher = vi.fn(async (url: string) => {
    const r = makeTlsResult(url);
    if (tlsResultHtml !== undefined) r.html = tlsResultHtml;
    return r;
  });
  const cleared: string[] = [];
  const clearanceStore: ClearanceStore = {
    get: (host) => stored[host] ?? null,
    clear: (host) => { cleared.push(host); },
    getBackoff: () => null,
    recordBackoff: () => {},
  };
  const router = new SmartRouter({
    httpClient: httpClient as unknown as HttpClient,
    browserPool: browserPool as unknown as BrowserPoolInterface,
    tlsFetcher: tlsFetcher as unknown as TlsFetcher,
    clearanceStore,
  });
  return { router, httpClient, browserPool, tlsFetcher, cleared };
}

describe('SmartRouter clearance reuse — browser tier', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('injects a stored, fresh, Chrome-UA-matching clearance into a browser fetch (same host)', async () => {
    const { router, browserPool } = build({
      'example.com': { cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: future() },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledTimes(1);
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toEqual([{ name: 'cf_clearance', value: 'TOK', domain: 'example.com', path: '/' }]);
  });

  it('does NOT inject for a DIFFERENT host than the one stored', async () => {
    const { router, browserPool } = build({
      'other.com': { cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: future() },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toBeUndefined();
  });

  it('NEGATIVE expired: an expired clearance is NOT injected and IS cleared', async () => {
    const { router, browserPool, cleared } = build({
      'example.com': { cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: past() },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toBeUndefined();
    expect(cleared).toContain('example.com');
  });

  it('NEGATIVE UA mismatch: a Firefox-UA clearance is NOT injected into the Chromium browser tier', async () => {
    const { router, browserPool, cleared } = build({
      'example.com': { cookie: 'cf_clearance=TOK', ua: FIREFOX_UA, tier: 'tls', expiresAt: future() },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toBeUndefined();
    // Not cleared — it may still be valid for a header tier.
    expect(cleared).not.toContain('example.com');
  });
});

describe('SmartRouter clearance reuse — TLS tier', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv, WIGOLO_TLS_TIER: 'on' }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('injects a Cookie header for the header tier even from a Firefox-UA clearance (best-effort cross-tier)', async () => {
    const { router, tlsFetcher } = build({
      'example.com': { cookie: 'cf_clearance=TOK', ua: FIREFOX_UA, tier: 'tls', expiresAt: future() },
    });
    await router.fetch('https://example.com/page');
    expect(tlsFetcher).toHaveBeenCalled();
    const opts = tlsFetcher.mock.calls[0][1];
    expect(opts.headers?.Cookie).toBe('cf_clearance=TOK');
  });

  it('merges the clearance Cookie with a caller-supplied Cookie header (no clobber)', async () => {
    const { router, tlsFetcher } = build({
      'example.com': { cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'tls', expiresAt: future() },
    });
    await router.fetch('https://example.com/page', { headers: { Cookie: 'sid=1' } });
    const opts = tlsFetcher.mock.calls[0][1];
    expect(opts.headers?.Cookie).toBe('sid=1; cf_clearance=TOK');
  });

  it('NEGATIVE injected-but-rejected: a TLS anti-bot response after injection purges the stored clearance and escalates', async () => {
    const CHALLENGE = '<html><head><title>Just a moment...</title></head><body><div class="cf-browser-verification"></div></body></html>';
    const cleared: string[] = [];
    const clearanceStore: ClearanceStore = {
      get: (host) => (host === 'example.com'
        ? { cookie: 'cf_clearance=STALE', ua: CHROME_UA, tier: 'tls', expiresAt: future() }
        : null),
      clear: (host) => { cleared.push(host); },
      getBackoff: () => null,
      recordBackoff: () => {},
    };
    // Both TLS and HTTP land on the challenge shell so the ladder must reach the
    // browser tier — proving the shell is never returned as content.
    const tlsFetcher = vi.fn(async (url: string) => ({
      url, finalUrl: url, html: CHALLENGE, contentType: 'text/html', statusCode: 403, headers: {},
    }));
    const httpClient = { fetch: vi.fn(async (url: string) => ({
      url, finalUrl: url, html: CHALLENGE, contentType: 'text/html', statusCode: 403, headers: {},
    })) };
    const browserPool = { fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)) };
    const router = new SmartRouter({
      httpClient: httpClient as unknown as HttpClient,
      browserPool: browserPool as unknown as BrowserPoolInterface,
      tlsFetcher: tlsFetcher as unknown as TlsFetcher,
      clearanceStore,
    });
    void browserPool;
    const res = await router.fetch('https://example.com/page');
    // Dead clearance purged after the re-challenge.
    expect(cleared).toContain('example.com');
    // The challenge shell is never returned as content — it maps to a
    // structured blocked_by_challenge stage error and the escalation proceeds.
    expect((res as { error?: string }).error).toBe('blocked_by_challenge');
    expect((res as RawFetchResult).html).not.toBe(CHALLENGE);
  });
});
