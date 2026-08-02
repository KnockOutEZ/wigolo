import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { BingEngine } from '../../../../src/search/engines/bing.js';

const fixtureHtml = readFileSync('tests/fixtures/search/bing-results.html', 'utf-8');

describe('BingEngine', () => {
  const engine = new BingEngine();

  it('has name set to bing', () => {
    expect(engine.name).toBe('bing');
  });

  describe('request market pinning', () => {
    afterEach(() => vi.restoreAllMocks());

    function stubFetch() {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(fixtureHtml, { status: 200 }),
      );
      return spy;
    }

    it('pins market + UI language to English by default (Bing geo-localizes by IP otherwise)', async () => {
      // WHY: from a non-US IP, a bare Bing query returns locale-mixed results
      // (Chinese React docs for an English query). Accept-Language does not
      // override Bing's market, so we must send mkt=en-US + setlang=en.
      const spy = stubFetch();
      await new BingEngine().search('React 19 useOptimistic hook');
      const calledUrl = String(spy.mock.calls[0][0]);
      expect(calledUrl).toContain('mkt=en-US');
      expect(calledUrl).toContain('setlang=en');
    });

    it('an explicit country opts back into regional results (cc set, no forced en market)', async () => {
      const spy = stubFetch();
      await new BingEngine().search('চাকরির খবর', { country: 'BD' });
      const calledUrl = String(spy.mock.calls[0][0]);
      expect(calledUrl).toContain('cc=bd');
      expect(calledUrl).not.toContain('mkt=en-US');
    });
  });

  it('parses results from Bing HTML', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results.length).toBe(3);
    expect(results[0].title).toBe('React');
    expect(results[0].url).toBe('https://react.dev/');
    expect(results[0].snippet).toContain('library for web');
    expect(results[0].engine).toBe('bing');
  });

  it('assigns position-based relevance scores', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results[0].relevance_score).toBeGreaterThan(results[2].relevance_score);
  });

  it('respects maxResults limit', () => {
    const results = engine.parseResults(fixtureHtml, 1);
    expect(results).toHaveLength(1);
  });
});
