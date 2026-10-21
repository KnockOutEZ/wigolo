import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/fetch/auth.js', () => ({
  getAuthOptions: vi.fn(async () => null),
}));

// Report the engine "ready" without a real install so browser-tier paths reach
// the mocked browserPool (mirrors router-escape-hatch.test.ts).
vi.mock('../../../src/fetch/browser-acquire.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fetch/browser-acquire.js')>();
  return {
    ...actual,
    BrowserAcquirer: class {
      ensureBrowser = vi.fn(async () => 'ready');
    },
  };
});

import { SmartRouter } from '../../../src/fetch/router.js';
import type { HttpClient, BrowserPoolInterface, BrowserFetchArgs } from '../../../src/fetch/router.js';
import type { RawFetchResult, StageError } from '../../../src/types.js';
import { ChallengeBlockedError } from '../../../src/fetch/browser-pool.js';

const originalEnv = process.env;

function clearedResult(url: string): RawFetchResult {
  return {
    url,
    finalUrl: url,
    html: '<html><body>real article content that cleared the challenge</body></html>',
    contentType: 'text/html',
    statusCode: 200,
    method: 'browser',
    headers: {},
  };
}

describe('SmartRouter — Part 1: challenge-block http_status plumbing', () => {
  let httpClient: HttpClient;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    httpClient = { fetch: vi.fn() };
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('surfaces http_status:403 when the challenge-block originated from a 403', async () => {
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => {
        // The pool threads the triggering anti-bot status (403) onto the error.
        throw new ChallengeBlockedError(url, undefined, undefined, 403);
      }),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    const err = result as StageError;
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.http_status).toBe(403);
  });

  it('leaves http_status unset when the challenge-block carries no known status', async () => {
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => {
        throw new ChallengeBlockedError(url);
      }),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    const err = result as StageError;
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.http_status).toBeUndefined();
  });

  it('surfaces http_status from a guarded still-challenge shell (403 result)', async () => {
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string): Promise<RawFetchResult> => ({
        url,
        finalUrl: url,
        html: '<html><body>Checking your browser before accessing</body><script src="/cdn-cgi/challenge-platform/x"></script></html>',
        contentType: 'text/html',
        statusCode: 403,
        method: 'browser',
        headers: { 'cf-mitigated': 'challenge' },
      })),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    const err = result as StageError;
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.http_status).toBe(403);
  });
});

