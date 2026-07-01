import { describe, it, expect } from 'vitest';
import { extractMetadata } from '../../src/extraction/metadata.js';
import { mergeMetadata } from '../../src/extraction/pipeline.js';

// Sub-ticket 2.11: fetch tool and extract mode=metadata previously diverged
// on which fields they surfaced. Unifying both paths around
// the canonical extractMetadata function means the same HTML must yield the
// same og_image, og_type, canonical_url, and keywords regardless of which
// tool the caller invoked.

const FIXTURE = `
<html>
  <head>
    <title>pgEdge — Postgres You Control</title>
    <meta name="description" content="Bring your own cloud account">
    <meta property="og:image" content="https://pgedge.com/og.png">
    <meta property="og:type" content="website">
    <meta name="twitter:image" content="https://pgedge.com/tw.png">
    <meta name="keywords" content="postgres, distributed, multi-master">
    <link rel="canonical" href="https://pgedge.com/">
  </head>
  <body><p>Body</p></body>
</html>
`;

describe('fetch ⇄ extract metadata parity', () => {
  it('mergeMetadata over an extractor base produces the same og fields as extractMetadata', () => {
    const direct = extractMetadata(FIXTURE);
    const merged = mergeMetadata(
      // A minimal base shape: extractor sets nothing for og_image, og_type,
      // canonical_url, keywords — those are the parity fields under test.
      { description: undefined, author: undefined, date: undefined, language: undefined },
      FIXTURE,
    );

    expect(merged.og_image).toBe(direct.og_image);
    expect(merged.og_type).toBe(direct.og_type);
    expect(merged.canonical_url).toBe(direct.canonical_url);
    expect(merged.keywords).toEqual(direct.keywords);
  });

  it('twitter:image fallback shows up in both paths when og:image is absent', () => {
    const html = `
      <html><head>
        <meta name="twitter:image" content="https://example.com/tw.png">
      </head><body></body></html>
    `;

    const direct = extractMetadata(html);
    const merged = mergeMetadata({}, html);

    expect(direct.og_image).toBe('https://example.com/tw.png');
    expect(merged.og_image).toBe('https://example.com/tw.png');
  });
});
