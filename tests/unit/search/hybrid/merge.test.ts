import { describe, it, expect } from 'vitest';
import { mergeResults } from '../../../../src/search/hybrid/merge.js';
import type { SearchOutput, SearchResultItem } from '../../../../src/types.js';

function makeResult(
  title: string,
  url: string,
  score = 0.5,
  extra: Partial<SearchResultItem> = {},
): SearchResultItem {
  return { title, url, snippet: '', relevance_score: score, ...extra };
}

function makeOutput(partial: Partial<SearchOutput>): SearchOutput {
  return {
    results: [],
    query: 'q',
    engines_used: [],
    total_time_ms: 0,
    ...partial,
  };
}

describe('mergeResults', () => {
  it('merges two non-overlapping lists ranked by RRF', () => {
    const core = makeOutput({
      results: [
        makeResult('a', 'https://a.com/'),
        makeResult('b', 'https://b.com/'),
      ],
    });
    const searxng = makeOutput({
      results: [
        makeResult('c', 'https://c.com/'),
        makeResult('d', 'https://d.com/'),
      ],
    });
    const merged = mergeResults(core, searxng);
    expect(merged.results.map((r) => r.url)).toEqual([
      'https://a.com/',
      'https://c.com/',
      'https://b.com/',
      'https://d.com/',
    ]);
  });

  it('deduplicates URLs that appear in both providers via normalized URL', () => {
    const core = makeOutput({
      results: [
        makeResult('A', 'https://www.example.com/page'),
        makeResult('B', 'https://b.com/'),
      ],
    });
    const searxng = makeOutput({
      results: [
        makeResult('A-from-searxng', 'https://example.com/page/'),
        makeResult('C', 'https://c.com/'),
      ],
    });
    const merged = mergeResults(core, searxng);
    const urls = merged.results.map((r) => r.url);
    const distinct = new Set(urls);
    expect(urls.length).toBe(distinct.size);
    // The shared URL should be ranked first (appears at rank 1 in both lists).
    expect(merged.results[0].title === 'A' || merged.results[0].title === 'A-from-searxng').toBe(true);
  });

  it('caps results to maxResults', () => {
    const core = makeOutput({
      results: [
        makeResult('a', 'https://a.com/'),
        makeResult('b', 'https://b.com/'),
        makeResult('c', 'https://c.com/'),
      ],
    });
    const searxng = makeOutput({
      results: [makeResult('d', 'https://d.com/')],
    });
    const merged = mergeResults(core, searxng, { maxResults: 2 });
    expect(merged.results.length).toBe(2);
  });

  it('unions engines_used', () => {
    const core = makeOutput({
      results: [makeResult('a', 'https://a.com/')],
      engines_used: ['bing', 'ddg'],
    });
    const searxng = makeOutput({
      results: [makeResult('b', 'https://b.com/')],
      engines_used: ['ddg', 'wikipedia'],
    });
    const merged = mergeResults(core, searxng);
    expect(merged.engines_used.sort()).toEqual(['bing', 'ddg', 'wikipedia']);
  });

  it('unions engines_dispatched', () => {
    const core = makeOutput({
      results: [makeResult('a', 'https://a.com/')],
      engines_used: ['bing'],
      engines_dispatched: ['bing', 'empty'],
    });
    const searxng = makeOutput({
      results: [makeResult('b', 'https://b.com/')],
      engines_used: ['ddg'],
      engines_dispatched: ['ddg', 'empty'],
    });
    const merged = mergeResults(core, searxng);
    expect(merged.engines_dispatched?.sort()).toEqual(['bing', 'ddg', 'empty']);
  });

  it('concatenates engine_outcomes when either side has them', () => {
    const core = makeOutput({
      results: [makeResult('a', 'https://a.com/')],
      engine_outcomes: [
        { engine: 'bing', ok: true, latency_ms: 100, result_count: 5 },
      ],
    });
    const searxng = makeOutput({
      results: [makeResult('b', 'https://b.com/')],
      engine_outcomes: [
        { engine: 'searxng:google', ok: true, latency_ms: 200, result_count: 8 },
      ],
    });
    const merged = mergeResults(core, searxng);
    expect(merged.engine_outcomes?.length).toBe(2);
    expect(merged.engine_outcomes?.map((o) => o.engine)).toEqual([
      'bing',
      'searxng:google',
    ]);
  });

  it('omits engine_outcomes when neither side has them', () => {
    const core = makeOutput({ results: [makeResult('a', 'https://a.com/')] });
    const searxng = makeOutput({ results: [makeResult('b', 'https://b.com/')] });
    const merged = mergeResults(core, searxng);
    expect(merged.engine_outcomes).toBeUndefined();
  });

  it('returns searxng-only results when core is empty', () => {
    const core = makeOutput({ results: [] });
    const searxng = makeOutput({
      results: [
        makeResult('a', 'https://a.com/'),
        makeResult('b', 'https://b.com/'),
      ],
    });
    const merged = mergeResults(core, searxng);
    expect(merged.results.map((r) => r.url)).toEqual([
      'https://a.com/',
      'https://b.com/',
    ]);
  });

  it('returns core-only results when searxng is empty', () => {
    const core = makeOutput({
      results: [
        makeResult('a', 'https://a.com/'),
        makeResult('b', 'https://b.com/'),
      ],
    });
    const searxng = makeOutput({ results: [] });
    const merged = mergeResults(core, searxng);
    expect(merged.results.map((r) => r.url)).toEqual([
      'https://a.com/',
      'https://b.com/',
    ]);
  });

  it('prefers the result with markdown content when both providers return the same URL', () => {
    const core = makeOutput({
      results: [makeResult('A', 'https://a.com/', 0.6)],
    });
    const searxng = makeOutput({
      results: [
        makeResult('A-rich', 'https://a.com/', 0.5, {
          markdown_content: '# Hello',
        }),
      ],
    });
    const merged = mergeResults(core, searxng);
    expect(merged.results[0].markdown_content).toBe('# Hello');
  });
});
