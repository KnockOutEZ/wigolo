// Slice 3 (pool reshape): Wiby adapter.
//
// WHY: Wiby indexes the retro/personal small web that the major engines
// deprioritize — a long-tail recall signal for A4-class queries (obscure
// hobbyist/legacy topics). Keyless JSON API, lowest tier by design: it joins
// the general vertical at low weight as a `secondary` engine so it can never
// dominate consensus, only add coverage.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WibyEngine } from '../../../../src/search/engines/wiby.js';

const SAMPLE = [
  { URL: 'https://example.com/a', Title: 'First', Snippet: 'snip a', Description: '' },
  { URL: 'https://example.org/b', Title: 'Second', Snippet: 'snip b', Description: '' },
  { URL: '', Title: 'No URL', Snippet: 'skip me', Description: '' },
  { URL: 'https://example.net/c', Title: '', Snippet: 'no title', Description: '' },
];

describe('WibyEngine', () => {
  const engine = new WibyEngine();

  afterEach(() => vi.unstubAllGlobals());

  it('has name set to wiby', () => {
    expect(engine.name).toBe('wiby');
  });

  it('queries the wiby JSON endpoint with the q param', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await new WibyEngine().search('gopher protocol homepage', { maxResults: 5 });

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(String(url));
    expect(parsed.host).toBe('wiby.me');
    expect(parsed.pathname).toBe('/json/');
    expect(parsed.searchParams.get('q')).toBe('gopher protocol homepage');
  });

  it('parses capitalized URL/Title/Snippet keys into normalized RawSearchResult shape', () => {
    const results = engine.parseResults(SAMPLE, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'First',
      url: 'https://example.com/a',
      snippet: 'snip a',
      engine: 'wiby',
    });
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });

  it('skips entries with empty URL or Title', () => {
    const results = engine.parseResults(SAMPLE, 10);
    expect(results.every((r) => r.url.length > 0 && r.title.length > 0)).toBe(true);
    expect(results.map((r) => r.title)).not.toContain('No URL');
  });

  it('respects maxResults', () => {
    expect(engine.parseResults(SAMPLE, 1)).toHaveLength(1);
  });

  it('returns empty array on non-array body', () => {
    expect(engine.parseResults(null, 10)).toEqual([]);
    expect(engine.parseResults({}, 10)).toEqual([]);
    expect(engine.parseResults('not json', 10)).toEqual([]);
  });
});
