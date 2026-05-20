import { describe, it, expect, vi, afterEach } from 'vitest';
import { GithubCodeEngine } from '../../../../src/search/engines/github-code.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(body: unknown, ok = true, status = 200): {
  calls: FetchCall[];
} {
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

describe('GithubCodeEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to github-code', () => {
    expect(new GithubCodeEngine().name).toBe('github-code');
  });

  it('maps a successful response into RawSearchResult fields', async () => {
    const body = {
      items: [
        {
          name: 'foo.ts',
          path: 'src/foo.ts',
          html_url: 'https://github.com/user/repo/blob/sha/src/foo.ts',
          repository: { full_name: 'user/repo', description: 'an example repo' },
        },
        {
          name: 'bar.ts',
          path: 'src/bar.ts',
          html_url: 'https://github.com/user/repo/blob/sha/src/bar.ts',
          repository: { full_name: 'user/repo', description: null },
        },
      ],
    };
    captureFetch(body);
    const results = await new GithubCodeEngine().search('foo');

    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('user/repo — src/foo.ts');
    expect(results[0].url).toBe('https://github.com/user/repo/blob/sha/src/foo.ts');
    expect(results[0].snippet).toBe('an example repo');
    expect(results[0].engine).toBe('github-code');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBeUndefined();
    expect(results[1].snippet).toBe('src/bar.ts');
  });

  it('throws a rate-limit error on 403', async () => {
    captureFetch({ message: 'rate limited' }, false, 403);
    await expect(new GithubCodeEngine().search('q')).rejects.toThrow(/GitHub code rate-limited/);
  });

  it('throws on other non-ok responses', async () => {
    captureFetch({}, false, 500);
    await expect(new GithubCodeEngine().search('q')).rejects.toThrow(/GitHub code returned 500/);
  });

  it('returns empty array on empty items', async () => {
    captureFetch({ items: [] });
    expect(await new GithubCodeEngine().search('q')).toEqual([]);
  });

  it('throws on malformed JSON', async () => {
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('invalid json');
        },
      } as unknown as Response;
    });
    await expect(new GithubCodeEngine().search('q')).rejects.toThrow(/invalid json/);
  });

  it('passes AbortSignal.timeout to fetch', async () => {
    const { calls } = captureFetch({ items: [] });
    await new GithubCodeEngine().search('q', { timeoutMs: 5000 });
    expect(calls[0].init?.signal).toBeDefined();
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('encodes per_page from maxResults', async () => {
    const { calls } = captureFetch({ items: [] });
    await new GithubCodeEngine().search('q', { maxResults: 15 });
    expect(calls[0].url).toContain('per_page=15');
  });
});