describe('SmartRouter — Part 2: proxy-bypass direct-retry on managed challenge', () => {
  let httpClient: HttpClient;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    httpClient = { fetch: vi.fn() };
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  function proxyEnv() {
    process.env.USE_PROXY = 'true';
    process.env.PROXY_URL = 'http://proxy.example.com:8080';
    // The direct-retry is OPT-IN: bypassing an operator's configured proxy
    // leaks their real IP, so it is off unless explicitly enabled. These tests
    // exercise the enabled path; the "knob off" test below overrides it back.
    process.env.WIGOLO_PROXY_BYPASS_ON_CHALLENGE = 'true';
    resetConfig();
  }

  it('proxied + managed-challenge → ONE direct (no-proxy) retry is attempted', async () => {
    proxyEnv();
    const calls: BrowserFetchArgs[] = [];
    const fetchWithBrowser = vi.fn(async (url: string, opts: BrowserFetchArgs = {}) => {
      calls.push(opts);
      throw new ChallengeBlockedError(url, undefined, undefined, 403);
    });
    const router = new SmartRouter({
      httpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    // Two browser fetches: the original (proxied) and one forceNoProxy retry.
    expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
    expect(calls.some((c) => c.forceNoProxy === true)).toBe(true);
    expect(calls.filter((c) => c.forceNoProxy === true)).toHaveLength(1);
  });

  it('a direct-retry that CLEARS returns content (not blocked_by_challenge)', async () => {
    proxyEnv();
    let attempt = 0;
    const fetchWithBrowser = vi.fn(async (url: string) => {
      attempt += 1;
      if (attempt === 1) throw new ChallengeBlockedError(url, undefined, undefined, 403);
      return clearedResult(url);
    });
    const router = new SmartRouter({
      httpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    expect((result as StageError).error).toBeUndefined();
    expect(result.html).toContain('cleared the challenge');
    expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
  });

  it('non-thrown guarded still-challenge shell + proxy retry that also reblocks preserves http_status from raw.statusCode', async () => {
    proxyEnv();
    // Both browser attempts RETURN (never throw) a 403 challenge shell. The
    // SUCCESS-return path guards the shell into a blocked_by_challenge StageError,
    // the proxy direct-retry runs and reblocks (returns null), and control falls
    // through to `return guarded`. http_status must survive from raw.statusCode —
    // this is the non-thrown reblock path (the thrown path is covered above).
    const shell = (url: string): RawFetchResult => ({
      url,
      finalUrl: url,
      html: '<html><body>Checking your browser before accessing</body><script src="/cdn-cgi/challenge-platform/x"></script></html>',
      contentType: 'text/html',
      statusCode: 403,
      method: 'browser',
      headers: { 'cf-mitigated': 'challenge' },
    });
    const fetchWithBrowser = vi.fn(async (url: string): Promise<RawFetchResult> => shell(url));
    const router = new SmartRouter({
      httpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    const err = result as StageError;
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.http_status).toBe(403);
    // original (proxied) + one forceNoProxy direct retry, both reblocked.
    expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
  });

  it('knob off (WIGOLO_PROXY_BYPASS_ON_CHALLENGE=false) → NO direct retry', async () => {
    proxyEnv();
    process.env.WIGOLO_PROXY_BYPASS_ON_CHALLENGE = 'false';
    resetConfig();
    const fetchWithBrowser = vi.fn(async (url: string) => {
      throw new ChallengeBlockedError(url, undefined, undefined, 403);
    });
    const router = new SmartRouter({
      httpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    expect((result as StageError).error).toBe('blocked_by_challenge');
    expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
  });

  it('no proxy configured → no extra fetch (single attempt only)', async () => {
    // Default config: useProxy false.
    const fetchWithBrowser = vi.fn(async (url: string) => {
      throw new ChallengeBlockedError(url, undefined, undefined, 403);
    });
    const router = new SmartRouter({
      httpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    expect((result as StageError).error).toBe('blocked_by_challenge');
    expect(fetchWithBrowser).toHaveBeenCalledTimes(1);
  });

  it('direct-retry that ALSO blocks falls through to the terminal blocked_by_challenge (still preserves http_status)', async () => {
    proxyEnv();
    const fetchWithBrowser = vi.fn(async (url: string) => {
      throw new ChallengeBlockedError(url, undefined, undefined, 403);
    });
    const router = new SmartRouter({
      httpClient,
      browserPool: { fetchWithBrowser } as unknown as BrowserPoolInterface,
      pdfProbe: async () => false,
    });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    const err = result as StageError;
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.http_status).toBe(403);
    expect(fetchWithBrowser).toHaveBeenCalledTimes(2);
  });
});

describe('SmartRouter — Part 3: solve-ladder provenance on the blocked path', () => {
  let httpClient: HttpClient;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    httpClient = { fetch: vi.fn() };
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.clearAllMocks();
  });

  it('propagates the ChallengeBlockedError challengeClass onto result.challenge_class (+ solve_method null)', async () => {
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string) => {
        // The pool threads the classifier verdict + a null solve method onto the
        // error when the ladder failed to clear a behavioral challenge.
        throw new ChallengeBlockedError(url, undefined, undefined, 403, {
          challengeClass: 'behavioral',
          solveMethod: null,
        });
      }),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    const err = result as StageError;
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.challenge_class).toBe('behavioral');
    expect(err.solve_method).toBeNull();
  });

  it('a guarded still-challenge shell classifies the body → challenge_class populated, solve_method null', async () => {
    const browserPool: BrowserPoolInterface = {
      fetchWithBrowser: vi.fn(async (url: string): Promise<RawFetchResult> => ({
        url,
        finalUrl: url,
        // A managed "Just a moment" shell with the challenge-platform script and
        // no interactive widget → classifier resolves 'behavioral'.
        html: '<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body><script src="/cdn-cgi/challenge-platform/x"></script></html>',
        contentType: 'text/html',
        statusCode: 403,
        method: 'browser',
        headers: { 'cf-mitigated': 'challenge' },
      })),
    };
    const router = new SmartRouter({ httpClient, browserPool, pdfProbe: async () => false });
    const result = await router.fetch('https://blocked.example.com/x', { renderJs: 'always' });
    const err = result as StageError;
    expect(err.error).toBe('blocked_by_challenge');
    expect(err.challenge_class).toBe('behavioral');
    expect(err.solve_method).toBeNull();
  });
});
