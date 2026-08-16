import { describe, it, expect } from 'vitest';
import { xExtractor } from '../../../../src/extraction/site-extractors/x.js';
import { routedExtract } from '../../../../src/extraction/v1/routed.js';

// X post permalinks are the one page class where turning the bundled
// extractor's async path off would otherwise cost the user real content: the
// body is client-rendered, and wigolo previously had no extractor of its own
// for the site. These tests pin the replacement — the post is recovered from
// the card metadata X serves in the SAME response wigolo already fetched, so
// the content survives with zero additional requests.

const POST_URL = 'https://x.com/janedoe/status/1899999999999999999';

const SHELL_WITH_CARD = `<!doctype html><html><head>
<meta property="og:title" content="Jane Doe on X">
<meta property="og:description" content="A post long enough that a reader learns something from it.">
<meta property="og:url" content="https://x.com/janedoe/status/1899999999999999999">
<meta name="twitter:creator" content="@janedoe">
</head><body><div id="react-root"></div>
<noscript>JavaScript is not available.</noscript></body></html>`;

describe('xExtractor.canHandle', () => {
  it.each([
    'https://x.com/janedoe/status/1899999999999999999',
    'https://twitter.com/janedoe/status/1899999999999999999',
    'https://www.x.com/janedoe/status/123',
    'https://mobile.twitter.com/janedoe/status/123',
    'https://x.com/janedoe/article/123',
    'https://x.com/janedoe/status/123/photo/1',
  ])('handles the post permalink %s', (url) => {
    expect(xExtractor.canHandle(url)).toBe(true);
  });

  it.each([
    // Scope is post permalinks only. Profiles, timelines, settings and search
    // keep the generic path — narrowing the blast radius is deliberate, since
    // those pages never reached the third-party code path either.
    'https://x.com/janedoe',
    'https://x.com/home',
    'https://x.com/i/flow/login',
    'https://x.com/janedoe/status/notanumber',
    'https://x.com/search?q=test',
    // Look-alike hosts must not be adopted — a post extractor firing on
    // someone else's domain would emit that site's card as if it were an X
    // post.
    'https://x.com.evil.example/janedoe/status/123',
    'https://notx.com/janedoe/status/123',
    'https://example.com/janedoe/status/123',
    'not a url at all',
  ])('does not handle %s', (url) => {
    expect(xExtractor.canHandle(url)).toBe(false);
  });
});

describe('xExtractor.extract', () => {
  it('recovers the post text from the card X served with the page', () => {
    const result = xExtractor.extract(SHELL_WITH_CARD, POST_URL);
    expect(result).not.toBeNull();
    expect(result!.markdown).toContain('A post long enough that a reader learns something from it.');
    expect(result!.markdown).toContain('Jane Doe');
    expect(result!.markdown).toContain('@janedoe');
  });

  it('emits a structured record so callers do not have to re-parse the markdown', () => {
    const result = xExtractor.extract(SHELL_WITH_CARD, POST_URL);
    expect(result!.site_data).toMatchObject({
      post_id: '1899999999999999999',
      post_kind: 'status',
      author_handle: 'janedoe',
      author_name: 'Jane Doe',
    });
    expect(result!.extractor).toBe('site-specific');
  });

  it('does not repeat the handle when X puts it in the title too', () => {
    const html = SHELL_WITH_CARD.replace(
      'content="Jane Doe on X"',
      'content="Jane Doe (@janedoe) on X"',
    );
    const result = xExtractor.extract(html, POST_URL);
    expect(result!.markdown).toContain('# Jane Doe (@janedoe)');
    expect(result!.markdown).not.toContain('(@janedoe) (@janedoe)');
  });

  it('returns null when the response carries no card text, so the generic chain still runs', () => {
    const noCard = '<!doctype html><html><head><title>X</title></head><body><div id="react-root"></div></body></html>';
    expect(xExtractor.extract(noCard, POST_URL)).toBeNull();
  });

  it('returns null for a URL it does not own even if handed X-shaped markup', () => {
    expect(xExtractor.extract(SHELL_WITH_CARD, 'https://example.com/some/page')).toBeNull();
  });
});

describe('x post pages through the routed pipeline', () => {
  it('serves a client-rendered post that the generic chain reduces to a JS warning', async () => {
    const result = await routedExtract({ html: SHELL_WITH_CARD, url: POST_URL });
    expect(result.extractor).toBe('site-specific');
    expect(result.markdown).toContain('A post long enough that a reader learns something from it.');
    // The measured pre-change behaviour for this body, once the third-party
    // calls are off, is the <noscript> string and nothing else. Asserting the
    // absence keeps this test honest about WHY the extractor exists.
    expect(result.markdown).not.toBe('JavaScript is not available.');
  });

  it('leaves an X page outside its scope on the generic path', async () => {
    const profile = `<!doctype html><html><head><title>Jane</title>
      <meta property="og:description" content="a bio"></head><body>
      <article><h1>Jane Doe</h1>${'<p>Profile prose that the generic extractor handles perfectly well on its own.</p>'.repeat(
        8,
      )}</article></body></html>`;
    const result = await routedExtract({ html: profile, url: 'https://x.com/janedoe' });
    expect(result.extractor).not.toBe('site-specific');
    expect(result.markdown).toContain('Profile prose that the generic extractor handles');
  });
});
