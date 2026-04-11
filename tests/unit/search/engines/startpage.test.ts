import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { StartpageEngine } from '../../../../src/search/engines/startpage.js';

const fixtureHtml = readFileSync('tests/fixtures/search/startpage-results.html', 'utf-8');

describe('StartpageEngine', () => {
  const engine = new StartpageEngine();

  it('has name set to startpage', () => {
    expect(engine.name).toBe('startpage');
  });

  it('parses results from Startpage HTML', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results.length).toBe(2);
    expect(results[0].title).toBe('React \u2013 Quick Start');
    expect(results[0].url).toBe('https://react.dev/learn');
    expect(results[0].snippet).toContain('introduction to React');
    expect(results[0].engine).toBe('startpage');
  });

  it('assigns position-based relevance scores', () => {
    const results = engine.parseResults(fixtureHtml, 10);
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });
});
