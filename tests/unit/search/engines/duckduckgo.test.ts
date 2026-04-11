import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { DuckDuckGoEngine } from '../../../../src/search/engines/duckduckgo.js';

const fixtureHtml = readFileSync('tests/fixtures/search/duckduckgo-results.html', 'utf-8');

describe('DuckDuckGoEngine', () => {
  const engine = new DuckDuckGoEngine();

  it('has name set to duckduckgo', () => {
    expect(engine.name).toBe('duckduckgo');
  });

  it('parses results from DDG lite HTML', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results.length).toBe(3);
    expect(results[0].title).toBe('React – Learn');
    expect(results[0].url).toBe('https://react.dev/learn');
    expect(results[0].snippet).toContain('official React');
    expect(results[0].engine).toBe('duckduckgo');
  });

  it('assigns position-based relevance scores', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
    expect(results[1].relevance_score).toBeGreaterThan(results[2].relevance_score);
  });

  it('respects maxResults limit', () => {
    const results = engine.parseResults(fixtureHtml, 2);
    expect(results).toHaveLength(2);
  });

  it('returns empty array for empty HTML', () => {
    const results = engine.parseResults('<html><body></body></html>', 10);
    expect(results).toEqual([]);
  });
});
