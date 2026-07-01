// Marginalia adapter.
//
// WHY: Marginalia is a non-commercial search engine focused on the
// long-tail small web — pages the major engines deprioritize or skip
// entirely. Adding it to the general vertical pulls niche/legacy results
// the existing 14 adapters miss. Free JSON API, no key required.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarginaliaEngine } from '../../../../src/search/engines/marginalia.js';

afterEach(() => vi.unstubAllGlobals());

describe('MarginaliaEngine', () => {
  const engine = new MarginaliaEngine();

  it('has name set to marginalia', () => {
    expect(engine.name).toBe('marginalia');
  });

  // WHY: the legacy api.marginalia-search.com path-segment API now 404s on
  // every call — the public API moved to api2 with query-string params and
  // a mandatory `API-Key: public` header. This pins the new request shape.
  it('queries the api2 endpoint with query param and public API key header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new MarginaliaEngine().search('sqlite-vec knn', { maxResults: 5 });

    const [url, init] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.host).toBe('api2.marginalia-search.com');
    expect(parsed.pathname).toBe('/search');
    expect(parsed.searchParams.get('query')).toBe('sqlite-vec knn');
    expect(parsed.searchParams.get('count')).toBe('5');
    expect((init.headers as Record<string, string>)['API-Key']).toBe('public');
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
