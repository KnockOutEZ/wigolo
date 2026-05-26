// Slice S11a (long-tail engine breadth): Marginalia adapter.
//
// WHY: Marginalia is a non-commercial search engine focused on the
// long-tail small web — pages the major engines deprioritize or skip
// entirely. Adding it to the general vertical pulls niche/legacy results
// the existing 14 adapters miss. Free JSON API, no key required.

import { describe, it, expect } from 'vitest';
import { MarginaliaEngine } from '../../../../src/search/engines/marginalia.js';

describe('MarginaliaEngine', () => {
  const engine = new MarginaliaEngine();

  it('has name set to marginalia', () => {
    expect(engine.name).toBe('marginalia');
  });

  it('parses the documented Marginalia JSON shape into normalized RawSearchResult', () => {
    const body = {
      results: [
        {
          url: 'https://example.com/a',
          title: 'A small-web page',
          description: 'A snippet of content from a niche site.',
          quality: 0.65,
          rankingScore: 0.83,
        },
        {
          url: 'https://example.org/b',
          title: 'Another long-tail result',
          description: 'Second snippet.',
        },
      ],
    };
    const results = engine.parseResults(body, 10);
    expect(results.length).toBe(2);
    expect(results[0]).toMatchObject({
      title: 'A small-web page',
      url: 'https://example.com/a',
      engine: 'marginalia',
    });
    expect(results[0].snippet).toMatch(/niche site/);
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });

  it('returns empty array when body shape is unexpected', () => {
    expect(engine.parseResults({}, 10)).toEqual([]);
    expect(engine.parseResults({ results: [] }, 10)).toEqual([]);
    expect(engine.parseResults(null, 10)).toEqual([]);
  });

  it('respects maxResults', () => {
    const body = {
      results: [
        { url: 'https://a', title: 'a', description: '' },
        { url: 'https://b', title: 'b', description: '' },
        { url: 'https://c', title: 'c', description: '' },
      ],
    };
    expect(engine.parseResults(body, 2)).toHaveLength(2);
  });

  it('skips entries missing url or title', () => {
    const body = {
      results: [
        { url: 'https://a', title: 'a', description: 's' },
        { title: 'b', description: 's' },           // no url
        { url: 'https://c', description: 's' },     // no title
        { url: '', title: 'd', description: 's' },  // empty url
      ],
    };
    expect(engine.parseResults(body, 10).map((r) => r.title)).toEqual(['a']);
  });
});
