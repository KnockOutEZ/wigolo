import { describe, it, expect } from 'vitest';
import { WikipediaEngine } from '../../../../src/search/engines/wikipedia.js';

describe('WikipediaEngine', () => {
  const engine = new WikipediaEngine();

  it('has name set to wikipedia', () => {
    expect(engine.name).toBe('wikipedia');
  });

  it('parses opensearch JSON into RawSearchResult shape', () => {
    const body = [
      'next',
      ['Next.js', 'Next', 'Next (TV series)'],
      ['Next.js is an open-source React framework.', 'Next may refer to:', 'Next is an American drama.'],
      ['https://en.wikipedia.org/wiki/Next.js', 'https://en.wikipedia.org/wiki/Next', 'https://en.wikipedia.org/wiki/Next_(TV_series)'],
    ];
    const results = engine.parseResults(body, 10);
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      title: 'Next.js',
      url: 'https://en.wikipedia.org/wiki/Next.js',
      engine: 'wikipedia',
    });
    expect(results[0].snippet).toContain('React framework');
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });

  it('respects maxResults', () => {
    const body = [
      'a',
      ['A', 'B', 'C', 'D'],
      ['', '', '', ''],
      ['https://w/A', 'https://w/B', 'https://w/C', 'https://w/D'],
    ];
    expect(engine.parseResults(body, 2)).toHaveLength(2);
  });

  it('returns empty array on malformed body', () => {
    expect(engine.parseResults(null, 10)).toEqual([]);
    expect(engine.parseResults({}, 10)).toEqual([]);
    expect(engine.parseResults(['q'], 10)).toEqual([]);
  });

  it('skips rows missing title or url', () => {
    const body = [
      'q',
      ['A', '', 'C'],
      ['s1', 's2', 's3'],
      ['https://w/A', 'https://w/B', ''],
    ];
    const results = engine.parseResults(body, 10);
    expect(results.map((r) => r.title)).toEqual(['A']);
  });
});
