import { describe, it, expect, vi, afterEach } from 'vitest';
import { PypiEngine, candidatesFromQuery } from '../../../../src/search/engines/pypi.js';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function captureFetch(
  handler: (url: string) => { body: unknown; ok?: boolean; status?: number },
): {
  calls: FetchCall[];
  restore: () => void;
} {
  const calls: FetchCall[] = [];
  const spy = vi.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const { body, ok = true, status = 200 } = handler(url);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  return { calls, restore: () => spy.mockRestore() };
}

function projectBody(overrides: Record<string, unknown> = {}) {
  return {
    info: {
      name: 'httpx',
      version: '0.28.1',
      summary: 'The next generation HTTP client.',
      yanked: false,
      package_url: 'https://pypi.org/project/httpx/',
      project_url: 'https://pypi.org/project/httpx/',
      ...overrides,
    },
    urls: [{ upload_time_iso_8601: '2024-12-06T15:37:21.509172Z' }],
  };
}

describe('candidatesFromQuery', () => {
  it('normalizes a single token with PEP 503 rules', () => {
    expect(candidatesFromQuery('Django', 5)).toEqual(['django']);
    expect(candidatesFromQuery('scikit_learn', 5)).toEqual(['scikit-learn']);
  });

  it('tries the hyphenated full query before per-token names', () => {
    expect(candidatesFromQuery('google cloud storage', 5)).toEqual([
      'google-cloud-storage',
      'google',
      'cloud',
      'storage',
    ]);
  });

  it('drops grammatical stopwords and empty queries', () => {
    expect(candidatesFromQuery('how to use requests', 5)).toEqual(['requests']);
    expect(candidatesFromQuery('   ', 5)).toEqual([]);
  });

  it('caps the candidate list', () => {
    expect(candidatesFromQuery('alpha beta gamma delta epsilon zeta', 2)).toHaveLength(2);
  });

  it('rejects path-like and URL tokens so they never reach the lookup URL', () => {
    expect(candidatesFromQuery('../etc/passwd', 5)).toEqual([]);
    expect(candidatesFromQuery('foo/bar', 5)).toEqual([]);
    expect(candidatesFromQuery('https://evil.example/httpx', 5)).toEqual([]);
  });
});

