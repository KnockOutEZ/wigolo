import { beforeEach, describe, expect, it } from 'vitest';
import {
  WigoloClient,
  WigoloApiError,
  WigoloConnectionError,
  manifest,
} from '../src/index.js';
import { scrubWigoloEnv, stubFetch } from './helpers.js';

beforeEach(() => {
  scrubWigoloEnv();
});

describe('auth header', () => {
  it('omits Authorization when no token is configured', async () => {
    const { fetch, calls } = stubFetch({ body: '{"results":[]}' });
    const client = new WigoloClient({ fetch });
    await client.search({ query: 'x' });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('sends a bearer header when a token is configured', async () => {
    const { fetch, calls } = stubFetch({ body: '{}' });
    const client = new WigoloClient({ token: 'sekret', fetch });
    await client.search({ query: 'x' });
    expect(calls[0].headers.Authorization).toBe('Bearer sekret');
  });
});

describe('URL joining', () => {
  it('joins base and manifest path, tolerating a trailing slash', async () => {
    const { fetch, calls } = stubFetch({ body: '{}' });
    const client = new WigoloClient({ baseUrl: 'http://host:9/', fetch });
    await client.fetch({ url: 'https://example.com' });
    expect(calls[0].url).toBe('http://host:9/v1/fetch');
    expect(calls[0].method).toBe('POST');
  });

  it('posts the params object verbatim as the JSON body', async () => {
    const { fetch, calls } = stubFetch({ body: '{}' });
    const client = new WigoloClient({ fetch });
    await client.crawl({ url: 'https://a.example', strategy: 'map', max_pages: 3 });
    expect(JSON.parse(calls[0].body ?? '{}')).toEqual({
      url: 'https://a.example',
      strategy: 'map',
      max_pages: 3,
    });
  });
});

describe('error envelope mapping', () => {
  it('maps a non-2xx envelope to a WigoloApiError with fields', async () => {
    const { fetch } = stubFetch({
      status: 400,
      ok: false,
      body: JSON.stringify({
        ok: false,
        error: 'bad thing',
        error_reason: 'invalid_input',
        stage: 'validate',
      }),
    });
    const client = new WigoloClient({ fetch });
    const err = await client.search({ query: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WigoloApiError);
    const api = err as WigoloApiError;
    expect(api.status).toBe(400);
    expect(api.error).toBe('bad thing');
    expect(api.error_reason).toBe('invalid_input');
    expect(api.stage).toBe('validate');
  });

  it('parses Retry-After (case-insensitive) on a 429', async () => {
    const { fetch } = stubFetch({
      status: 429,
      ok: false,
      headers: { 'retry-after': '5' },
      body: JSON.stringify({ ok: false, error: 'busy', error_reason: 'too_many_requests' }),
    });
    const client = new WigoloClient({ fetch });
    const err = (await client.search({ query: 'x' }).catch((e: unknown) => e)) as WigoloApiError;
    expect(err.status).toBe(429);
    expect(err.retryAfter).toBe(5);
  });

  it('falls back to a raw body snippet when the error body is not JSON', async () => {
    const { fetch } = stubFetch({ status: 502, ok: false, body: '<html>gateway</html>' });
    const client = new WigoloClient({ fetch });
    const err = (await client.fetch({ url: 'x' }).catch((e: unknown) => e)) as WigoloApiError;
    expect(err).toBeInstanceOf(WigoloApiError);
    expect(err.status).toBe(502);
    expect(err.error).toContain('gateway');
    expect(err.error_reason).toBeUndefined();
  });
});

describe('D9 — degraded 200 is returned, never thrown', () => {
  it('returns a 200 body carrying an in-band error field', async () => {
    const { fetch } = stubFetch({
      status: 200,
      body: JSON.stringify({ results: [], error: 'all engines failed' }),
    });
    const client = new WigoloClient({ fetch });
    const res = await client.search({ query: 'x' });
    expect(res.error).toBe('all engines failed');
    expect(res.results).toEqual([]);
  });

  it('returns a 200 body carrying an in-band warning field', async () => {
    const { fetch } = stubFetch({
      status: 200,
      body: JSON.stringify({ results: [{ url: 'u' }], warning: 'partial' }),
    });
    const client = new WigoloClient({ fetch });
    const res = await client.search({ query: 'x' });
    expect(res.warning).toBe('partial');
  });
});

describe('timeout resolution', () => {
  it('uses the manifest default timeout per tool when nothing overrides it', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const fetch = ((_input: string, init: { signal?: AbortSignal }) => {
      seen.push(init.signal);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => '{}',
      });
    }) as unknown as import('../src/index.js').FetchLike;
    const client = new WigoloClient({ fetch });
    await client.research({ question: 'q' });
    // The signal is a live AbortSignal wired to the manifest deadline.
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(manifest.research.defaultTimeoutMs).toBe(315000);
  });

  it('a per-call timeout of 0 aborts immediately → connection error', async () => {
    // AbortSignal.timeout(0) fires on the next tick; a slow fetch is aborted.
    const fetch = ((_input: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'TimeoutError';
          reject(e);
        });
      })) as unknown as import('../src/index.js').FetchLike;
    const client = new WigoloClient({ fetch });
    const err = await client.search({ query: 'x' }, { timeoutMs: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WigoloConnectionError);
  });
});

