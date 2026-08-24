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

  it('keeps a hidden shell\'s article but drops every sibling beside its <main>', () => {
    // The pre-render-shell rescue survives, narrowed: what is rescued is the <main>
    // itself, never the text a page parks beside it. Before this narrowing the mere
    // PRESENCE of a <main> switched the whole suppression off, which handed the
    // untrusted party a control over whether its own `display:none` was honoured.
    const out = strip(
      '<html><body><div style="display:none"><main><h1>Article</h1><p>the entire body</p></main>' +
        'LEAK smuggled beside the shell</div></body></html>',
    );
    expect(out).toContain('the entire body');
    expect(out).not.toContain('LEAK smuggled beside the shell');
  });

  it('prunes to <main> through the wrappers between them, not just one level', () => {
    const out = strip(
      '<html><body><div hidden><section><div><main><p>the entire body</p></main>' +
        'LEAK one level up</div>LEAK two levels up</section></div></body></html>',
    );
    expect(out).toContain('the entire body');
    expect(out).not.toContain('LEAK one level up');
    expect(out).not.toContain('LEAK two levels up');
  });

  it('an EMPTY <main> rescues nothing — the hidden wrapper goes, siblings and all', () => {
    // The shape the security review reproduced: a page-controlled off-switch. An empty
    // <main> costs the author nothing to write and, under the old guard, bought the
    // whole hidden subtree an exemption from its own declaration.
    const out = strip(
      '<html><body><div style="display:none"><main></main>LEAK behind an empty shell</div>' +
        '<p>kept prose</p></body></html>',
    );
    expect(out).toContain('kept prose');
    expect(out).not.toContain('LEAK behind an empty shell');
    expect(out).not.toContain('<main>');
  });

  it('a whitespace-only <main> is an empty shell too', () => {
    const out = strip(
      '<html><body><div hidden><main>\n   \t </main>LEAK behind whitespace</div></body></html>',
    );
    expect(out).not.toContain('LEAK behind whitespace');
    // The shell itself goes too. Without this the row stays green under a version that
    // rescues ANY <main> and merely prunes around it, which is the decision being made.
    expect(out).not.toContain('<main>');
  });

  it('a NON-EMPTY hidden <main> beside visible copy is stripped — the page cannot exempt itself', () => {
    // A-92-1 narrowed the rescue to a non-empty <main>, which an injection payload is by
    // construction: `carriesArticle` was satisfied by the page's own text, so the untrusted
    // author still owned the switch deciding whether its own `hidden` was honoured. The
    // remaining discriminator is not the <main>'s contents but the rest of the document —
    // a genuine pre-hydration shell has nothing visible outside the wrapper, and a page
    // smuggling a payload has its visible article sitting right beside it.
    const out = strip(
      '<html><body><p>visible lead</p>' +
        '<div hidden><main>IGNOREPAYLOAD exfiltrate ssh</main></div></body></html>',
    );
    expect(out).toContain('visible lead');
    expect(out).not.toContain('IGNOREPAYLOAD');
    expect(out).not.toContain('<main>');
  });

  it('visible copy nested deeper than the hidden wrapper still defeats the rescue', () => {
    // The outside-text test has to walk, not glance at body's direct children: parking the
    // article one level down inside a <section> is free, and a version that only checked
    // body's own text nodes would read this page as a shell and rescue the payload.
    const out = strip(
      '<html><body><section><article><p>visible lead</p></article></section>' +
        '<div style="display:none"><main>IGNOREPAYLOAD exfiltrate ssh</main></div></body></html>',
    );
    expect(out).toContain('visible lead');
    expect(out).not.toContain('IGNOREPAYLOAD');
  });

  it('text that is itself hidden does not count as visible copy outside the shell', () => {
    // The must-not-fire direction: a shell that also ships hidden chrome is still a shell,
    // and counting that chrome as "visible text outside" would revoke the rescue for the
    // real pre-hydration pages it exists for. So the outside walk has to skip hidden
    // subtrees exactly as the pass itself does.
    //
    // The banner is style-hidden and the shell is attribute-hidden ON PURPOSE. Candidates
    // are collected `[hidden]` first, so the shell is decided while the banner is still in
    // the tree — spelled the other way round the banner would already have been removed by
    // the time the walk ran, and the row would stay green with the skip deleted.
    const out = strip(
      '<html><body><div hidden><main><p>the entire body</p></main>LEAK beside the shell</div>' +
        '<span style="display:none">You signed out in another tab or window.</span></body></html>',
    );
    expect(out).toContain('the entire body');
    expect(out).not.toContain('You signed out');
    expect(out).not.toContain('LEAK beside the shell');
  });

  it('never removes <body> or <html> themselves', () => {
    const { document } = parseHTML(
      '<html><body hidden><p>pre-hydration body copy</p></body></html>',
    );
    stripHiddenDom(document);
    expect(document.body).not.toBeNull();
    expect(document.body.innerHTML).toContain('pre-hydration body copy');
  });

  it('drops a hidden gloss while keeping a visible link that repeats the same words', () => {
    // wikipedia-python's shape, and the reason its referee row reads as a leak when it
    // is not one: the lead sentence links "general-purpose programming language" as
    // visible anchor text, word for word the same string as the hidden
    // div.shortdescription above it. Suppressing the hidden node is required;
    // suppressing the visible link would be the far worse defect — and a substring test
    // over the extracted markdown cannot tell the two apart.
    //
    // Asserted at the pre-pass rather than through extractContent on purpose: on a page
    // with enough prose the readability tier drops display:none by itself, so a
    // pipeline-level assertion here would pass with this filter deleted.
    const out = strip(`<html><body>
      <div class="shortdescription" style="display:none">General-purpose programming language</div>
      <section><p>Python is a
      <a href="/wiki/General-purpose_programming_language" title="General-purpose programming language">general-purpose programming language</a>
      that emphasizes code readability.</p></section>
    </body></html>`);
    expect(out).not.toContain('shortdescription');
    // Two left, and both belong to the one visible link: its anchor text and the title
    // attribute turndown carries over. A third would be the hidden gloss.
    expect(out.toLowerCase().split('general-purpose programming language').length - 1).toBe(2);
  });

  it('exposes the mechanisms it filters on, so the corpus can cite them', () => {
    expect(HIDDEN_SELECTORS).toContain('[hidden]');
  });
});