describe('PypiEngine', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('has name set to pypi', () => {
    expect(new PypiEngine().name).toBe('pypi');
  });

  it('maps a successful response to RawSearchResult fields', async () => {
    captureFetch(() => ({ body: projectBody() }));
    const results = await new PypiEngine().search('httpx');

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('httpx');
    expect(results[0].url).toBe('https://pypi.org/project/httpx/');
    expect(results[0].engine).toBe('pypi');
    expect(results[0].snippet).toBe('The next generation HTTP client. (v0.28.1)');
    expect(results[0].published_date).toBe('2024-12-06T15:37:21.509172Z');
    expect(results[0].relevance_score).toBe(1);
  });

  it('uses a version-only snippet when summary is missing', async () => {
    captureFetch(() => ({ body: projectBody({ summary: null, package_url: undefined, project_url: undefined }) }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].snippet).toBe('(v0.28.1)');
    expect(results[0].url).toBe('https://pypi.org/project/httpx');
  });

  it('skips projects without a usable name', async () => {
    captureFetch(() => ({ body: projectBody({ name: null }) }));
    const results = await new PypiEngine().search('httpx');
    expect(results).toEqual([]);
  });

  it('skips yanked projects', async () => {
    captureFetch(() => ({ body: projectBody({ yanked: true }) }));
    const results = await new PypiEngine().search('httpx');
    expect(results).toEqual([]);
  });

  it('ignores package_url values that are not pypi.org project pages', async () => {
    captureFetch(() => ({
      body: projectBody({ package_url: 'https://evil.example/phish', project_url: 'https://evil.example/phish' }),
    }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].url).toBe('https://pypi.org/project/httpx');
  });

  it('ignores http package_url values even when the host is pypi.org', async () => {
    captureFetch(() => ({
      body: projectBody({
        package_url: 'http://pypi.org/project/httpx/',
        project_url: 'http://pypi.org/project/httpx/',
      }),
    }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].url).toBe('https://pypi.org/project/httpx');
  });

  it('sets a descriptive User-Agent header', async () => {
    const { calls } = captureFetch(() => ({ body: projectBody() }));
    await new PypiEngine().search('httpx');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('wigolo');
    expect(headers['User-Agent']).toContain('https://github.com/KnockOutEZ/wigolo');
  });

  it('encodes the project name in the JSON lookup URL', async () => {
    const { calls } = captureFetch(() => ({ body: projectBody({ name: 'Django' }) }));
    await new PypiEngine().search('Django');
    expect(calls.map((c) => c.url)).toEqual(['https://pypi.org/pypi/django/json']);
  });

  it('looks up the hyphenated query then name-like tokens', async () => {
    const { calls } = captureFetch((url) => {
      if (url.includes('/pypi/scikit-learn/json')) {
        return { body: projectBody({ name: 'scikit-learn', package_url: 'https://pypi.org/project/scikit-learn/' }) };
      }
      return { body: {}, ok: false, status: 404 };
    });
    const results = await new PypiEngine().search('scikit learn');
    expect(calls.map((c) => c.url)).toEqual([
      'https://pypi.org/pypi/scikit-learn/json',
      'https://pypi.org/pypi/scikit/json',
      'https://pypi.org/pypi/learn/json',
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('scikit-learn');
  });

  it('does not fetch when the query has no project-name tokens', async () => {
    const { calls } = captureFetch(() => ({ body: projectBody() }));
    const results = await new PypiEngine().search('how to use python');
    expect(calls).toHaveLength(0);
    expect(results).toEqual([]);
  });

  it('treats 404 as no match and keeps looking', async () => {
    captureFetch((url) => {
      if (url.includes('/pypi/httpx/json')) return { body: projectBody() };
      return { body: {}, ok: false, status: 404 };
    });
    const results = await new PypiEngine().search('missing httpx');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('httpx');
  });

  it('treats 400 as no match and keeps looking', async () => {
    captureFetch((url) => {
      if (url.includes('/pypi/httpx/json')) return { body: projectBody() };
      return { body: {}, ok: false, status: 400 };
    });
    const results = await new PypiEngine().search('bad httpx');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('httpx');
  });

  it('skips a non-object JSON payload and continues', async () => {
    captureFetch((url) => {
      if (url.includes('/pypi/httpx/json')) return { body: projectBody() };
      return { body: [] };
    });
    const results = await new PypiEngine().search('missing httpx');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('httpx');
  });

  it('skips a null JSON payload and continues', async () => {
    captureFetch((url) => {
      if (url.includes('/pypi/httpx/json')) return { body: projectBody() };
      return { body: null };
    });
    const results = await new PypiEngine().search('missing httpx');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('httpx');
  });

  it('omits published_date when urls is not an array', async () => {
    captureFetch(() => ({
      body: { ...projectBody(), urls: { upload_time_iso_8601: '2024-01-01T00:00:00Z' } },
    }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].published_date).toBeUndefined();
  });

  it('uses the latest file upload time, not urls[0]', async () => {
    captureFetch(() => ({
      body: {
        ...projectBody(),
        urls: [
          { upload_time_iso_8601: '2024-01-01T00:00:00.000000Z' },
          { upload_time_iso_8601: '2024-12-06T15:37:21.509172Z' },
        ],
      },
    }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].published_date).toBe('2024-12-06T15:37:21.509172Z');
  });

  it('ignores malformed upload timestamps and keeps a valid one', async () => {
    captureFetch(() => ({
      body: {
        ...projectBody(),
        urls: [
          { upload_time_iso_8601: 'garbage' },
          { upload_time_iso_8601: '2024-99-99T00:00:00Z' },
          { upload_time_iso_8601: '2024-12-06T15:37:21.509172Z' },
        ],
      },
    }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].published_date).toBe('2024-12-06T15:37:21.509172Z');
  });

  it('compares upload times as instants, not lexicographically', async () => {
    captureFetch(() => ({
      body: {
        ...projectBody(),
        urls: [
          { upload_time_iso_8601: '2024-01-01T00:30:00+01:00' },
          { upload_time_iso_8601: '2024-01-01T00:00:00Z' },
        ],
      },
    }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].published_date).toBe('2024-01-01T00:00:00Z');
  });

  it('omits published_date when every upload timestamp is malformed', async () => {
    captureFetch(() => ({
      body: {
        ...projectBody(),
        urls: [{ upload_time_iso_8601: 'not-a-timestamp' }],
      },
    }));
    const results = await new PypiEngine().search('httpx');
    expect(results[0].published_date).toBeUndefined();
  });

  it('stops after maxResults valid packages', async () => {
    const { calls } = captureFetch((url) => {
      const name = url.split('/pypi/')[1]?.split('/json')[0];
      return { body: projectBody({ name, package_url: undefined, project_url: undefined }) };
    });
    const results = await new PypiEngine().search('httpx pydantic', { maxResults: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('httpx-pydantic');
    expect(calls).toHaveLength(1);
  });

  it('clamps candidate lookups to 5', async () => {
    const { calls } = captureFetch(() => ({ body: {}, ok: false, status: 404 }));
    await new PypiEngine().search('alpha beta gamma delta epsilon zeta eta', { maxResults: 1000 });
    expect(calls).toHaveLength(5);
  });

  it('passes timeoutMs to AbortSignal.timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    captureFetch(() => ({ body: projectBody() }));
    await new PypiEngine().search('httpx', { timeoutMs: 1500 });
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
  });

  it('throws when HTTP response is not ok (other than 404/400)', async () => {
    captureFetch(() => ({ body: {}, ok: false, status: 503 }));
    await expect(new PypiEngine().search('httpx')).rejects.toThrow(/pypi returned 503/);
  });

  it('propagates fetch errors (timeout/network)', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('aborted'));
    await expect(new PypiEngine().search('httpx')).rejects.toThrow(/aborted/);
  });

  it('does not count 404s toward maxResults', async () => {
    const { calls } = captureFetch((url) => {
      if (url.includes('/pypi/httpx-pydantic/json')) return { body: {}, ok: false, status: 404 };
      const name = url.split('/pypi/')[1]?.split('/json')[0];
      return { body: projectBody({ name, package_url: undefined, project_url: undefined }) };
    });
    const results = await new PypiEngine().search('httpx pydantic', { maxResults: 1 });
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('httpx');
    expect(calls.map((c) => c.url)).toEqual([
      'https://pypi.org/pypi/httpx-pydantic/json',
      'https://pypi.org/pypi/httpx/json',
    ]);
  });
});
