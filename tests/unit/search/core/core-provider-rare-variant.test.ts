import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawSearchResult } from '../../../../src/types.js';

const runV1Search = vi.fn();
vi.mock('../../../../src/search/core/orchestrator.js', () => ({ runV1Search }));
vi.mock('../../../../src/search/content-fetch.js', () => ({ fetchContentForResults: vi.fn(async () => {}) }));

const { CoreSearchProvider } = await import('../../../../src/search/core/core-provider.js');

function dispatch(url: string): { results: RawSearchResult[]; enginesUsed: string[]; outcomes: []; degraded: boolean } {
  return {
    results: [{ title: url, url, snippet: 's', relevance_score: 1, engine: 'e1' }],
    enginesUsed: ['e1'], outcomes: [], degraded: false,
  };
}

describe('core-provider rare-term variant dispatch', () => {
  beforeEach(() => { runV1Search.mockReset(); });

  it('fires ONE extra quoted-phrase dispatch for a compound-term query', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'sqlite-vec vec0 knn', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(2); // primary + 1 variant
    const variantArg = runV1Search.mock.calls[1][0].query as string;
    expect(variantArg).toContain('"sqlite-vec"');
  });

  it('does NOT fire a variant for a plain query', async () => {
    runV1Search.mockResolvedValue(dispatch('https://a.com'));
    const provider = new CoreSearchProvider();
    await provider.search(
      { query: 'best coffee maker', search_depth: 'fast', include_content: false },
      { router: undefined } as never,
    );
    expect(runV1Search).toHaveBeenCalledTimes(1);
  });
});
