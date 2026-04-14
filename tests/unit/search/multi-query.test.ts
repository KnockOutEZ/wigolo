import { describe, it, expect, vi, beforeEach } from 'vitest';
import { normalizeQueries, fanOutSearch, mergeWithRRF, synthesizeIntent } from '../../../src/search/multi-query.js';
import type { RawSearchResult, SearchEngine, SearchEngineOptions } from '../../../src/types.js';
import type { MergedSearchResult } from '../../../src/search/dedup.js';

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    multiQueryConcurrency: 5,
    multiQueryMax: 10,
    searxngQueryTimeoutMs: 8000,
  }),
}));

vi.mock('../../../src/logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { getConfig } from '../../../src/config.js';

// --- normalizeQueries tests ---

describe('normalizeQueries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lowercases all queries', () => {
    const result = normalizeQueries(['React Hooks', 'VUE COMPOSITION']);
    expect(result).toEqual(['react hooks', 'vue composition']);
  });

  it('trims whitespace from each query', () => {
    const result = normalizeQueries(['  react hooks  ', '  vue  ']);
    expect(result).toEqual(['react hooks', 'vue']);
  });

  it('collapses internal whitespace', () => {
    const result = normalizeQueries(['react   hooks   guide', 'vue    composition']);
    expect(result).toEqual(['react hooks guide', 'vue composition']);
  });

  it('drops exact duplicates after normalization', () => {
    const result = normalizeQueries(['React Hooks', 'react hooks', 'REACT HOOKS']);
    expect(result).toEqual(['react hooks']);
  });

  it('drops empty strings', () => {
    const result = normalizeQueries(['react', '', '   ', 'vue']);
    expect(result).toEqual(['react', 'vue']);
  });

  it('caps at multiQueryMax', () => {
    vi.mocked(getConfig).mockReturnValue({
      multiQueryConcurrency: 5,
      multiQueryMax: 3,
    } as any);
    const queries = ['a', 'b', 'c', 'd', 'e'];
    const result = normalizeQueries(queries);
    expect(result).toHaveLength(3);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeQueries([])).toEqual([]);
  });

  it('returns empty array when all queries are whitespace', () => {
    expect(normalizeQueries(['   ', '\t', '\n'])).toEqual([]);
  });

  it('handles single-element array', () => {
    expect(normalizeQueries(['React hooks'])).toEqual(['react hooks']);
  });

  it('preserves order of first-seen unique queries', () => {
    const result = normalizeQueries(['vue', 'react', 'svelte', 'react']);
    expect(result).toEqual(['vue', 'react', 'svelte']);
  });

  it('handles unicode queries', () => {
    const result = normalizeQueries(['Prufer sequence', 'prufer sequence']);
    expect(result).toEqual(['prufer sequence']);
  });
});

// --- fanOutSearch tests ---

