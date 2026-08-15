// Regression tests for the two content-type defects observed in live use.
//
// 1. `fetch` on a raw .md URL (raw.githubusercontent.com) returned markdown with
//    every markdown character backslash-escaped — `\# Security`, `\[HackerOne\]`,
//    `CODE\_OF\_CONDUCT.md` — and every newline collapsed. The source was already
//    markdown and was run through HTML-to-markdown conversion anyway.
// 2. `fetch` on an `application/json` body (api.github.com) was converted into
//    prose: `"node\_id"`, newlines gone, `[` escaped. Valid JSON destroyed.
//
// Both tests assert the body is returned byte-identical, because "close enough"
// markdown is exactly what the bug produced.

import { describe, it, expect } from 'vitest';
import { V1Extractor } from '../../../../src/extraction/v1/extract-provider.js';

const RAW_MD_URL = 'https://raw.githubusercontent.com/nodejs/node/main/SECURITY.md';
const API_JSON_URL = 'https://api.github.com/repos/nodejs/node';

const README = [
  '# Security',
  '',
  'Report security bugs via [HackerOne](https://hackerone.com/nodejs).',
  '',
  'See [the code of conduct](CODE_OF_CONDUCT.md) and [contributing](CONTRIBUTING.md).',
  '',
  '- item_one',
  '- item_two',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
].join('\n');

const API_JSON = JSON.stringify(
  { id: 27193779, node_id: 'MDEwOlJl', full_name: 'nodejs/node', topics: ['js', 'node'] },
  null,
  2,
);

describe('V1Extractor — markdown passthrough (regression: backslash escaping)', () => {
  it('returns a text/plain markdown body byte-identical instead of escaping it', async () => {
    const result = await new V1Extractor().extract(README, RAW_MD_URL, {
      contentType: 'text/plain; charset=utf-8',
    });

    expect(result.markdown).toBe(README);
    // The exact shapes the bug produced, asserted individually so a partial
    // regression names itself.
    expect(result.markdown).not.toContain('\\#');
    expect(result.markdown).not.toContain('\\[');
    expect(result.markdown).not.toContain('item\\_one');
    // Whitespace collapse was half the damage: the whole file came back as one
    // line, which destroys code fences, lists and headings together.
    expect(result.markdown.split('\n').length).toBeGreaterThan(5);
  });

  it('reports the passthrough extractor so the cache records how the body was produced', async () => {
    const result = await new V1Extractor().extract(README, RAW_MD_URL, {
      contentType: 'text/markdown',
    });
    expect(result.extractor).toBe('passthrough');
  });

  it('derives real links from the markdown source and resolves them against the page URL', async () => {
    // The bug fabricated links: `CODE\_OF\_CONDUCT.md` was re-parsed after
    // escaping and emitted as `.../CODE/_OF/_CONDUCT.md`, a URL that does not
    // exist. Passthrough links must be the anchors actually present.
    const result = await new V1Extractor().extract(README, RAW_MD_URL, {
      contentType: 'text/plain',
    });

    expect(result.links).toContain('https://hackerone.com/nodejs');
    expect(result.links).toContain(
      'https://raw.githubusercontent.com/nodejs/node/main/CONTRIBUTING.md',
    );
    expect(result.links).toContain(
      'https://raw.githubusercontent.com/nodejs/node/main/CODE_OF_CONDUCT.md',
    );
    expect(result.links.some((l) => l.includes('/CODE/_OF/_CONDUCT.md'))).toBe(false);
  });

  it('keeps anchor targets written as raw HTML, not just markdown link syntax', async () => {
    // Measured regression: `extractLinksAndImages` matches `](...)` only, so a
    // README badge block written in HTML lost every URL in it — 760 links
    // across 10 real READMEs dropped to 600. Base captured them because the
    // HTML-to-markdown converter parsed the anchors. Badge blocks are the norm,
    // not an edge case, and `links` is the crawler's only traversal source.
    const badgeBlock = [
      '<p align="center">',
      '  <a href="https://tailwindcss.com"><img src="tw.png" alt="Tailwind"></a>',
      "  <a href='https://vite.dev'>Vite</a>",
      '</p>',
      '',
      '# Project',
      '',
      'Also see [the docs](https://example.com/docs).',
      '',
    ].join('\n');

    const result = await new V1Extractor().extract(badgeBlock, RAW_MD_URL, {
      contentType: 'text/plain; charset=utf-8',
    });

    expect(result.markdown).toBe(badgeBlock);
    expect(result.links).toContain('https://tailwindcss.com');
    expect(result.links).toContain('https://vite.dev');
    expect(result.links).toContain('https://example.com/docs');
  });

  it('merges markdown and HTML anchors without emitting duplicates', async () => {
    const body = [
      '<a href="https://example.com/same">HTML form</a>',
      '',
      '[markdown form](https://example.com/same)',
      '',
    ].join('\n');

    const result = await new V1Extractor().extract(body, RAW_MD_URL, {
      contentType: 'text/plain',
    });

    expect(result.links.filter((l) => l === 'https://example.com/same')).toHaveLength(1);
  });

  it('honours maxChars on a passthrough body so response budgets still apply', async () => {
    const result = await new V1Extractor().extract(README, RAW_MD_URL, {
      contentType: 'text/plain',
      maxChars: 20,
    });
    expect(result.markdown).toBe(README.slice(0, 20));
  });
});