describe('env-read guard', () => {
  it('does not crash construction when process.env access throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'process');
    const throwingProcess = {
      get env(): never {
        throw new Error('NotCapable');
      },
    };
    Object.defineProperty(globalThis, 'process', {
      value: throwingProcess,
      configurable: true,
    });
    try {
      expect(() => new WigoloClient({ fetch: stubFetch({}).fetch })).not.toThrow();
      const client = new WigoloClient({ fetch: stubFetch({}).fetch });
      expect(client.baseUrl).toBe('http://127.0.0.1:3333');
      expect(client.token).toBeUndefined();
    } finally {
      if (original) Object.defineProperty(globalThis, 'process', original);
    }
  });
});

describe('env resolution precedence', () => {
  it('reads WIGOLO_BASE_URL / WIGOLO_API_TOKEN when options are absent', () => {
    process.env.WIGOLO_BASE_URL = 'http://env-host:1234';
    process.env.WIGOLO_API_TOKEN = 'env-token';
    const client = new WigoloClient({ fetch: stubFetch({}).fetch });
    expect(client.baseUrl).toBe('http://env-host:1234');
    expect(client.token).toBe('env-token');
  });

  it('ignores env entirely when the option is explicit', () => {
    process.env.WIGOLO_BASE_URL = 'http://env-host:1234';
    process.env.WIGOLO_API_TOKEN = 'env-token';
    const client = new WigoloClient({
      baseUrl: 'http://explicit:9',
      token: 'explicit-token',
      fetch: stubFetch({}).fetch,
    });
    expect(client.baseUrl).toBe('http://explicit:9');
    expect(client.token).toBe('explicit-token');
  });

  it('the core client ignores WIGOLO_LOCAL entirely', () => {
    process.env.WIGOLO_LOCAL = '1';
    const client = new WigoloClient({ fetch: stubFetch({}).fetch });
    // Still points at the default base; WIGOLO_LOCAL never influences the core.
    expect(client.baseUrl).toBe('http://127.0.0.1:3333');
  });
});

describe('connection error naming', () => {
  it('names createLocalClient on a connection-refused failure', async () => {
    const fetch = (() => {
      const e = new Error('connect ECONNREFUSED 127.0.0.1:3333');
      return Promise.reject(e);
    }) as unknown as import('../src/index.js').FetchLike;
    const client = new WigoloClient({ fetch });
    const err = (await client.search({ query: 'x' }).catch((e: unknown) => e)) as WigoloConnectionError;
    expect(err).toBeInstanceOf(WigoloConnectionError);
    expect(err.message).toContain('createLocalClient');
    expect(err.message).toContain('@wigolo/sdk/local');
  });
});
