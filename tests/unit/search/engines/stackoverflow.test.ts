import { describe, it, expect, vi, afterEach } from 'vitest';
import { StackOverflowEngine } from '../../../../src/search/engines/stackoverflow.js';

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

describe('StackOverflowEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to stackoverflow', () => {
    expect(new StackOverflowEngine().name).toBe('stackoverflow');
  });

  it('maps a successful response and strips HTML from snippet', async () => {
    const body = {
      items: [
        {
          title: 'How to use TypeScript generics?',
          link: 'https://stackoverflow.com/questions/1/typescript-generics',
          body: '<p>Use <code>T</code> like so:</p><pre>function f&lt;T&gt;(x: T){}</pre>',
          score: 42,
          is_answered: true,
          creation_date: 1693000000,
          tags: ['typescript', 'generics'],
        },
      ],
    };
    captureFetch(body);
    const results = await new StackOverflowEngine().search('typescript generics');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('How to use TypeScript generics?');
    expect(results[0].url).toBe('https://stackoverflow.com/questions/1/typescript-generics');
    expect(results[0].engine).toBe('stackoverflow');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].snippet).not.toContain('<p>');
    expect(results[0].snippet).not.toContain('</p>');
    expect(results[0].snippet).toContain('Use');
    expect(results[0].published_date).toBe(new Date(1693000000 * 1000).toISOString());
  });

  it('encodes fromDate and toDate as epoch seconds', async () => {
    const { calls } = captureFetch({ items: [] });
    await new StackOverflowEngine().search('q', {
      fromDate: '2024-01-01T00:00:00Z',
      toDate: '2024-12-31T00:00:00Z',
    });
    const from = Math.floor(new Date('2024-01-01T00:00:00Z').getTime() / 1000);
    const to = Math.floor(new Date('2024-12-31T00:00:00Z').getTime() / 1000);
    expect(calls[0].url).toContain(`fromdate=${from}`);
    expect(calls[0].url).toContain(`todate=${to}`);
  });

  it('returns empty array on empty items', async () => {
    captureFetch({ items: [] });
    expect(await new StackOverflowEngine().search('q')).toEqual([]);
  });

  it('throws when HTTP response is not ok', async () => {
    captureFetch({}, false, 503);
    await expect(new StackOverflowEngine().search('q')).rejects.toThrow(/StackOverflow returned 503/);
  });

  it('truncates snippet to ~200 chars', async () => {
    const longBody = '<p>' + 'x'.repeat(500) + '</p>';
    const body = {
      items: [
        {
          title: 't',
          link: 'https://stackoverflow.com/questions/1/t',
          body: longBody,
          score: 1,
          is_answered: false,
          creation_date: 1700000000,
          tags: [],
        },
      ],
    };
    captureFetch(body);
    const results = await new StackOverflowEngine().search('q');
    expect(results[0].snippet.length).toBeLessThanOrEqual(200);
  });

  it('encodes pagesize from maxResults', async () => {
    const { calls } = captureFetch({ items: [] });
    await new StackOverflowEngine().search('q', { maxResults: 7 });
    expect(calls[0].url).toContain('pagesize=7');
  });

  it('passes AbortSignal to fetch', async () => {
    const { calls } = captureFetch({ items: [] });
    await new StackOverflowEngine().search('q');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});
