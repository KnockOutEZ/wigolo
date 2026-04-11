import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BingEngine } from '../../../../src/search/engines/bing.js';

const fixtureHtml = readFileSync('tests/fixtures/search/bing-results.html', 'utf-8');

describe('BingEngine', () => {
  const engine = new BingEngine();

  it('has name set to bing', () => {
    expect(engine.name).toBe('bing');
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