describe('fanOutSearch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue({
      multiQueryConcurrency: 5,
      multiQueryMax: 10,
      searxngQueryTimeoutMs: 8000,
    } as any);
  });

  function makeMockEngine(name: string, results: RawSearchResult[]): SearchEngine {
    return {
      name,
      search: vi.fn().mockResolvedValue(results),
    };
  }

  it('fans out all queries to all engines', async () => {
    const engine1 = makeMockEngine('engine1', [
      { title: 'R1', url: 'https://a.com', snippet: 's1', relevance_score: 0.9, engine: 'engine1' },
    ]);
    const engine2 = makeMockEngine('engine2', [
      { title: 'R2', url: 'https://b.com', snippet: 's2', relevance_score: 0.8, engine: 'engine2' },
    ]);

    const { results, enginesUsed, errors } = await fanOutSearch(
      ['query1', 'query2'],
      [engine1, engine2],
      { maxResults: 10 },
    );

    expect(engine1.search).toHaveBeenCalledTimes(2);
    expect(engine2.search).toHaveBeenCalledTimes(2);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(enginesUsed).toContain('engine1');
    expect(enginesUsed).toContain('engine2');
    expect(errors).toHaveLength(0);
  });

  it('collects errors from failing engines without crashing', async () => {
    const goodEngine = makeMockEngine('good', [
      { title: 'OK', url: 'https://ok.com', snippet: 'ok', relevance_score: 0.9, engine: 'good' },
    ]);
    const badEngine: SearchEngine = {
      name: 'bad',
      search: vi.fn().mockRejectedValue(new Error('engine down')),
    };

    const { results, enginesUsed, errors } = await fanOutSearch(
      ['test query'],
      [goodEngine, badEngine],
      { maxResults: 10 },
    );

    expect(results.length).toBeGreaterThan(0);
    expect(enginesUsed).toContain('good');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('bad');
  });

  it('returns empty results when all engines fail', async () => {
    const badEngine: SearchEngine = {
      name: 'broken',
      search: vi.fn().mockRejectedValue(new Error('down')),
    };

    const { results, enginesUsed, errors } = await fanOutSearch(
      ['test'],
      [badEngine],
      { maxResults: 10 },
    );

    expect(results).toHaveLength(0);
    expect(enginesUsed).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('passes search engine options through', async () => {
    const engine = makeMockEngine('test', []);

    await fanOutSearch(['q1'], [engine], {
      maxResults: 5,
      timeRange: 'week',
      language: 'en',
      includeDomains: ['example.com'],
      excludeDomains: ['spam.com'],
      category: 'code',
    });

    expect(engine.search).toHaveBeenCalledWith('q1', expect.objectContaining({
      maxResults: expect.any(Number),
      timeRange: 'week',
      language: 'en',
      includeDomains: ['example.com'],
      excludeDomains: ['spam.com'],
      category: 'code',
    }));
  });

  it('handles empty queries array', async () => {
    const engine = makeMockEngine('test', []);

    const { results, errors } = await fanOutSearch([], [engine], { maxResults: 5 });

    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(engine.search).not.toHaveBeenCalled();
  });

  it('handles empty engines array', async () => {
    const { results, errors } = await fanOutSearch(['query'], [], { maxResults: 5 });

    expect(results).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('applies overfetch factor for domain-filtered searches', async () => {
    const engine = makeMockEngine('test', []);

    await fanOutSearch(['q1'], [engine], {
      maxResults: 5,
      includeDomains: ['react.dev'],
    });

    const callArgs = vi.mocked(engine.search).mock.calls[0][1] as SearchEngineOptions;
    expect(callArgs.maxResults).toBeGreaterThan(5);
  });
});

// --- mergeWithRRF tests ---

describe('mergeWithRRF', () => {
  function makeRankedList(items: Array<{ url: string; title: string }>): MergedSearchResult[] {
    return items.map((item, i) => ({
      title: item.title,
      url: item.url,
      snippet: `Snippet for ${item.title}`,
      relevance_score: 1.0 - i * 0.1,
      engines: ['test'],
    }));
  }

  it('merges two ranked lists using RRF formula', () => {
    const list1 = makeRankedList([
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
      { url: 'https://c.com', title: 'C' },
    ]);
    const list2 = makeRankedList([
      { url: 'https://b.com', title: 'B' },
      { url: 'https://c.com', title: 'C' },
      { url: 'https://d.com', title: 'D' },
    ]);

    const merged = mergeWithRRF([list1, list2]);

    expect(merged[0].url).toBe('https://b.com');
    const urls = merged.map(r => r.url);
    expect(urls).toContain('https://a.com');
    expect(urls).toContain('https://b.com');
    expect(urls).toContain('https://c.com');
    expect(urls).toContain('https://d.com');
  });

  it('handles single ranked list (passthrough)', () => {
    const list = makeRankedList([
      { url: 'https://a.com', title: 'A' },
      { url: 'https://b.com', title: 'B' },
    ]);

    const merged = mergeWithRRF([list]);

    expect(merged).toHaveLength(2);
    expect(merged[0].url).toBe('https://a.com');
    expect(merged[1].url).toBe('https://b.com');
  });

  it('returns empty array for empty input', () => {
    expect(mergeWithRRF([])).toEqual([]);
  });

  it('returns empty array for array of empty lists', () => {
    expect(mergeWithRRF([[], []])).toEqual([]);
  });

  it('assigns scores between 0 and 1', () => {
    const list1 = makeRankedList([
      { url: 'https://a.com', title: 'A' },
    ]);
    const list2 = makeRankedList([
      { url: 'https://a.com', title: 'A' },
    ]);

    const merged = mergeWithRRF([list1, list2]);

    for (const result of merged) {
      expect(result.relevance_score).toBeGreaterThan(0);
      expect(result.relevance_score).toBeLessThanOrEqual(1);
    }
  });

  it('item appearing in all lists scores higher than item in one list', () => {
    const list1 = makeRankedList([
      { url: 'https://common.com', title: 'Common' },
      { url: 'https://only1.com', title: 'Only1' },
    ]);
    const list2 = makeRankedList([
      { url: 'https://common.com', title: 'Common' },
      { url: 'https://only2.com', title: 'Only2' },
    ]);
    const list3 = makeRankedList([
      { url: 'https://common.com', title: 'Common' },
      { url: 'https://only3.com', title: 'Only3' },
    ]);

    const merged = mergeWithRRF([list1, list2, list3]);

    expect(merged[0].url).toBe('https://common.com');
    const commonScore = merged[0].relevance_score;
    const othersMax = Math.max(
      ...merged.filter(r => r.url !== 'https://common.com').map(r => r.relevance_score),
    );
    expect(commonScore).toBeGreaterThan(othersMax);
  });

  it('preserves MergedSearchResult fields from highest-ranked appearance', () => {
    const list1: MergedSearchResult[] = [{
      title: 'Best Title',
      url: 'https://a.com',
      snippet: 'Best snippet',
      relevance_score: 1.0,
      engines: ['searxng', 'bing'],
    }];
    const list2: MergedSearchResult[] = [{
      title: 'Other Title',
      url: 'https://a.com',
      snippet: 'Other snippet',
      relevance_score: 0.5,
      engines: ['duckduckgo'],
    }];

    const merged = mergeWithRRF([list1, list2]);

    expect(merged[0].title).toBe('Best Title');
    expect(merged[0].snippet).toBe('Best snippet');
    expect(merged[0].engines).toContain('searxng');
  });

  it('uses k=60 constant in RRF formula', () => {
    const list: MergedSearchResult[] = [{
      title: 'Solo',
      url: 'https://solo.com',
      snippet: 'Solo result',
      relevance_score: 1.0,
      engines: ['test'],
    }];

    const merged = mergeWithRRF([list]);

    expect(merged[0].relevance_score).toBeGreaterThan(0);
    expect(merged[0].relevance_score).toBeLessThanOrEqual(1);
  });
});

// --- synthesizeIntent tests ---

describe('synthesizeIntent', () => {
  it('joins queries with semicolons', () => {
    const result = synthesizeIntent(['react hooks', 'vue composition api']);
    expect(result).toBe('react hooks; vue composition api');
  });

  it('returns single query unchanged', () => {
    expect(synthesizeIntent(['react hooks'])).toBe('react hooks');
  });

  it('returns empty string for empty array', () => {
    expect(synthesizeIntent([])).toBe('');
  });

  it('trims excessive whitespace in output', () => {
    const result = synthesizeIntent(['  react  ', '  vue  ']);
    expect(result).toBe('react; vue');
  });
});
