import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));
vi.mock('../../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

function dispatch(results: RawSearchResult[]) {
  return { results, enginesUsed: ['e1'], outcomes: [], degraded: false };
}
function r(title: string, url: string, snippet = '', score = 1): RawSearchResult {
  return { title, url, snippet, relevance_score: score, engine: 'e1' };
}

describe('core-provider error-intent behaviour', () => {
  beforeEach(() => { runV1Search.mockReset(); });

  it('fires ONE extra bare-token dispatch for an error-intent query', async () => {
    runV1Search.mockResolvedValue(dispatch([r('a', 'https://a.com')]));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'ERR_MODULE_NOT_FOUND cannot find package exports subpath node esm', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    // primary + 1 bare-token variant
    expect(runV1Search).toHaveBeenCalledTimes(2);
    const variantArg = runV1Search.mock.calls[1][0].query as string;
    expect(variantArg).toBe('ERR_MODULE_NOT_FOUND');
  });

  it('does NOT fire a bare-token variant for a non-error query', async () => {
    runV1Search.mockResolvedValue(dispatch([r('a', 'https://a.com')]));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'how to center a div in css flexbox', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(1);
  });

  it('damps results that do NOT contain the atomic error token, promoting on-target ones', async () => {
    // Junk (broadcaster/dictionary) arrives ranked ABOVE the on-target page.
    runV1Search.mockResolvedValue(
      dispatch([
        r('uudised | ERR', 'https://www.err.ee/x', 'estonian broadcaster', 1.0),
        r('ERR | Cambridge Dictionary', 'https://dictionary.cambridge.org/err', 'definition of err', 0.9),
        r('Error [ERR_MODULE_NOT_FOUND]: Cannot find module', 'https://stackoverflow.com/q/1', 'node esm import', 0.5),
      ]),
    );
    const provider = new CoreSearchProvider();
    const res = await provider.search(
      { query: 'ERR_MODULE_NOT_FOUND cannot find package', search_depth: 'balanced', include_content: false },
      { router: undefined } as never,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The on-target result (contains the token) must now rank first.
    expect(res.data.results[0].url).toBe('https://stackoverflow.com/q/1');
    // The broadcaster/dictionary junk is demoted below it.
    const topUrls = res.data.results.slice(0, 1).map((x) => x.url);
    expect(topUrls).not.toContain('https://www.err.ee/x');
  });

  it('does NOT reorder results for a non-error query (gate is per-error-intent)', async () => {
    runV1Search.mockResolvedValue(
      dispatch([
        r('React docs', 'https://react.dev/a', 'hooks', 1.0),
        r('MDN useState', 'https://developer.mozilla.org/b', 'state', 0.9),
        r('Blog', 'https://blog.example.com/c', 'tutorial', 0.5),
      ]),
    );
    const provider = new CoreSearchProvider();
    const res = await provider.search(
      { query: 'react useState hook guide', search_depth: 'balanced', include_content: false },
      { router: undefined } as never,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.results.map((x) => x.url)).toEqual([
      'https://react.dev/a',
      'https://developer.mozilla.org/b',
      'https://blog.example.com/c',
    ]);
  });

  it('keeps the best result even if none contain the token (never empties the set)', async () => {
    runV1Search.mockResolvedValue(
      dispatch([
        r('some page', 'https://a.com', 'nothing matching', 1.0),
        r('other page', 'https://b.com', 'also nothing', 0.9),
      ]),
    );
    const provider = new CoreSearchProvider();
    const res = await provider.search(
      { query: 'ERR_SOME_UNSEEN_TOKEN cannot resolve', search_depth: 'balanced', include_content: false },
      { router: undefined } as never,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.results.length).toBeGreaterThan(0);
  });
});