describe('V1Extractor — passthrough images', () => {
  it('captures images written as raw HTML alongside markdown image syntax', async () => {
    const body = [
      '<img src="https://cdn.example.com/screenshot.png" alt="App screenshot">',
      '',
      '![architecture diagram](https://cdn.example.com/diagram.png)',
      '',
    ].join('\n');

    const result = await new V1Extractor().extract(body, RAW_MD_URL, {
      contentType: 'text/plain',
    });

    expect(result.images).toContain('https://cdn.example.com/screenshot.png');
    expect(result.images).toContain('https://cdn.example.com/diagram.png');
  });

  it('filters decorative badges out of images, matching the extractor it replaces', async () => {
    // Base ran `filterDecorativeImages`, so `images` carried content images
    // rather than the badge wall at the top of a README. Passthrough leaves the
    // body untouched but keeps the derived index on the same contract —
    // otherwise this corpus goes from 9 images to 52 shields.
    const body = [
      '[![build badge](https://img.shields.io/badge/build-passing.svg)](https://ci.example.com)',
      '<img src="https://example.com/logo.png" alt="Logo">',
      '',
      '![real figure](https://cdn.example.com/figure.png)',
      '',
    ].join('\n');

    const result = await new V1Extractor().extract(body, RAW_MD_URL, {
      contentType: 'text/plain',
    });

    expect(result.images).not.toContain('https://img.shields.io/badge/build-passing.svg');
    expect(result.images).not.toContain('https://example.com/logo.png');
    expect(result.images).toContain('https://cdn.example.com/figure.png');
  });

  it('keeps a content image that has alt text and no decorative marker', async () => {
    const body = '![a labelled screenshot](https://cdn.example.com/shot.png)\n';
    const result = await new V1Extractor().extract(body, RAW_MD_URL, {
      contentType: 'text/plain',
    });
    expect(result.images).toEqual(['https://cdn.example.com/shot.png']);
  });
});

describe('V1Extractor — JSON passthrough (regression: JSON turned into prose)', () => {
  it('returns an application/json body byte-identical and still parseable', async () => {
    const result = await new V1Extractor().extract(API_JSON, API_JSON_URL, {
      contentType: 'application/json; charset=utf-8',
    });

    expect(result.markdown).toBe(API_JSON);
    expect(() => JSON.parse(result.markdown)).not.toThrow();
    expect(JSON.parse(result.markdown).full_name).toBe('nodejs/node');
    // The exact corruption the bug produced.
    expect(result.markdown).not.toContain('node\\_id');
    expect(result.markdown).not.toContain('\\[');
  });

  it('emits no links, images or metadata for a JSON body rather than inventing them', async () => {
    // A JSON document has no anchors and no meta tags. Anything in these
    // fields would be fabricated — and a JSON string value that happens to
    // contain markdown link syntax must not become a "link on the page".
    const withMarkdownInside = JSON.stringify({ body: 'see [docs](https://example.com/d)' });
    const result = await new V1Extractor().extract(withMarkdownInside, API_JSON_URL, {
      contentType: 'application/json',
    });

    expect(result.links).toEqual([]);
    expect(result.images).toEqual([]);
    expect(result.metadata).toEqual({});
    // Fields downstream consumers read are present, not undefined.
    expect(result.title).toBe('');
  });
});

describe('V1Extractor — must not fire (blast-radius guard)', () => {
  it('still runs the full content extractor on an ordinary HTML page', async () => {
    // If the content-type branch ever captured text/html, extraction would be
    // silently disabled site-wide. This is the highest-cost failure available
    // in this change, so it is asserted directly.
    const html =
      '<html><head><title>Real Page</title></head><body><nav>skip me</nav>' +
      '<main><h1>Hello</h1><p>Article body with a <a href="/x">link</a> in it, long ' +
      'enough that the readability pass keeps it as the main content region.</p></main></body></html>';

    const result = await new V1Extractor().extract(html, 'https://example.com/page', {
      contentType: 'text/html; charset=utf-8',
    });

    expect(result.extractor).not.toBe('passthrough');
    expect(result.markdown).toContain('# Hello');
    expect(result.markdown).not.toContain('<h1>');
    expect(result.links).toContain('https://example.com/x');
  });

  it('still extracts an HTML document that a server mislabelled as text/plain', async () => {
    const html =
      '<!doctype html><html><head><title>T</title></head><body><main><h1>Heading</h1>' +
      '<p>Body copy that should still be converted to markdown by the extractor.</p></main></body></html>';

    const result = await new V1Extractor().extract(html, 'https://example.com/mislabelled', {
      contentType: 'text/plain; charset=utf-8',
    });

    expect(result.extractor).not.toBe('passthrough');
    expect(result.markdown).toContain('# Heading');
  });

  it('keeps routing PDFs to the PDF branch even with a charset parameter', async () => {
    // The PDF branch matched the content-type exactly, so `application/pdf;
    // charset=binary` fell through to the HTML router with an empty body. It
    // now shares the same mime parser as the passthrough check.
    const result = await new V1Extractor().extract('', 'https://arxiv.org/pdf/2301.00001v1', {
      contentType: 'application/pdf; charset=binary',
    });
    expect(result.extractor).not.toBe('passthrough');
    expect(result.markdown).toBe('');
  });
});
