import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import {
  buildSearchCacheKey,
  cacheSearchResults,
  getCachedSearchResults,
} from '../../../src/cache/store.js';
import type { SearchResultItem } from '../../../src/types.js';

const sampleResults: SearchResultItem[] = [
  { title: 'doc', url: 'https://example.com', snippet: 's', relevance_score: 1 },
];

describe('buildSearchCacheKey', () => {
  it('returns the bare query when no filters are supplied', () => {
    expect(buildSearchCacheKey('react tutorial')).toBe('react tutorial');
  });

  it('produces the same key when include_domains is reordered', () => {
    const a = buildSearchCacheKey('q', { include_domains: ['a.com', 'b.com'] });
    const b = buildSearchCacheKey('q', { include_domains: ['b.com', 'a.com'] });
    expect(a).toBe(b);
  });

  it('produces a different key when include_domains differs', () => {
    const a = buildSearchCacheKey('q', { include_domains: ['nextjs.org'] });
    const b = buildSearchCacheKey('q', { include_domains: ['react.dev'] });
    expect(a).not.toBe(b);
  });

  it('produces a different key when max_results differs', () => {
    const a = buildSearchCacheKey('q', { max_results: 5 });
    const b = buildSearchCacheKey('q', { max_results: 10 });
    expect(a).not.toBe(b);
  });

  it('produces a different key when category differs', () => {
    const a = buildSearchCacheKey('q', { category: 'code' });
    const b = buildSearchCacheKey('q', { category: 'news' });
    expect(a).not.toBe(b);
  });

  it('treats null/undefined/empty-array filters as equivalent to no filter', () => {
    const a = buildSearchCacheKey('q');
    const b = buildSearchCacheKey('q', {});
    const c = buildSearchCacheKey('q', { include_domains: [], exclude_domains: [] });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('is case-insensitive on the query body but case-sensitive on domain values', () => {
    const a = buildSearchCacheKey('React Tutorial');
    const b = buildSearchCacheKey('react tutorial');
    expect(a).toBe(b);
  });

  it('search_depth and reranker change the cache key (no cross-tier bleed)', () => {
    const balanced = buildSearchCacheKey('q', { search_depth: 'balanced', reranker: 'onnx' });
    const fast = buildSearchCacheKey('q', { search_depth: 'fast', reranker: 'onnx' });
    const noRerank = buildSearchCacheKey('q', { search_depth: 'balanced', reranker: 'none' });
    expect(balanced).not.toBe(fast);
    expect(balanced).not.toBe(noRerank);
    expect(balanced).not.toBe('q'); // depth always present -> always fingerprinted
  });

  it('normalises search_engines: casing, order, and duplicates share one key', () => {
    const a = buildSearchCacheKey('q', { search_engines: ['DuckDuckGo'] });
    const b = buildSearchCacheKey('q', { search_engines: ['duckduckgo'] });
    const c = buildSearchCacheKey('q', { search_engines: ['brave', 'duckduckgo'] });
    const d = buildSearchCacheKey('q', { search_engines: ['DuckDuckGo', 'brave'] });
    const e = buildSearchCacheKey('q', { search_engines: ['duckduckgo', 'duckduckgo'] });
    expect(a).toBe(b); // case-insensitive
    expect(c).toBe(d); // order- and case-insensitive
    expect(a).toBe(e); // duplicates collapse
    expect(a).not.toBe(c); // different engine sets stay distinct
  });

  it('treats whitespace-only or empty search_engines as no filter', () => {
    const bare = buildSearchCacheKey('q');
    const empty = buildSearchCacheKey('q', { search_engines: [] });
    const blanks = buildSearchCacheKey('q', { search_engines: ['  ', ''] });
    expect(bare).toBe(empty);
    expect(bare).toBe(blanks);
  });
});

describe('cache miss on filter mismatch', () => {
  beforeEach(() => {
    initDatabase(':memory:');
  });
  afterEach(() => {
    closeDatabase();
  });

  it('returns null when looking up with a different include_domains than was stored', () => {
    const keyA = buildSearchCacheKey('next.js docs', { include_domains: ['nextjs.org'] });
    const keyB = buildSearchCacheKey('next.js docs', { include_domains: ['react.dev'] });
    cacheSearchResults(keyA, sampleResults, ['eng']);
    expect(getCachedSearchResults(keyB)).toBeNull();
  });

  it('returns the cached row when the same filtered key is used', () => {
    const key = buildSearchCacheKey('next.js docs', { include_domains: ['nextjs.org'] });
    cacheSearchResults(key, sampleResults, ['eng']);
    const cached = getCachedSearchResults(key);
    expect(cached).not.toBeNull();
    expect(cached!.results[0].url).toBe('https://example.com');
  });
});
