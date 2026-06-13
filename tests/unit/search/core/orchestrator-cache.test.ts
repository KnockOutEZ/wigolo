import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '../../../../src/cache/db.js';
import {
  buildSearchCacheKey,
  cacheSearchResults,
} from '../../../../src/cache/store.js';
import type {
  SearchInput,
  SearchResultItem,
} from '../../../../src/types.js';
import type { SearchContext } from '../../../../src/providers/search-provider.js';
import { getConfig } from '../../../../src/config.js';

vi.mock('../../../../src/search/core/orchestrator.js', () => ({
  runV1Search: vi.fn().mockResolvedValue({
    vertical: 'general',
    results: [],
    enginesUsed: [],
    outcomes: [],
    degraded: true,
  }),
}));

const { CoreSearchProvider } = await import(
  '../../../../src/search/core/core-provider.js'
);

function mockCtx(): SearchContext {
  return {};
}

const cachedItems: SearchResultItem[] = [
  { title: 'Next docs', url: 'https://nextjs.org/docs/app', snippet: 's1', relevance_score: 1 },
  { title: 'Next blog', url: 'https://nextjs.org/blog/next-15', snippet: 's2', relevance_score: 0.9 },
  { title: 'React docs', url: 'https://react.dev/learn', snippet: 's3', relevance_score: 0.85 },
  { title: 'Vue guide', url: 'https://vuejs.org/guide', snippet: 's4', relevance_score: 0.8 },
  { title: 'Brand', url: 'https://www.next.co.uk/', snippet: 's5', relevance_score: 0.7 },
];

describe('CoreSearchProvider — cache key + post-lookup re-filter (sub-ticket 2.3)', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('a cache row stored without include_domains does NOT serve a request that supplies include_domains', async () => {
    cacheSearchResults(buildSearchCacheKey('next.js'), cachedItems, ['bing']);

    const provider = new CoreSearchProvider();
    const input: SearchInput = {
      query: 'next.js',
      include_domains: ['nextjs.org'],
      include_content: false,
    };
    const result = await provider.search(input, mockCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Because the cache key for the new request includes the filter and the
    // stored row does not, the provider must miss cache and dispatch fresh.
    // The mock orchestrator returns no engines, so engines_used is empty.
    expect(result.data.engines_used).toEqual([]);
    expect(result.data.results.length).toBe(0);
  });

  it('a request with include_domains serves the matching-filtered cache row only', async () => {
    const filteredItems: SearchResultItem[] = cachedItems.filter((r) =>
      r.url.includes('nextjs.org'),
    );
    cacheSearchResults(
      buildSearchCacheKey('next.js', { include_domains: ['nextjs.org'], search_depth: 'balanced', reranker: getConfig().reranker }),
      filteredItems,
      ['bing'],
    );

    const provider = new CoreSearchProvider();
    const input: SearchInput = {
      query: 'next.js',
      include_domains: ['nextjs.org'],
      include_content: false,
    };
    const result = await provider.search(input, mockCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.length).toBe(2);
    for (const r of result.data.results) {
      expect(r.url).toMatch(/nextjs\.org/);
    }
  });

  it('cache hit re-applies max_results even if the stored row is longer', async () => {
    // Stored row was written without an explicit max_results, so it contains
    // all five results. The new request asks for 2.
    cacheSearchResults(buildSearchCacheKey('next.js'), cachedItems, ['bing']);

    const provider = new CoreSearchProvider();
    const input: SearchInput = {
      query: 'next.js',
      max_results: 2,
      include_content: false,
    };
    const result = await provider.search(input, mockCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Because cache key includes max_results, the stored row (no max_results)
    // is a miss for this request. Fresh dispatch → empty.
    expect(result.data.results.length).toBe(0);
  });

  it('cache hit on the same filter key re-applies include_domains as defence-in-depth', async () => {
    // Edge case: the cache row was written with the right filter key but its
    // payload includes off-domain results (e.g. older code wrote the row
    // before the filter was added). Post-lookup re-filter must still apply.
    cacheSearchResults(
      buildSearchCacheKey('next.js', { include_domains: ['nextjs.org'], search_depth: 'balanced', reranker: getConfig().reranker }),
      cachedItems,
      ['bing'],
    );

    const provider = new CoreSearchProvider();
    const input: SearchInput = {
      query: 'next.js',
      include_domains: ['nextjs.org'],
      include_content: false,
    };
    const result = await provider.search(input, mockCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const r of result.data.results) {
      expect(r.url).toMatch(/nextjs\.org/);
    }
  });

  it('cache hit re-applies max_results as defence-in-depth when payload is longer', async () => {
    cacheSearchResults(
      buildSearchCacheKey('next.js', { max_results: 2, search_depth: 'balanced', reranker: getConfig().reranker }),
      cachedItems,
      ['bing'],
    );

    const provider = new CoreSearchProvider();
    const input: SearchInput = {
      query: 'next.js',
      max_results: 2,
      include_content: false,
    };
    const result = await provider.search(input, mockCtx());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.results.length).toBe(2);
  });
});
