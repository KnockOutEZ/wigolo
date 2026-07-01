// DDG Image search adapter.
//
// WHY: `category: 'images'` previously returned `unsupported_category` on
// the `core` backend. DDG image is the critical-path zero-key adapter — it
// MUST work without any API token so users can opt into image search out of
// the box. Brave Image (key-gated) is the higher-quality opt-in path.
//
// This file pins parseResults shape so the network layer can change without
// breaking callers. Live HTTP is exercised via the live-network test in
// tests/e2e (gated by WIGOLO_LIVE_NETWORK_TESTS=1 if needed); unit tests
// here mock both the token-fetch and the i.js JSON.

import { describe, it, expect } from 'vitest';
import { DdgImageEngine } from '../../../../src/search/engines/ddg-image.js';

describe('DdgImageEngine', () => {
  const engine = new DdgImageEngine();

  it('has name set to ddg-image', () => {
    expect(engine.name).toBe('ddg-image');
  });

  it('parses i.js results into image-shaped RawSearchResult', () => {
    // Shape mirrors duckduckgo.com/i.js — `image` is the full asset,
    // `thumbnail` is the preview, `url` is the source page.
    const body = {
      results: [
        {
          title: 'A cat',
          image: 'https://cdn.example.com/cat.jpg',
          thumbnail: 'https://cdn.example.com/cat-thumb.jpg',
          url: 'https://example.com/cats',
          width: 1200,
          height: 800,
          source: 'Example',
        },
        {
          title: 'Another cat',
          image: 'https://cdn.example.com/cat2.png',
          thumbnail: 'https://cdn.example.com/cat2-thumb.png',
          url: 'https://other.example/cat',
          width: 600,
          height: 400,
        },
      ],
    };

    const results = engine.parseResults(body, 10);
    expect(results).toHaveLength(2);

    expect(results[0]).toMatchObject({
      title: 'A cat',
      // url is the SOURCE page so callers can navigate; image_url is the asset.
      url: 'https://example.com/cats',
      image_url: 'https://cdn.example.com/cat.jpg',
      thumbnail_url: 'https://cdn.example.com/cat-thumb.jpg',
      width: 1200,
      height: 800,
      engine: 'ddg-image',
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
        { title: 'a', image: 'https://i/a', url: 'https://s/a' },
        { title: 'b', image: 'https://i/b', url: 'https://s/b' },
        { title: 'c', image: 'https://i/c', url: 'https://s/c' },
      ],
    };
    expect(engine.parseResults(body, 2)).toHaveLength(2);
  });

  it('skips entries missing image or source url', () => {
    const body = {
      results: [
        { title: 'A', image: 'https://i/a', url: 'https://s/a' },
        { title: 'B', image: '', url: 'https://s/b' },     // no image
        { title: 'C', url: 'https://s/c' },                  // no image
        { title: 'D', image: 'https://i/d' },                // no source url
      ],
    };
    expect(engine.parseResults(body, 10).map((r) => r.title)).toEqual(['A']);
  });

  it('drops width/height when only one is present (partial dimensions are not trustworthy)', () => {
    const body = {
      results: [
        { title: 'only-w', image: 'https://i/x', url: 'https://s/x', width: 100 },
        { title: 'only-h', image: 'https://i/y', url: 'https://s/y', height: 200 },
        { title: 'both',   image: 'https://i/z', url: 'https://s/z', width: 50, height: 60 },
      ],
    };
    const results = engine.parseResults(body, 10);
    expect(results[0].width).toBeUndefined();
    expect(results[0].height).toBeUndefined();
    expect(results[1].width).toBeUndefined();
    expect(results[1].height).toBeUndefined();
    expect(results[2].width).toBe(50);
    expect(results[2].height).toBe(60);
  });

  it('extracts a vqd token from a DDG HTML token-bootstrap page', () => {
    // DDG embeds the token in vqd='3-1234...' AND in <input value="..."/>
    // shape. The adapter handles both. We just pin the most common pattern.
    const html = `<html><body>...vqd='3-12345abcdef';...</body></html>`;
    const token = engine.extractVqd(html);
    expect(token).toBe('3-12345abcdef');
  });

  it('returns null vqd when the bootstrap HTML carries no token', () => {
    expect(engine.extractVqd('<html><body>no token here</body></html>')).toBeNull();
  });
});
