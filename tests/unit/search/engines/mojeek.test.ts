// Mojeek adapter.
//
// WHY: Mojeek operates a real independent web index with no Bing/Google
// affiliation. Adding it to the general vertical dilutes brand-collision
// outcomes from the major engines and catches long-tail queries the other
// 14 adapters miss. Free, no API key required for basic HTML search.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { MojeekEngine } from '../../../../src/search/engines/mojeek.js';

const SAMPLE_HTML = `
<html><body>
<ul class="results-standard">
  <li>
    <h2><a class="title" href="https://example.com/a">First result</a></h2>
    <p class="s">First snippet text here.</p>
    <a class="url" href="https://example.com/a">example.com/a</a>
  </li>
  <li>
    <h2><a class="title" href="https://example.org/b">Second result</a></h2>
    <p class="s">Second snippet.</p>
    <a class="url" href="https://example.org/b">example.org/b</a>
  </li>
  <li>
    <h2><a class="title" href="">No URL</a></h2>
    <p class="s">Should be skipped.</p>
  </li>
</ul>
</body></html>`;

describe('MojeekEngine', () => {
  const engine = new MojeekEngine();

  it('has name set to mojeek', () => {
    expect(engine.name).toBe('mojeek');
  });

  it('parses Mojeek HTML into normalized RawSearchResult shape', () => {
    const results = engine.parseResults(SAMPLE_HTML, 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]).toMatchObject({
      title: 'First result',
      url: 'https://example.com/a',
      engine: 'mojeek',
    });
    expect(results[0].snippet).toMatch(/First snippet/);
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });

  it('skips entries with empty href or title', () => {
    const results = engine.parseResults(SAMPLE_HTML, 10);
    // The third entry has empty href — it must be filtered.
    expect(results.every((r) => r.url.length > 0)).toBe(true);
    expect(results.map((r) => r.title)).not.toContain('No URL');
  });

  it('respects maxResults', () => {
    expect(engine.parseResults(SAMPLE_HTML, 1)).toHaveLength(1);
  });

  it('returns empty array on empty / unparseable HTML', () => {
    expect(engine.parseResults('<html></html>', 10)).toEqual([]);
    expect(engine.parseResults('', 10)).toEqual([]);
  });

  // Mojeek 403s are IP-reputation/rate-limit driven; the SearXNG-proven
  // request shape (no fmt param, safe=0, no explicit s on page 1, browser-like
  // headers) is what keeps the adapter off the block list. A regression here
  // takes the engine out of the pool for entire benchmark runs.
  describe('request shape', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('sends SearXNG-proven param shape (no fmt, safe=0, no s on page 1)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('<html></html>', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await new MojeekEngine().search('test query');

      const [url, init] = fetchMock.mock.calls[0];
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('fmt')).toBeNull();
      expect(parsed.searchParams.get('safe')).toBe('0');
      expect(parsed.searchParams.get('s')).toBeNull();
      const headers = init.headers as Record<string, string>;
      expect(headers['Accept-Language']).toBeTruthy();
      expect(headers['User-Agent']).toMatch(/Mozilla/);
    });
  });
});