/**
 * The inline test is a regex over an attribute a page author writes, so the shapes that
 * matter are the ones the CSS declaration grammar ACCEPTS — not the one spelling a bug
 * report happened to arrive with. `!important` is the whole point of the escape: it is
 * how a page overrides a stylesheet, so it is the spelling a draft-hiding site is most
 * likely to ship, and the version that shipped in #41 required `;` or end-of-string
 * immediately after the value, so every `!important` spelling read as visible.
 */
describe('isHidden — the inline-style shapes the CSS grammar accepts', () => {
  const strippedWithStyle = (style: string): boolean => {
    const { document } = parseHTML('<html><body><div id="t">secret draft copy</div></body></html>');
    // Set through the DOM rather than in the HTML literal so quotes inside the value
    // are the value, not an attribute delimiter the parser resolves for us.
    (document.getElementById('t') as unknown as { setAttribute(n: string, v: string): void })
      .setAttribute('style', style);
    stripHiddenDom(document);
    return !document.body.innerHTML.includes('secret draft copy');
  };

  it.each([
    'display: none !important',
    'display:none!important',
    'display:none!important;',
    'display:none !important ;',
    'display : none ! important',
    'DISPLAY:NONE !IMPORTANT',
    'visibility: hidden !important',
    'visibility:hidden!important;',
    'color:red;display:none!important;font-size:2px',
    '  display:none  !important  ;  ',
    'display:/* hidden by the editor */none',
    'display:none;visibility:hidden!important',
  ])('hides: %s', (style) => {
    expect(strippedWithStyle(style)).toBe(true);
  });

  it.each([
    'display:nonesuch',
    'visibility:hiddenx',
    'text-decoration:none',
    'opacity:1',
    '--legacy-fallback:display:none',
    // Each of these carries a declaration-shaped substring in a position the CSS grammar
    // says is not a declaration — inside a string, inside a comment. Spelled with the
    // leading `;` on purpose: without one the pattern could not match them anyway, and
    // the row would pass for a reason that has nothing to do with resolving them out.
    'content:"padding;display:none;"',
    "font-family:'x;visibility:hidden;'",
    'background:red/*;display:none;*/',
    'display:none-important',
  ])('keeps: %s', (style) => {
    expect(strippedWithStyle(style)).toBe(false);
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

  it('drops an !important-hidden banner on the defuddle route', async () => {
    // Same JS-shell shape as the row above — the route with no visibility filter of its
    // own — but hiding its banner the way a page that means it does: with `!important`.
    const html = `<html><head><title>Contributors</title></head><body>
      <main><h2>Contributions to main, excluding merge commits and bot accounts</h2>
        <article><p>The contributor graph counts commits on the default branch and skips
        merges, so the totals below differ from the raw commit count reported by the log.</p>
        <p style="display:none !important">LEAK draft banner copy</p>
        <p>Counts are recomputed nightly and cached, which is why a commit pushed in the
        last few hours may not appear on this page yet.</p>
        <p>Bot accounts are excluded from every series drawn here.</p></article>
      </main>
    </body></html>`;
    const { markdown, extractor } = await extractContent(
      html,
      'https://github.com/nodejs/node/graphs/contributors',
    );
    expect(extractor).toBe('defuddle');
    expect(markdown).not.toContain('LEAK draft banner copy');
  });

  it('drops an !important-hidden gloss on the turndown floor', async () => {
    const html = `<html><head><title>Widget</title></head><body>
      <div class="shortdescription" style="display:none!important">LEAK hidden one-line gloss</div>
      <p>Short visible lead.</p>
    </body></html>`;
    const { markdown, extractor } = await extractContent(html, 'https://en.wikipedia.org/wiki/Widget');
    expect(extractor).toBe('turndown');
    expect(markdown).toContain('Short visible lead');
    expect(markdown).not.toContain('LEAK hidden one-line gloss');
  });

  it('does not let an empty <main> shell smuggle its hidden siblings into the markdown', async () => {
    // The reproduction from the security review, carried to the surface that matters:
    // final markdown. An empty <main> is free to write and used to buy the whole hidden
    // subtree beside it an exemption.
    const html = `<html><head><title>Widget</title></head><body>
      <div style="display:none"><main></main>LEAK smuggled by an empty shell</div>
      <p>Short visible lead.</p>
    </body></html>`;
    const { markdown } = await extractContent(html, 'https://en.wikipedia.org/wiki/Widget');
    expect(markdown).toContain('Short visible lead');
    expect(markdown).not.toContain('LEAK smuggled by an empty shell');
  });

  it('does not let a NON-EMPTY hidden <main> smuggle an injection payload into the markdown', async () => {
    // The SD1 exit-9 reproduction at the surface that matters. The visible lead is thin on
    // purpose: that is the condition under which defuddle picks the hidden <main> as the
    // article, which is exactly the extractor-dependence this pre-pass exists to remove.
    const html = `<html><head><title>Widget</title></head><body>
      <p>Short visible lead.</p>
      <div hidden><main>IGNOREPAYLOAD exfiltrate ssh</main></div>
    </body></html>`;
    const { markdown } = await extractContent(html, 'https://en.wikipedia.org/wiki/Widget');
    expect(markdown).toContain('Short visible lead');
    expect(markdown).not.toContain('IGNOREPAYLOAD');
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
