import { describe, it, expect } from 'vitest';
import { BraveEngine } from '../../../../src/search/engines/brave.js';

describe('BraveEngine', () => {
  const engine = new BraveEngine();

  it('has name set to brave', () => {
    expect(engine.name).toBe('brave');
  });

  it('parses web.results into RawSearchResult shape', () => {
    const body = {
      web: {
        results: [
          { title: 'Next.js', url: 'https://nextjs.org/', description: 'React framework', page_age: '2026-04-12T00:00:00Z' },
          { title: 'React docs', url: 'https://react.dev/', description: 'Library' },
        ],
      },
    };
    const results = engine.parseResults(body, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Next.js',
      url: 'https://nextjs.org/',
      engine: 'brave',
    });
    expect(results[0].published_date).toBe('2026-04-12T00:00:00.000Z');
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });

  it('returns empty array when body has no web.results', () => {
    expect(engine.parseResults({}, 10)).toEqual([]);
    expect(engine.parseResults({ web: {} }, 10)).toEqual([]);
    expect(engine.parseResults({ web: { results: [] } }, 10)).toEqual([]);
  });

  it('respects maxResults', () => {
    const body = {
      web: {
        results: [
          { title: 'A', url: 'https://a' },
          { title: 'B', url: 'https://b' },
          { title: 'C', url: 'https://c' },
        ],
      },
    };
    expect(engine.parseResults(body, 2)).toHaveLength(2);
  });

  it('skips entries missing title or url', () => {
    const body = {
      web: {
        results: [
          { title: 'A', url: 'https://a' },
          { title: '', url: 'https://b' },
          { url: 'https://c' },
          { title: 'D' },
        ],
      },
    };
    expect(engine.parseResults(body, 10).map((r) => r.title)).toEqual(['A']);
  });
});
