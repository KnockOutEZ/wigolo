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

  it('stands aside when the page rendered readable prose of its own', () => {
    // Measured: X normally server-renders around a thousand characters of app
    // chrome, and the generic chain produces a real result from it. Replacing
    // that measured output with a card summary would be an unmeasured trade,
    // so this extractor must not fire there at all.
    const rendered = SHELL_WITH_CARD.replace(
      '<div id="react-root"></div>',
      `<div id="react-root">${'<span>Rendered post body and surrounding interface text. </span>'.repeat(
        8,
      )}</div>`,
    );
    expect(xExtractor.extract(rendered, POST_URL)).toBeNull();
  });

  it('declines a card that describes a profile rather than this post', () => {
    // This is the falsifying case, and it is not hypothetical: real captured
    // x.com profile responses carry a profile blurb in og:description. Emitting
    // that under a "post by @handle" heading would be confidently WRONG, which
    // is strictly worse than the honestly-useless notice it replaced. An absent
    // card is safe; a card about something else is not.
    const profileCard = `<!doctype html><html><head>
      <meta property="og:title" content="Jane Doe (@janedoe) on X">
      <meta property="og:type" content="profile">
      <meta property="og:description" content="Bio line for the account, which is not the text of any post.">
      <meta property="og:url" content="https://x.com/janedoe">
      </head><body><div id="react-root"></div></body></html>`;
    expect(xExtractor.extract(profileCard, POST_URL)).toBeNull();
  });

  it('declines a card that names a different post', () => {
    const otherPost = SHELL_WITH_CARD.replace(
      'content="https://x.com/janedoe/status/1899999999999999999"',
      'content="https://x.com/janedoe/status/1234567890123456789"',
    );
    expect(xExtractor.extract(otherPost, POST_URL)).toBeNull();
  });

  it('declines when the response never says what the card is about', () => {
    // Unverifiable is treated exactly like wrong. The extractor only speaks
    // when the page itself identifies the card's subject.
    const noOgUrl = SHELL_WITH_CARD.replace(
      /<meta property="og:url"[^>]*>/,
      '',
    );
    expect(xExtractor.extract(noOgUrl, POST_URL)).toBeNull();
  });

  it('declines a card whose declared URL is on someone else\'s domain', () => {
    const foreign = SHELL_WITH_CARD.replace(
      'content="https://x.com/janedoe/status/1899999999999999999"',
      'content="https://evil.example/janedoe/status/1899999999999999999"',
    );
    expect(xExtractor.extract(foreign, POST_URL)).toBeNull();
  });

  it('still fires when the only text on the page is the JavaScript-required notice', () => {
    // The notice must not count as prose — it is the very signal that the page
    // did not render, so counting it would switch the extractor off in exactly
    // the case it exists for.
    const longNotice = SHELL_WITH_CARD.replace(
      '<noscript>JavaScript is not available.</noscript>',
      `<noscript>${'JavaScript is not available. We have detected that JavaScript is disabled in this browser. '.repeat(
        4,
      )}</noscript>`,
    );
    expect(xExtractor.extract(longNotice, POST_URL)).not.toBeNull();
  });

  it('counts no prose from an unterminated noscript opener', () => {
    // A non-greedy strip that REQUIRES its closing tag leaves the whole region
    // in the count, so an unclosed opener reads as "this page rendered" and
    // switches the gate off. A browser swallows the rest of the document here,
    // and so must this.
    const unterminated = SHELL_WITH_CARD.replace(
      '<noscript>JavaScript is not available.</noscript>',
      `<noscript>${'JavaScript is not available in this browser and the page cannot render. '.repeat(
        4,
      )}`,
    );
    expect(xExtractor.extract(unterminated, POST_URL)).not.toBeNull();
  });

  it('counts no prose from an HTML comment containing a bare > character', () => {
    // `<[^>]+>` stops at the first `>` INSIDE the comment and leaks the whole
    // tail as visible text. Measured: without the comment strip this body
    // scores 370 against a floor of 200, so the gate would decline a page that
    // is in fact blank. The repeat count is sized off that measurement — at 4
    // repeats the leak is 190 and the test passes either way, guarding nothing.
    const commented = SHELL_WITH_CARD.replace(
      '<div id="react-root"></div>',
      `<div id="react-root"></div><!-- if a > b then ${'this commented-out note is not visible text. '.repeat(
        8,
      )} -->`,
    );
    expect(xExtractor.extract(commented, POST_URL)).not.toBeNull();
  });

  it('counts no prose from an unterminated comment followed by real markup', () => {
    // An unterminated comment swallows the rest of the document in a browser.
    // The tail-eating behaviour of `<[^>]+>` hides this whenever nothing after
    // the opener contains a `>`, so the fixture deliberately puts a tag between
    // the opener and the text: without the comment strip the text after that
    // tag leaks as prose (measured 311), with it the body scores 0.
    const unterminatedComment = SHELL_WITH_CARD.replace(
      '<div id="react-root"></div>',
      `<div id="react-root"></div><!-- note <span>${'leaked prose after the unterminated comment opener. '.repeat(
        6,
      )}`,
    );
    expect(xExtractor.extract(unterminatedComment, POST_URL)).not.toBeNull();
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
