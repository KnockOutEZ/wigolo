import { describe, it, expect } from 'vitest';
import { deduplicateResults } from '../../../src/search/dedup.js';
import type { RawSearchResult } from '../../../src/types.js';

describe('deduplicateResults', () => {
  it('merges duplicate URLs keeping highest score', () => {
    const results: RawSearchResult[] = [
      { title: 'React Docs', url: 'https://react.dev/learn', snippet: 'Learn React', relevance_score: 0.9, engine: 'searxng' },
      { title: 'React - Learn', url: 'https://react.dev/learn', snippet: 'React learning guide', relevance_score: 0.7, engine: 'duckduckgo' },
    ];
    const merged = deduplicateResults(results);
    expect(merged).toHaveLength(1);
    expect(merged[0].relevance_score).toBe(0.9);
    expect(merged[0].engines).toContain('searxng');
    expect(merged[0].engines).toContain('duckduckgo');
  });

  it('normalizes URLs before comparing (www, trailing slash, tracking params)', () => {
    const results: RawSearchResult[] = [
      { title: 'Example', url: 'https://www.example.com/', snippet: 'A', relevance_score: 0.8, engine: 'bing' },
      { title: 'Example', url: 'https://example.com?utm_source=google', snippet: 'B', relevance_score: 0.6, engine: 'duckduckgo' },
    ];
    const merged = deduplicateResults(results);
    expect(merged).toHaveLength(1);
    expect(merged[0].relevance_score).toBe(0.8);
  });

  it('sorts results by relevance score descending', () => {
    const results: RawSearchResult[] = [
      { title: 'Low', url: 'https://low.com', snippet: '', relevance_score: 0.3, engine: 'a' },
      { title: 'High', url: 'https://high.com', snippet: '', relevance_score: 0.9, engine: 'a' },
      { title: 'Mid', url: 'https://mid.com', snippet: '', relevance_score: 0.6, engine: 'a' },
    ];
    const merged = deduplicateResults(results);
    expect(merged.map(r => r.relevance_score)).toEqual([0.9, 0.6, 0.3]);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateResults([])).toEqual([]);
  });

  it('preserves original URL (not normalized) in output', () => {
    const results: RawSearchResult[] = [
      { title: 'Ex', url: 'https://www.example.com/page?ref=1', snippet: '', relevance_score: 1, engine: 'a' },
    ];
    const merged = deduplicateResults(results);
    expect(merged[0].url).toBe('https://www.example.com/page?ref=1');
  });
});
