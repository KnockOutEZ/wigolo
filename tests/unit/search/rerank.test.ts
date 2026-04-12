import { describe, it, expect } from 'vitest';
import { rerankResults } from '../../../src/search/rerank.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';

function makeResult(overrides: Partial<MergedSearchResult> = {}): MergedSearchResult {
  return {
    title: 'Default Title',
    url: 'https://example.com',
    snippet: 'Default snippet',
    relevance_score: 0.5,
    engines: ['test'],
    ...overrides,
  };
}

describe('rerankResults', () => {
  it('passes results through unchanged when no reranker configured', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'A', url: 'https://a.com', relevance_score: 0.5, engines: ['bing'] }),
      makeResult({ title: 'B', url: 'https://b.com', relevance_score: 0.8, engines: ['ddg'] }),
    ];
    const reranked = await rerankResults('test query', results);
    expect(reranked).toEqual(results);
  });

  it('preserves original order for passthrough', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'First', url: 'https://1.com', relevance_score: 0.9, engines: ['bing'] }),
      makeResult({ title: 'Second', url: 'https://2.com', relevance_score: 0.7, engines: ['ddg'] }),
    ];
    const reranked = await rerankResults('query', results);
    expect(reranked[0].title).toBe('First');
    expect(reranked[1].title).toBe('Second');
  });

  it('handles empty results', async () => {
    const reranked = await rerankResults('query', []);
    expect(reranked).toEqual([]);
  });

  it('handles single result', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'Only', url: 'https://only.com', relevance_score: 1.0 }),
    ];
    const reranked = await rerankResults('query', results);
    expect(reranked).toHaveLength(1);
    expect(reranked[0].title).toBe('Only');
    expect(reranked[0].relevance_score).toBe(1.0);
  });

  it('handles large result set (100+ items)', async () => {
    const results: MergedSearchResult[] = Array.from({ length: 150 }, (_, i) =>
      makeResult({
        title: `Result ${i}`,
        url: `https://example.com/${i}`,
        relevance_score: 1 - i / 150,
        engines: ['engine'],
      }),
    );
    const reranked = await rerankResults('big query', results);
    expect(reranked).toHaveLength(150);
    expect(reranked[0].title).toBe('Result 0');
    expect(reranked[149].title).toBe('Result 149');
  });

  it('preserves exact scores for all results', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'A', url: 'https://a.com', relevance_score: 0.95 }),
      makeResult({ title: 'B', url: 'https://b.com', relevance_score: 0.72 }),
      makeResult({ title: 'C', url: 'https://c.com', relevance_score: 0.31 }),
    ];
    const reranked = await rerankResults('scores', results);
    expect(reranked[0].relevance_score).toBe(0.95);
    expect(reranked[1].relevance_score).toBe(0.72);
    expect(reranked[2].relevance_score).toBe(0.31);
  });

  it('handles results with identical scores', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'A', url: 'https://a.com', relevance_score: 0.5 }),
      makeResult({ title: 'B', url: 'https://b.com', relevance_score: 0.5 }),
      makeResult({ title: 'C', url: 'https://c.com', relevance_score: 0.5 }),
    ];
    const reranked = await rerankResults('equal scores', results);
    expect(reranked).toHaveLength(3);
    expect(reranked[0].title).toBe('A');
    expect(reranked[1].title).toBe('B');
    expect(reranked[2].title).toBe('C');
  });

  it('handles results with NaN scores (passthrough preserves them)', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'A', url: 'https://a.com', relevance_score: NaN }),
      makeResult({ title: 'B', url: 'https://b.com', relevance_score: 0.5 }),
    ];
    const reranked = await rerankResults('nan scores', results);
    expect(reranked).toHaveLength(2);
    expect(reranked[0].relevance_score).toBeNaN();
    expect(reranked[1].relevance_score).toBe(0.5);
  });

  it('handles results with Infinity scores (passthrough preserves them)', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'A', url: 'https://a.com', relevance_score: Infinity }),
      makeResult({ title: 'B', url: 'https://b.com', relevance_score: -Infinity }),
    ];
    const reranked = await rerankResults('inf scores', results);
    expect(reranked[0].relevance_score).toBe(Infinity);
    expect(reranked[1].relevance_score).toBe(-Infinity);
  });

  it('handles results with zero score', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'Zero', url: 'https://zero.com', relevance_score: 0 }),
    ];
    const reranked = await rerankResults('zero', results);
    expect(reranked[0].relevance_score).toBe(0);
  });

  it('handles results with negative scores', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'Neg', url: 'https://neg.com', relevance_score: -0.5 }),
    ];
    const reranked = await rerankResults('neg', results);
    expect(reranked[0].relevance_score).toBe(-0.5);
  });

  it('preserves all fields (url, snippet, engines) unchanged', async () => {
    const results: MergedSearchResult[] = [
      {
        title: 'Full',
        url: 'https://full.com/path?q=1',
        snippet: 'A full snippet with details',
        relevance_score: 0.88,
        engines: ['google', 'bing', 'ddg'],
      },
    ];
    const reranked = await rerankResults('preserve', results);
    expect(reranked[0]).toEqual(results[0]);
    expect(reranked[0].engines).toEqual(['google', 'bing', 'ddg']);
    expect(reranked[0].url).toBe('https://full.com/path?q=1');
    expect(reranked[0].snippet).toBe('A full snippet with details');
  });

  it('returns the same array reference (not a copy) for passthrough', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: 'Same ref' }),
    ];
    const reranked = await rerankResults('ref', results);
    expect(reranked).toBe(results);
  });

  it('handles concurrent calls without interference', async () => {
    const results1: MergedSearchResult[] = [
      makeResult({ title: 'A1', relevance_score: 0.9 }),
    ];
    const results2: MergedSearchResult[] = [
      makeResult({ title: 'B1', relevance_score: 0.1 }),
      makeResult({ title: 'B2', relevance_score: 0.2 }),
    ];

    const [reranked1, reranked2] = await Promise.all([
      rerankResults('query1', results1),
      rerankResults('query2', results2),
    ]);

    expect(reranked1).toHaveLength(1);
    expect(reranked1[0].title).toBe('A1');
    expect(reranked2).toHaveLength(2);
    expect(reranked2[0].title).toBe('B1');
  });

  it('handles results with empty strings in fields', async () => {
    const results: MergedSearchResult[] = [
      makeResult({ title: '', url: 'https://empty.com', snippet: '', relevance_score: 0.5 }),
    ];
    const reranked = await rerankResults('empty fields', results);
    expect(reranked[0].title).toBe('');
    expect(reranked[0].snippet).toBe('');
  });

  it('handles very long query string', async () => {
    const longQuery = 'a'.repeat(10000);
    const results: MergedSearchResult[] = [
      makeResult({ title: 'Long query result' }),
    ];
    const reranked = await rerankResults(longQuery, results);
    expect(reranked).toHaveLength(1);
  });
});
