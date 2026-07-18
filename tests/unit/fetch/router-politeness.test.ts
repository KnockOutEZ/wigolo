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
import { DEFAULT_BACKOFF_MS, MAX_BACKOFF_MS } from '../../../src/fetch/politeness.js';
import { resolveStealthUA } from '../../../src/fetch/stealth.js';

const FULL_HTML =
  '<html><head><title>Test</title></head><body><p>' +
  'Real article content long enough to clear the empty-content threshold. '.repeat(5) +
  '</p></body></html>';

type HttpResult = Awaited<ReturnType<HttpClient['fetch']>>;

function okResult(url = 'https://example.com/page'): HttpResult {
  return { url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, headers: {} };
}

function rateLimitResult(url = 'https://example.com/page', headers: Record<string, string> = {}): HttpResult {
  return {
    url,
    finalUrl: url,
    html: 'Too Many Requests',
    contentType: 'text/plain',
    statusCode: 429,
    headers,
  };
}

function bare403Result(url = 'https://example.com/page'): HttpResult {
  // A bare 403 with no challenge markers — an anti-bot status signal.
  return {
    url,
    finalUrl: url,
    html: '<html><body>Forbidden</body></html>',
    contentType: 'text/html',
    statusCode: 403,
    headers: {},
  };
}

interface Backoffs {
  recorded: Array<{ host: string; until: number }>;
  window: Record<string, number>;
}

function makeStore(backoffs: Backoffs): ClearanceStore {
  return {
    get: () => null,
    clear: () => {},
    getBackoff: (host) => backoffs.window[host] ?? null,
    recordBackoff: (host, until) => { backoffs.recorded.push({ host, until }); },
  };
}

function build(opts: {
  httpFetch?: ReturnType<typeof vi.fn>;
  backoffs?: Backoffs;
} = {}) {
  const backoffs: Backoffs = opts.backoffs ?? { recorded: [], window: {} };
  const httpFetch = opts.httpFetch ?? vi.fn(async () => okResult());
  const httpClient = { fetch: httpFetch };
  const browserPool = {
    fetchWithBrowser: vi.fn(async (url: string): Promise<RawFetchResult> => ({
      url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, method: 'browser', headers: {},
    })),
  };
  const tlsFetcher = vi.fn(async (url: string) => ({
    url, finalUrl: url, html: FULL_HTML, contentType: 'text/html', statusCode: 200, headers: {},
  }));
  const router = new SmartRouter({
    httpClient: httpClient as unknown as HttpClient,
    browserPool: browserPool as unknown as BrowserPoolInterface,
    tlsFetcher: tlsFetcher as unknown as TlsFetcher,
    clearanceStore: makeStore(backoffs),
  });
  return { router, httpFetch, browserPool, tlsFetcher, backoffs };
}

describe('SmartRouter politeness — 429 records a backoff window', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv, WIGOLO_TLS_TIER: 'off' }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('records a backoff ~now+30s from a Retry-After: 30 header', async () => {
    const httpFetch = vi.fn(async () => rateLimitResult('https://example.com/page', { 'retry-after': '30' }));
    const { router, backoffs } = build({ httpFetch });
    const before = Date.now();
    await router.fetch('https://example.com/page');
    expect(backoffs.recorded).toHaveLength(1);
    expect(backoffs.recorded[0].host).toBe('example.com');
    // ~now + 30_000, tolerant of test wall-clock.
    expect(backoffs.recorded[0].until).toBeGreaterThanOrEqual(before + 30_000);
    expect(backoffs.recorded[0].until).toBeLessThanOrEqual(Date.now() + 30_000 + 1000);
  });

  it('uses DEFAULT_BACKOFF_MS when the 429 carries no Retry-After', async () => {
    const httpFetch = vi.fn(async () => rateLimitResult('https://example.com/page'));
    const { router, backoffs } = build({ httpFetch });
    const before = Date.now();
    await router.fetch('https://example.com/page');
    expect(backoffs.recorded).toHaveLength(1);
    expect(backoffs.recorded[0].until).toBeGreaterThanOrEqual(before + DEFAULT_BACKOFF_MS);
    expect(backoffs.recorded[0].until).toBeLessThanOrEqual(Date.now() + DEFAULT_BACKOFF_MS + 1000);
  });

  it('clamps an absurd Retry-After to MAX_BACKOFF_MS (300s)', async () => {
    const httpFetch = vi.fn(async () => rateLimitResult('https://example.com/page', { 'retry-after': '99999' }));
    const { router, backoffs } = build({ httpFetch });
    const before = Date.now();
    await router.fetch('https://example.com/page');
    expect(backoffs.recorded).toHaveLength(1);
    expect(backoffs.recorded[0].until).toBeLessThanOrEqual(before + MAX_BACKOFF_MS + 1000);
    expect(backoffs.recorded[0].until).toBeGreaterThanOrEqual(before + MAX_BACKOFF_MS - 1000);
  });

  it('still passes the 429 through to the caller (statusCode 429 preserved)', async () => {
    const httpFetch = vi.fn(async () => rateLimitResult('https://example.com/page', { 'retry-after': '30' }));
    const { router } = build({ httpFetch });
    const res = await router.fetch('https://example.com/page') as RawFetchResult;
    expect(res.statusCode).toBe(429);
  });
});

