import { describe, it, expect, vi, afterEach } from 'vitest';
import { MdnEngine } from '../../../../src/search/engines/mdn.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(body: unknown, ok = true, status = 200): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { calls };
}

describe('MdnEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to mdn', () => {
    expect(new MdnEngine().name).toBe('mdn');
  });

  it('maps a successful response and prefixes URL host', async () => {
    const body = {
      documents: [
        {
          mdn_url: '/en-US/docs/Web/API/fetch',
          title: 'fetch()',
          summary: 'The fetch() method starts a request.',
          score: 12.3,
        },
        {
          mdn_url: '/en-US/docs/Web/API/Response',
          title: 'Response',
          summary: 'Response interface of the Fetch API.',
          score: 8,
        },
      ],
    };
    captureFetch(body);
    const results = await new MdnEngine().search('fetch');

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('fetch()');
    expect(results[0].url).toBe('https://developer.mozilla.org/en-US/docs/Web/API/fetch');
    expect(results[0].snippet).toBe('The fetch() method starts a request.');
    expect(results[0].engine).toBe('mdn');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBeUndefined();
    expect(results[1].relevance_score).toBe(0.5);
  });

  it('returns empty array on empty documents', async () => {
    captureFetch({ documents: [] });
    expect(await new MdnEngine().search('q')).toEqual([]);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 502);
    await expect(new MdnEngine().search('q')).rejects.toThrow(/MDN returned 502/);
  });

  it('encodes size from maxResults', async () => {
    const { calls } = captureFetch({ documents: [] });
    await new MdnEngine().search('q', { maxResults: 8 });
    expect(calls[0].url).toContain('size=8');
  });

  it('passes AbortSignal to fetch', async () => {
    const { calls } = captureFetch({ documents: [] });
    await new MdnEngine().search('q');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
