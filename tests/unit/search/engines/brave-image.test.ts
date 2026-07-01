// Brave Search Image adapter.
//
// WHY: Brave is the higher-quality opt-in path for image search — it enables
// image search on the core backend (previously `unsupported_category`)
// alongside the zero-key DDG Image adapter. Brave's image endpoint requires
// an API token
// (`BRAVE_API_KEY`); without one, the adapter throws so the orchestrator
// records a clear `missing_api_key` warning instead of silently dropping.

import { describe, it, expect, beforeEach } from 'vitest';
import { BraveImageEngine } from '../../../../src/search/engines/brave-image.js';
import { resetConfig } from '../../../../src/config.js';

describe('BraveImageEngine', () => {
  const engine = new BraveImageEngine();

  const origEnv = process.env;
  beforeEach(() => {
    process.env = { ...origEnv };
    resetConfig();
  });

  it('has name set to brave-image', () => {
    expect(engine.name).toBe('brave-image');
  });

  it('throws a clear error when BRAVE_API_KEY is not set so the orchestrator can emit env-hint warnings', async () => {
    delete process.env.BRAVE_API_KEY;
    resetConfig();
    await expect(engine.search('cats')).rejects.toThrow(/BRAVE_API_KEY/);
  });

  it('parses results.properties.url into image_url + carries thumbnail/width/height', () => {
    const body = {
      results: [
        {
          title: 'A cat',
          url: 'https://example.com/cats',
          properties: { url: 'https://cdn.example.com/cat.jpg' },
          thumbnail: { src: 'https://cdn.example.com/cat-thumb.jpg' },
          source: 'example.com',
          width: 1200,
          height: 800,
        },
        {
          title: 'Other cat',
          url: 'https://other.example/cat',
          properties: { url: 'https://cdn.example.com/cat2.png' },
          thumbnail: { src: 'https://cdn.example.com/cat2-thumb.png' },
        },
      ],
    };

    const results = engine.parseResults(body, 10);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'A cat',
      url: 'https://example.com/cats',
      image_url: 'https://cdn.example.com/cat.jpg',
      thumbnail_url: 'https://cdn.example.com/cat-thumb.jpg',
      width: 1200,
      height: 800,
      engine: 'brave-image',
    });
    expect(results[0].relevance_score).toBeGreaterThan(results[1].relevance_score);
  });

  it('returns empty array when body has no results', () => {
    expect(engine.parseResults({}, 10)).toEqual([]);
    expect(engine.parseResults({ results: [] }, 10)).toEqual([]);
    expect(engine.parseResults(null, 10)).toEqual([]);
  });

  it('respects maxResults', () => {
    const body = {
      results: [
        { title: 'A', url: 'https://s/a', properties: { url: 'https://i/a.jpg' } },
        { title: 'B', url: 'https://s/b', properties: { url: 'https://i/b.jpg' } },
        { title: 'C', url: 'https://s/c', properties: { url: 'https://i/c.jpg' } },
      ],
    };
    expect(engine.parseResults(body, 2)).toHaveLength(2);
  });

  it('skips entries missing the image asset URL or source URL', () => {
    const body = {
      results: [
        { title: 'A', url: 'https://s/a', properties: { url: 'https://i/a.jpg' } }, // ok
        { title: 'B', url: 'https://s/b' },                                          // no properties
        { title: 'C', url: 'https://s/c', properties: {} },                          // no properties.url
        { title: 'D', properties: { url: 'https://i/d.jpg' } },                      // no url (source)
      ],
    };
    expect(engine.parseResults(body, 10).map((r) => r.title)).toEqual(['A']);
  });

  it('drops width/height when only one of them is reported', () => {
    const body = {
      results: [
        {
          title: 'only-w',
          url: 'https://s/x',
          properties: { url: 'https://i/x.jpg' },
          width: 100,
        },
        {
          title: 'both',
          url: 'https://s/z',
          properties: { url: 'https://i/z.jpg' },
          width: 50,
          height: 60,
        },
      ],
    };
    const results = engine.parseResults(body, 10);
    expect(results[0].width).toBeUndefined();
    expect(results[0].height).toBeUndefined();
    expect(results[1].width).toBe(50);
    expect(results[1].height).toBe(60);
  });
});