describe('SmartRouter politeness — pre-fetch backoff window', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv, WIGOLO_TLS_TIER: 'off' }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('a host in an active backoff window returns a labeled rate-limit WITHOUT hitting the origin', async () => {
    const httpFetch = vi.fn(async () => okResult());
    const backoffs: Backoffs = { recorded: [], window: { 'example.com': Date.now() + 120_000 } };
    const { router } = build({ httpFetch, backoffs });
    const res = await router.fetch('https://example.com/page') as RawFetchResult;
    // Origin was NOT hit.
    expect(httpFetch).not.toHaveBeenCalled();
    // Labeled as a rate-limit (maps to http_429 downstream).
    expect(res.statusCode).toBe(429);
  });

  it('NEGATIVE: a host with no backoff window fetches normally (origin IS hit)', async () => {
    const httpFetch = vi.fn(async () => okResult());
    const backoffs: Backoffs = { recorded: [], window: {} };
    const { router } = build({ httpFetch, backoffs });
    const res = await router.fetch('https://example.com/page') as RawFetchResult;
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it('NEGATIVE: an EXPIRED backoff window fetches normally (origin IS hit)', async () => {
    const httpFetch = vi.fn(async () => okResult());
    const backoffs: Backoffs = { recorded: [], window: { 'example.com': Date.now() - 1000 } };
    const { router } = build({ httpFetch, backoffs });
    await router.fetch('https://example.com/page');
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('stealth mode ALSO respects an active backoff window (does not hammer the origin)', async () => {
    const httpFetch = vi.fn(async () => okResult());
    const backoffs: Backoffs = { recorded: [], window: { 'example.com': Date.now() + 120_000 } };
    const { router } = build({ httpFetch, backoffs });
    const res = await router.fetch('https://example.com/page', { mode: 'stealth' }) as RawFetchResult;
    expect(httpFetch).not.toHaveBeenCalled();
    expect((res as { statusCode?: number }).statusCode).toBe(429);
  });
});

describe('SmartRouter politeness — 403 single UA-rotation retry', () => {
  const originalEnv = process.env;
  beforeEach(() => { process.env = { ...originalEnv, WIGOLO_TLS_TIER: 'off' }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('retries a bare 403 EXACTLY once with a rotated User-Agent, then returns the 2nd success', async () => {
    let call = 0;
    const httpFetch = vi.fn(async (_url: string, o?: { headers?: Record<string, string> }) => {
      call += 1;
      if (call === 1) return bare403Result();
      // Second attempt succeeds.
      return okResult();
    });
    const { router, httpFetch: hf } = build({ httpFetch });
    const res = await router.fetch('https://example.com/page') as RawFetchResult;
    expect(hf).toHaveBeenCalledTimes(2);
    // The retry advertised a different UA than the first attempt.
    const ua1 = hf.mock.calls[0][1]?.headers?.['User-Agent'];
    const ua2 = hf.mock.calls[1][1]?.headers?.['User-Agent'];
    expect(ua2).toBe(resolveStealthUA());
    expect(ua2).not.toBe(ua1);
    expect(res.statusCode).toBe(200);
  });

  it('does NOT set a backoff window for a 403 (403 is not a rate-limit)', async () => {
    const httpFetch = vi.fn(async () => bare403Result());
    const { router, backoffs } = build({ httpFetch });
    await router.fetch('https://example.com/page');
    expect(backoffs.recorded).toHaveLength(0);
  });

  it('a still-blocked bare 403 retries exactly once then falls through unchanged (no loop)', async () => {
    // TLS off + bare 403 (no challenge body): the existing ladder passes the
    // 403 through rather than escalating. The retry must be bounded to one —
    // exactly two HTTP attempts, no infinite loop, unchanged downstream.
    const httpFetch = vi.fn(async () => bare403Result());
    const { router, httpFetch: hf, browserPool } = build({ httpFetch });
    const res = await router.fetch('https://example.com/page') as RawFetchResult;
    expect(hf).toHaveBeenCalledTimes(2);
    expect(browserPool.fetchWithBrowser).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('NEGATIVE: a 403 WITH a challenge body does NOT retry — it escalates directly (TLS off)', async () => {
    // A challenge-body 403 is a strong wall; a UA rotation cannot clear it, so
    // the retry must NOT fire — exactly one HTTP attempt, then escalation.
    const CHALLENGE = '<html><head><title>Just a moment...</title></head><body><div class="cf-browser-verification"></div></body></html>';
    const httpFetch = vi.fn(async (url: string) => ({
      url, finalUrl: url, html: CHALLENGE, contentType: 'text/html', statusCode: 403, headers: {},
    }));
    const { router, httpFetch: hf, browserPool } = build({ httpFetch });
    await router.fetch('https://example.com/page');
    expect(hf).toHaveBeenCalledTimes(1);
    expect(browserPool.fetchWithBrowser).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE: a 200 response never triggers a rotation retry', async () => {
    const httpFetch = vi.fn(async () => okResult());
    const { router, httpFetch: hf } = build({ httpFetch });
    await router.fetch('https://example.com/page');
    expect(hf).toHaveBeenCalledTimes(1);
  });
});
