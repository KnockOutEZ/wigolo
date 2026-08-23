import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { stripHiddenDom, HIDDEN_SELECTORS } from '../../../src/extraction/visibility.js';
import { extractContent } from '../../../src/extraction/pipeline.js';

/**
 * A page's hidden nodes must not reach an agent as though a human had read them.
 * Before this filter existed, suppression was whatever the winning extractor
 * happened to do: readability drops `style="display:none"`, defuddle and turndown
 * do not, and a site-specific extractor sidesteps the question by scoping to a
 * region. That made the guarantee page-shape dependent — the same GitHub session
 * banner was suppressed on a repo page (site extractor) and leaked on the JS shell
 * beside it (defuddle). Filtering in the shared pre-pass makes it extractor-independent.
 */
describe('stripHiddenDom', () => {
  const strip = (html: string): string => {
    const { document } = parseHTML(html);
    stripHiddenDom(document);
    return document.body.innerHTML;
  };

  it('removes an element carrying the bare [hidden] attribute', () => {
    const out = strip(
      '<html><body><p>visible body copy</p><span hidden>You signed out in another tab or window.</span></body></html>',
    );
    expect(out).toContain('visible body copy');
    expect(out).not.toContain('You signed out');
  });

  it('KEEPS hidden="until-found" — find-in-page reveals it, so a human can read it', () => {
    const out = strip(
      '<html><body><details hidden="until-found"><p>collapsed but findable answer</p></details></body></html>',
    );
    expect(out).toContain('collapsed but findable answer');
  });

  it('removes inline display:none and visibility:hidden, tolerating spacing and case', () => {
    const out = strip(
      `<html><body>
         <div class="shortdescription" style="display:none">General-purpose programming language</div>
         <div style="DISPLAY : NONE">upper case with spaces</div>
         <div style="color:red;visibility: hidden">invisible but laid out</div>
         <p>kept prose</p>
       </body></html>`,
    );
    expect(out).toContain('kept prose');
    expect(out).not.toContain('General-purpose programming language');
    expect(out).not.toContain('upper case with spaces');
    expect(out).not.toContain('invisible but laid out');
  });

  it('KEEPS aria-hidden="true" — it hides from assistive tech, not from a sighted reader', () => {
    // WYSIWYG is the claim: what a human SEES. An aria-hidden decorative wrapper is
    // on screen. Dropping it would remove visible content in the name of suppressing
    // invisible content, which is the opposite defect.
    //
    // The inline `style` is load-bearing, not decoration: without an attribute that
    // puts the element in the candidate set, `stripHiddenDom` never looks at it and
    // the assertion passes for the wrong reason — it would survive a version of
    // `isHidden` that treats aria-hidden as hidden.
    const out = strip(
      '<html><body><div aria-hidden="true" style="opacity:1"><p>visible decorative caption</p></div></body></html>',
    );
    expect(out).toContain('visible decorative caption');
  });

  it('never removes a wrapper that contains the page <main>, even if it is marked hidden', () => {
    // Symmetric with stripBoilerplateDom's guard: a pre-render shell that marks its
    // layout wrapper hidden must not cost us the whole article.
    const out = strip(
      '<html><body><div style="display:none"><main><h1>Article</h1><p>the entire body</p></main></div></body></html>',
    );
    expect(out).toContain('the entire body');
  });

  it('never removes <body> or <html> themselves', () => {
    const { document } = parseHTML(
      '<html><body hidden><p>pre-hydration body copy</p></body></html>',
    );
    stripHiddenDom(document);
    expect(document.body).not.toBeNull();
    expect(document.body.innerHTML).toContain('pre-hydration body copy');
  });

  it('exposes the mechanisms it filters on, so the corpus can cite them', () => {
    expect(HIDDEN_SELECTORS).toContain('[hidden]');
  });
});

describe('hidden content does not survive extraction, whichever extractor wins', () => {
  // The github-node-contributors shape: a JS shell with no article body, so no
  // site-specific extractor claims it and the fallback chain answers. The session
  // banner is the SAME markup GitHub ships on its repo pages.
  const sessionChrome =
    '<div class="js-flash-container">' +
    '<span class="js-stale-session-flash-signed-in" hidden>You signed in with another tab or window. Reload to refresh your session.</span>' +
    '<span class="js-stale-session-flash-signed-out" hidden>You signed out in another tab or window. Reload to refresh your session.</span>' +
    '</div>';

  it('drops GitHub session chrome on a JS shell', async () => {
    const html = `<html><head><title>Contributors</title></head><body>${sessionChrome}
      <main><h2>Contributions to main, excluding merge commits and bot accounts</h2></main>
    </body></html>`;
    const { markdown } = await extractContent(html, 'https://github.com/nodejs/node/graphs/contributors');
    expect(markdown).not.toContain('You signed out in another tab');
    expect(markdown).not.toContain('You signed in with another tab');
  });

  it('drops a MediaWiki shortdescription that only the readability path used to catch', async () => {
    // Deliberately shaped so readability declines (too little prose) and the
    // turndown floor answers instead — the path that had no visibility filter at all.
    const html = `<html><head><title>Widget</title></head><body>
      <div class="shortdescription nomobile noexcerpt noprint searchaux" style="display:none">Hidden one-line gloss</div>
      <p>Short visible lead.</p>
    </body></html>`;
    const { markdown } = await extractContent(html, 'https://en.wikipedia.org/wiki/Widget');
    expect(markdown).toContain('Short visible lead');
    expect(markdown).not.toContain('Hidden one-line gloss');
  });
});
