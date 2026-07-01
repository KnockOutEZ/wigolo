import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { GithubCodeEngine } from '../../../../src/search/engines/github-code.js';
import { resetConfig } from '../../../../src/config.js';

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
  beforeEach(() => {
    delete process.env.WIGOLO_GITHUB_TOKEN;
    resetConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.WIGOLO_GITHUB_TOKEN;
    resetConfig();
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
    // S11b: snippet now concatenates description + path when both exist so
    // lexical alignment downstream has more token overlap with the query.
    expect(results[0].snippet).toBe('an example repo — src/foo.ts');
    expect(results[0].engine).toBe('github-code');
    expect(results[0].relevance_score).toBe(1);
    expect(results[0].published_date).toBeUndefined();
    // When description is null, snippet falls back to path alone (same as
    // pre-S11b behavior so we don't pad noise into the snippet).
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

  // github-code previously returned 401 without any hint about the env-var
  // fix. The engine_warnings registry already maps 401 →
  // WIGOLO_GITHUB_TOKEN; this test asserts the adapter actually reads the
  // token from config when it is set, so authenticated users avoid the 401
  // altogether (and the hint stays useful for the unauthenticated path).
  it('github-code 401 — attaches Bearer auth when WIGOLO_GITHUB_TOKEN is set', async () => {
    process.env.WIGOLO_GITHUB_TOKEN = 'ghp_test_token_value';
    resetConfig();
    const { calls } = captureFetch({ items: [] });
    await new GithubCodeEngine().search('q');
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer ghp_test_token_value');
  });

  it('github-code 401 — does NOT attach Authorization header when token unset', async () => {
    // Unauthed mode is still supported (the engine_warnings hint covers the
    // 401 path). The adapter must not fabricate an empty Bearer header.
    const { calls } = captureFetch({ items: [] });
    await new GithubCodeEngine().search('q');
    const headers = calls[0].init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  // Thin-snippet improvement. The previous parser used either
  // the repo description OR the file path, never both — losing token overlap
  // with the query when only one was present. This was a
  // "thin snippet" case. The improved parser concatenates both so lexical
  // alignment (downstream score component) has more surface area.
  it('thin snippet — snippet includes both repo description and path when both are available', async () => {
    const body = {
      items: [
        {
          name: 'config.ts',
          path: 'packages/server/src/config.ts',
          html_url: 'https://github.com/acme/x/blob/sha/packages/server/src/config.ts',
          repository: { full_name: 'acme/x', description: 'tooling for config-driven apps' },
        },
      ],
    };
    captureFetch(body);
    const results = await new GithubCodeEngine().search('config');
    expect(results[0].snippet).toContain('tooling for config-driven apps');
    expect(results[0].snippet).toContain('packages/server/src/config.ts');
  });

  it('audit: github-code 401 — error message still matches the engine_warnings registry regex', async () => {
    // The engine_warnings module extracts the HTTP status from the engine
    // error string. If the adapter's error shape drifts, the 401-hint test
    // in engine-warnings.test.ts would still pass while real callers see
    // no hint. Lock the shape here.
    captureFetch({ message: 'bad credentials' }, false, 401);
    await expect(new GithubCodeEngine().search('q')).rejects.toThrow(/GitHub code returned 401/);
  });
});
