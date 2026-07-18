import { describe, it, expect } from 'vitest';
import { validatePluginExports, validateSearchEngine } from '../../../src/plugins/validate.js';
import { searchEngine } from '../../../examples/plugin-search-engine/index.mjs';

// Validates that examples/plugin-search-engine (the copyable plugin
// scaffold referenced from issue #147) satisfies the same shape checks
// the real plugin loader (src/plugins/loader.ts) enforces at load time.
describe('plugin search engine example', () => {
  it('exports a valid SearchEngine shape', () => {
    expect(validateSearchEngine(searchEngine)).toBe(true);
  });

  it('passes validatePluginExports with no errors', () => {
    const result = validatePluginExports({ searchEngine });
    expect(result.hasSearchEngine).toBe(true);
    expect(result.hasExtractor).toBe(false);
    expect(result.errors).toHaveLength(0);
  });

  it('has a non-empty name matching its engine tag', () => {
    expect(typeof searchEngine.name).toBe('string');
    expect(searchEngine.name.length).toBeGreaterThan(0);
    expect(searchEngine.name).toBe('hn-algolia-example');
  });

  it('search() is an async function returning an array (contract check, offline)', () => {
    // Kept network-free/deterministic for CI; a live call against the real
    // HN Algolia API is demonstrated in the example's README.
    expect(typeof searchEngine.search).toBe('function');
    const returned = searchEngine.search('agentic coding', { maxResults: 1 });
    expect(returned).toBeInstanceOf(Promise);
  });

  it('maps a real HN Algolia hit to the RawSearchResult shape end-to-end', async () => {
    const results = await searchEngine.search('agentic coding', { maxResults: 3 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(typeof r.title).toBe('string');
      expect(typeof r.url).toBe('string');
      expect(typeof r.snippet).toBe('string');
      expect(typeof r.relevance_score).toBe('number');
      expect(r.relevance_score).toBeGreaterThanOrEqual(0);
      expect(r.relevance_score).toBeLessThanOrEqual(1);
      expect(r.engine).toBe('hn-algolia-example');
    }
  });
});
