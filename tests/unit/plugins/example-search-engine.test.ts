import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('search() is a function', () => {
    expect(typeof searchEngine.search).toBe('function');
  });

  // Mocked rather than live: CI runners are offline/rate-limited often enough
  // that a real hn.algolia.com call makes this suite flaky. The README shows a
  // one-liner live check for anyone who wants to hit the real endpoint.
  it('maps an HN Algolia hit to the RawSearchResult shape end-to-end', async () => {
    // A trimmed real response from https://hn.algolia.com/api/v1/search —
    // the fields the example plugin actually maps.
    const hnFixture = {
      hits: [
        {
          title: 'Show HN: Agentic coding with local models',
          url: 'https://example.com/agentic-coding',
          story_text: null,
          _highlightResult: { title: { value: 'Agentic coding' } },
          points: 128,
          num_comments: 45,
          objectID: '39001234',
        },
        {
          title: 'Ask HN: Best agentic coding setup?',
          url: null, // Ask HN posts have no external URL — maps to the HN item page
          story_text: 'What are people using day to day?',
          points: 42,
          num_comments: 87,
          objectID: '39005678',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(hnFixture), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

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
    // The query reached the mocked endpoint, not the network.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(String(fetchMock.mock.calls[0][0])).toContain('hn.algolia.com');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});
