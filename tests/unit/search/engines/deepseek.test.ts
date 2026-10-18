import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DeepseekEngine } from '../../../../src/search/engines/deepseek.js';
import type { RawSearchResult } from '../../../../src/types.js';

vi.mock('../../../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const config = { deepseekApiKey: 'test-key' as string | null };

vi.mock('../../../../src/config.js', () => ({
  getConfig: () => config,
}));

interface FetchCall {
  url: string;
  init: RequestInit;
}

function captureFetch(payload: unknown, status = 200) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

describe('DeepseekEngine', () => {
  beforeEach(() => {
    config.deepseekApiKey = 'test-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the query to the DeepSeek search endpoint with bearer auth', async () => {
    const calls = captureFetch({ results: [] });

    await new DeepseekEngine().search('quantum widgets', { maxResults: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.deepseek.com/v1/tools/search');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({ 'Authorization': 'Bearer test-key' });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ query: 'quantum widgets', count: 5 });
  });

  it('throws when the key is absent, without hitting the network', async () => {
    config.deepseekApiKey = null;
    const calls = captureFetch({ results: [] });

    await expect(new DeepseekEngine().search('widgets')).rejects.toThrow('DEEPSEEK_API_KEY not set');
    expect(calls).toHaveLength(0);
  });

  it('maps a result onto RawSearchResult, preferring the summary as the snippet', async () => {
    captureFetch({
      results: [
        {
          title: 'DeepSeek V4 release notes',
          url: 'https://api-docs.deepseek.com/news/v4',
          snippet: 'short raw snippet',
          summary: '  Longer model summary.  ',
          rerank_score: 2.25,
          date: '2026-10-01',
        },
      ],
    });

    const results = await new DeepseekEngine().search('deepseek v4');

    expect(results).toEqual([
      {
        title: 'DeepSeek V4 release notes',
        url: 'https://api-docs.deepseek.com/news/v4',
        snippet: 'Longer model summary.',
        relevance_score: 0.75,
        engine: 'deepseek',
        published_date: '2026-10-01',
      },
    ] satisfies RawSearchResult[]);
  });

  it('falls back to the raw snippet when the summary is empty', async () => {
    captureFetch({
      results: [
        { title: 't', url: 'https://example.com/a', summary: '   ', snippet: 'raw text', rerank_score: 1.5 },
      ],
    });

    const results = await new DeepseekEngine().search('q');

    expect(results[0].snippet).toBe('raw text');
  });

  it('falls back to position scoring when no rerank_score is present', async () => {
    captureFetch({
      results: [
        { title: 'first', url: 'https://example.com/1' },
        { title: 'second', url: 'https://example.com/2' },
      ],
    });

    const results = await new DeepseekEngine().search('q');

    expect(results[0].relevance_score).toBe(1);
    expect(results[1].relevance_score).toBe(0.5);
  });

  it('drops results missing a title or url', async () => {
    captureFetch({
      results: [
        { title: 'no url' },
        { url: 'https://example.com/no-title' },
        { title: 'kept', url: 'https://example.com/kept' },
      ],
    });

    const results = await new DeepseekEngine().search('q');

    expect(results).toHaveLength(1);
    expect(results[0].url).toBe('https://example.com/kept');
  });

  it('clamps the count to the documented 1-50 range', async () => {
    const calls = captureFetch({ results: [] });

    await new DeepseekEngine().search('q', { maxResults: 999 });
    expect(JSON.parse(String(calls[0].init.body)).count).toBe(50);

    await new DeepseekEngine().search('q', { maxResults: 0 });
    expect(JSON.parse(String(calls[1].init.body)).count).toBe(1);
  });

  it('throws with the status on a non-2xx response', async () => {
    captureFetch({ error: { message: 'nope' } }, 429);

    await expect(new DeepseekEngine().search('q')).rejects.toThrow('DeepSeek returned 429');
  });

  it('tolerates a response without a results array', async () => {
    captureFetch({});

    await expect(new DeepseekEngine().search('q')).resolves.toEqual([]);
  });
});
