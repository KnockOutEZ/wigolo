// Slice S11a (long-tail engine breadth): Mojeek adapter.
//
// WHY: Mojeek operates a real independent web index with no Bing/Google
// affiliation. Adding it to the general vertical dilutes brand-collision
// outcomes from the major engines and catches long-tail queries the other
// 14 adapters miss. Free, no API key required for basic HTML search.

import { describe, it, expect } from 'vitest';
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
});
