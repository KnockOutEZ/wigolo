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

import {
  SmartRouter,
  type HttpClient,
  type BrowserPoolInterface,
  type TlsFetcher,
  type ClearanceStore,
} from '../../../src/fetch/router.js';
import type { RawFetchResult } from '../../../src/types.js';
import type { DomainClearance } from '../../../src/cache/store.js';
import { resolveStealthUA } from '../../../src/fetch/stealth.js';

const FULL_HTML =
  '<html><head><title>Test</title></head><body><p>' +
  'Real article content long enough to clear the empty-content threshold. '.repeat(5) +
  '</p></body></html>';

const CHROME_UA = resolveStealthUA();

function future(ms = 60_000): string {
  return new Date(Date.now() + ms).toISOString();
}

function makeBrowserResult(url = 'https://example.com/page'): RawFetchResult {
  return { url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, method: 'browser', headers: {} };
}

function build(stored: Record<string, DomainClearance>) {
  const httpClient = { fetch: vi.fn(async () => ({
    url: 'https://example.com/page', finalUrl: 'https://example.com/page', html: FULL_HTML,
    contentType: 'text/html', statusCode: 200, headers: {},
  })) };
  const browserPool = { fetchWithBrowser: vi.fn(async (url: string) => makeBrowserResult(url)) };
  const tlsFetcher = vi.fn(async (url: string) => ({
    url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, headers: {},
  }));
  const clearanceStore: ClearanceStore = {
    get: (host) => stored[host] ?? null,
    clear: () => {},
    getBackoff: () => null,
    recordBackoff: () => {},
  };
  const router = new SmartRouter({
    httpClient: httpClient as unknown as HttpClient,
    browserPool: browserPool as unknown as BrowserPoolInterface,
    tlsFetcher: tlsFetcher as unknown as TlsFetcher,
    clearanceStore,
  });
  return { router, browserPool };
}

describe('SmartRouter clearanceFor — route-identity gate (P6 enforced)', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('MATCH: a direct-solved clearance IS reused on the default (direct) route', async () => {
    // No proxy configured → current route is 'direct'; a direct-solved clearance matches.
    const { router, browserPool } = build({
      'example.com': { cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: future(), solvedRoute: 'direct' },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toEqual([{ name: 'cf_clearance', value: 'TOK', domain: 'example.com', path: '/' }]);
  });

  it('MATCH: a legacy row with NO solvedRoute is treated as direct and reused on the direct route', async () => {
    const { router, browserPool } = build({
      // solvedRoute omitted → normalized to 'direct'.
      'example.com': { cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: future() },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toEqual([{ name: 'cf_clearance', value: 'TOK', domain: 'example.com', path: '/' }]);
  });

  it('MISMATCH: a proxy-solved clearance is NOT reused on the direct route (route gate refuses)', async () => {
    const { router, browserPool } = build({
      'example.com': {
        cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: future(),
        solvedRoute: 'http://proxy.example:8080',
      },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    // Route mismatch → hard-refuse reuse; no cookie injected.
    expect(opts.injectedCookies).toBeUndefined();
  });

  it('MISMATCH: a direct-solved clearance is NOT reused when a proxy route is active', async () => {
    process.env.PROXY_URL = 'http://proxy.example:8080';
    process.env.WIGOLO_USE_PROXY = '1';
    resetConfig();
    const { router, browserPool } = build({
      'example.com': { cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: future(), solvedRoute: 'direct' },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toBeUndefined();
  });

  it('MATCH: a proxy-solved clearance IS reused when the SAME proxy route is active', async () => {
    process.env.PROXY_URL = 'http://proxy.example:8080';
    process.env.WIGOLO_USE_PROXY = '1';
    resetConfig();
    const { router, browserPool } = build({
      'example.com': {
        cookie: 'cf_clearance=TOK', ua: CHROME_UA, tier: 'browser', expiresAt: future(),
        solvedRoute: 'http://proxy.example:8080',
      },
    });
    await router.fetch('https://example.com/page', { renderJs: 'always' });
    const opts = browserPool.fetchWithBrowser.mock.calls[0][1];
    expect(opts.injectedCookies).toEqual([{ name: 'cf_clearance', value: 'TOK', domain: 'example.com', path: '/' }]);
  });
});
