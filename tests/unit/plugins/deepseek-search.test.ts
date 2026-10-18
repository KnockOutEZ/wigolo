import { describe, it, expect, vi } from 'vitest';
import { validateSearchEngine } from '../../../src/plugins/validate.js';
import { createDeepSeekEngine, searchEngine } from '../../../examples/plugin-deepseek-search/index.mjs';

const ENDPOINT = 'https://api.deepseek.com/v1/tools/search';
const KEY = 'test-key';

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

function fakeFetch(payload: unknown, status = 200) {
  return vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(payload, status));
}

function engineWith(fetchImpl: unknown) {
  return createDeepSeekEngine({ fetchImpl, key: KEY });
}

describe('plugin deepseek search engine', () => {
  it('exports a valid SearchEngine shape', () => {
    expect(validateSearchEngine(searchEngine)).toBe(true);
  });

  it('posts the query and count to the DeepSeek search endpoint', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    await engineWith(fetchImpl).search('quantum widgets', { maxResults: 5 });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ query: 'quantum widgets', count: 5 });
  });

  it('sends the key as a bearer token', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    await engineWith(fetchImpl).search('anything');

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers).toEqual({
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
    });
  });

  it('maps a DeepSeek result onto the RawSearchResult shape', async () => {
    const fetchImpl = fakeFetch({
      results: [
        {
          rerank_score: 2.25,
          title: 'DeepSeek V4 release notes',
          url: 'https://api-docs.deepseek.com/news/v4',
          snippet: 'raw snippet',
          summary: '  Model release summary.  ',
          content: '',
          site_name: 'DeepSeek',
          site_icon: null,
          date: '2026-10-01',
          authority: 9,
        },
      ],
    });

    const results = await engineWith(fetchImpl).search('deepseek v4');

    expect(results).toEqual([
      {
        title: 'DeepSeek V4 release notes',
        url: 'https://api-docs.deepseek.com/news/v4',
        snippet: 'Model release summary.',
        relevance_score: 0.75,
        engine: 'deepseek',
        published_date: '2026-10-01',
      },
    ]);
  });

  it('falls back to the raw snippet when summary is empty or whitespace', async () => {
    const fetchImpl = fakeFetch({
      results: [
        {
          title: 'whitespace summary',
          url: 'https://example.com/whitespace',
          summary: '   ',
          snippet: 'raw a',
          rerank_score: 1.5,
        },
        {
          title: 'empty summary',
          url: 'https://example.com/empty',
          summary: '',
          snippet: 'raw b',
          rerank_score: 1.5,
        },
      ],
    });

    const results = await engineWith(fetchImpl).search('widgets', { maxResults: 2 });

    expect(results.map(r => r.snippet)).toEqual(['raw a', 'raw b']);
  });

  it('scores a result without a rerank_score as 0', async () => {
    const fetchImpl = fakeFetch({
      results: [
        { title: 'unscored', url: 'https://example.com/unscored', snippet: 's', summary: 'summary' },
      ],
    });

    const results = await engineWith(fetchImpl).search('widgets');

    expect(results[0].relevance_score).toBe(0);
  });

  it('caps count at the API maximum of 50', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    await engineWith(fetchImpl).search('widgets', { maxResults: 999 });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init.body)).count).toBe(50);
  });

  it('floors count at the API minimum of 1', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    await engineWith(fetchImpl).search('widgets', { maxResults: 0 });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init.body)).count).toBe(1);
  });

  it('defaults count to 10 when maxResults is absent', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    await engineWith(fetchImpl).search('widgets');

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init.body)).count).toBe(10);
  });

  it('rejects on a non-2xx response with the status and the API error message', async () => {
    const fetchImpl = fakeFetch(
      {
        error: {
          message: 'Authentication Fails, Your api key is invalid',
          type: 'authentication_error',
          param: null,
          code: 'invalid_request_error',
        },
      },
      401,
    );

    await expect(engineWith(fetchImpl).search('widgets')).rejects.toThrow(
      'deepseek returned 401: Authentication Fails, Your api key is invalid',
    );
  });

  it('rejects when the body is not valid JSON', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
      text: async () => '<html>gateway error</html>',
    }));

    await expect(engineWith(fetchImpl).search('widgets')).rejects.toThrow(
      'deepseek returned an unparsable body',
    );
  });

  it('rejects when DEEPSEEK_API_KEY is not set', async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    try {
      const engine = createDeepSeekEngine({ fetchImpl: vi.fn() });
      await expect(engine.search('widgets')).rejects.toThrow('DEEPSEEK_API_KEY is not set');
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it('reads DEEPSEEK_API_KEY through createDeepSeekEngine on every call', async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'late-key';
    const fetchImpl = fakeFetch({ results: [] });
    vi.stubGlobal('fetch', fetchImpl);

    try {
      await searchEngine.search('anything');

      const [, init] = fetchImpl.mock.calls[0];
      expect(init.headers.Authorization).toBe('Bearer late-key');
    } finally {
      vi.unstubAllGlobals();
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  it('always sends a request deadline', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    await engineWith(fetchImpl).search('anything');

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('lets the caller override the request deadline', async () => {
    const fetchImpl = fakeFetch({ results: [] });
    await engineWith(fetchImpl).search('anything', { timeoutMs: 500 });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it('drops a result without a url and keeps the rest', async () => {
    const fetchImpl = fakeFetch({
      results: [
        { title: 'no url', snippet: 'gone', summary: '', rerank_score: 1.5 },
        {
          title: 'kept',
          url: 'https://example.com/kept',
          snippet: 'kept snippet',
          summary: '',
          rerank_score: 1.5,
        },
      ],
    });

    const results = await engineWith(fetchImpl).search('widgets');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/kept');
  });

  it('rejects when every result is unusable', async () => {
    const fetchImpl = fakeFetch({ results: [{ title: 'no url', snippet: 'gone' }] });

    await expect(engineWith(fetchImpl).search('widgets')).rejects.toThrow(
      'deepseek returned no usable results',
    );
  });
});
