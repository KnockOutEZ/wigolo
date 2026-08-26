import { describe, it, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import { stripHiddenDom, isHidden, HIDDEN_SELECTORS } from '../../../src/extraction/visibility.js';
import type {
  VisibilityElement,
  VisibilityNode,
  VisibilityParentNode,
} from '../../../src/extraction/visibility.js';
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

  it('a <script> beside the shell is not visible copy, so the rescue still fires', () => {
    // The NON_RENDERED skip has no arm of its own: delete the set and every existing row
    // stays green, because none of them parks a script, style, template or noscript beside
    // a hidden shell. A browser paints none of those, so their source text is not the
    // "visible article sitting beside the wrapper" the discriminator is looking for — and
    // counting it as such would revoke the rescue for essentially every real pre-hydration
    // page, since a JS shell ships its bundle tag by definition.
    const out = strip(
      '<html><body><div hidden><main><p>the entire body</p></main>LEAK beside the shell</div>' +
        '<script>window.__NEXT_DATA__ = {"page":"/"};</script></body></html>',
    );
    expect(out).toContain('the entire body');
    expect(out).not.toContain('LEAK beside the shell');
  });

  it('deep nesting cannot make the pass throw, because a throw here fails OPEN', () => {
    // Found while hoisting the walk (SD1 exit-final). The discriminator used to recurse per
    // DOM level, and the page picks how many levels there are — ~40 KB of nested <div>s
    // overflowed the call stack. That matters far more than a crash: `cleanHtml` catches a
    // throw from this pass and returns the RAW html, so the overflow switched the whole
    // WYSIWYG guard off and the hidden draft below rode through untouched. The nesting is
    // FIRST on purpose: parked after the visible <p> the walk short-circuits on that text
    // and never descends, and the row would pass with the recursion restored.
    const out = strip(
      '<html><body>' +
        '<div>'.repeat(5000) +
        '</div>'.repeat(5000) +
        '<div hidden><main>a</main></div>' +
        '<div hidden>SECRETDRAFT do not publish</div>' +
        '<p>visible lead</p></body></html>',
    );
    expect(out).toContain('visible lead');
    expect(out).not.toContain('SECRETDRAFT');
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
 * The discriminator walks the whole document, and the page decides how many candidates ask
 * it. Asked once per candidate, a page of K hidden `<main>` wrappers beside a large body is
 * O(K × DOM) — measured 4.1 s at K=500 against a 50 000-node body, synchronous, on the
 * unauthenticated fetch path, with the input entirely page-controlled.
 *
 * Counted rather than timed on purpose: a wall-clock bound turns a DoS regression into a
 * flake on a loaded machine, and the shape — not the speed — is the thing being pinned. The
 * count is reads of `body.childNodes`, which is the walk's first act and nothing else in the
 * pass touches it, so one read is one walk.
 */
describe('the shell discriminator costs one document walk, whatever K the page picks', () => {
  const probe = (
    html: string,
  ): { walks: number; out: string } => {
    const { document } = parseHTML(html);
    const real = document.body as unknown as VisibilityElement;
    let walks = 0;
    const body: VisibilityElement = {
      get childNodes(): ArrayLike<VisibilityNode> {
        walks++;
        return real.childNodes;
      },
      get parentNode(): VisibilityParentNode | null {
        return real.parentNode;
      },
      get nodeType(): number {
        return real.nodeType;
      },
      get textContent(): string | null {
        return real.textContent;
      },
      get tagName(): string {
        return real.tagName;
      },
      getAttribute: (name: string) => real.getAttribute(name),
      querySelector: (selector: string) => real.querySelector(selector),
      removeChild: (child: VisibilityNode) => real.removeChild(child),
    };
    stripHiddenDom({
      body,
      querySelectorAll: (selector: string) =>
        document.querySelectorAll(selector) as unknown as ArrayLike<VisibilityElement>,
    });
    return { walks, out: document.body.innerHTML };
  };

  const shell = (k: number): string =>
    '<html><body>' +
    '<div style="display:none"><main>the entire body</main></div>'.repeat(k) +
    '</body></html>';

  it('walks once for one hidden shell', () => {
    const { walks, out } = probe(shell(1));
    expect(walks).toBe(1);
    // The count means nothing if the pass stopped doing its job, so pin the outcome too.
    expect(out).toContain('the entire body');
  });

  it('still walks exactly once when the page ships fifty of them', () => {
    // The arm the per-candidate shape fails, and the reason it is fifty rather than two:
    // a shape that memoised only the previous candidate's answer would pass at K=2.
    const { walks, out } = probe(shell(50));
    expect(walks).toBe(1);
    expect(out).toContain('the entire body');
  });

  it('never walks at all on a page with no hidden <main> to rescue', () => {
    // Laziness is the half that protects the ordinary page: hoisting the walk to the top of
    // the pass would make every page with any `[hidden]` or `[style]` node pay for a
    // discriminator none of its candidates ever asks for.
    const { walks, out } = probe(
      '<html><body><p>ordinary prose</p><span hidden>You signed out in another tab.</span></body></html>',
    );
    expect(walks).toBe(0);
    expect(out).toContain('ordinary prose');
    expect(out).not.toContain('You signed out');
  });
});

/**
 * The candidate list is collected up front from a document-wide `querySelectorAll`, so it
 * still holds every hidden node the page shipped after the pass has started removing them.
 * Two shapes then made the pass superlinear in a number the PAGE picks — K nested hidden
 * wrappers around one constant element budget, measured on the fetch path, synchronous:
 *
 *   - removing an outer wrapper detaches every hidden wrapper below it, but each one was
 *     still asked `querySelector('main')` over its own detached-but-populated subtree
 *     (K=1 → 7 ms, K=1 000 → 795 ms, K=5 000 → 3.8 s at a 40 000-element budget);
 *   - a nest that takes the pre-hydration-shell rescue keeps its wrappers ATTACHED, so
 *     every one of them re-scanned the same surviving subtree and re-ran a prune the first
 *     one had already finished (K=1 → 5 ms, K=1 000 → 1.2 s, K=5 000 → 10.6 s).
 *
 * Counted rather than timed, for the reason the walk pin above gives: a wall-clock bound
 * turns a DoS regression into a flake on a loaded machine, and the shape is the thing being
 * pinned. The count is `querySelector` calls, which is the subtree scan itself — the pass
 * makes exactly one per candidate that reaches the rescue question and none anywhere else.
 */
describe('a nest of hidden wrappers costs one subtree scan, whatever K the page picks', () => {
  const BUDGET = 4000;

  const filler = (k: number, budget: number): string =>
    '<p>filler copy</p>'.repeat(Math.max(0, budget - k));

  /** K nested hidden wrappers, all removed: the page paints an article of its own. */
  const detached = (k: number, budget = BUDGET): string =>
    '<html><body><p>visible lead</p>' +
    '<div hidden>'.repeat(k) +
    `SECRETDRAFT do not publish${filler(k, budget)}` +
    '</div>'.repeat(k) +
    '</body></html>';

  /** K nested hidden wrappers that all survive: the shell rescue fires on every one. */
  const rescued = (k: number, budget = BUDGET): string =>
    '<html><body>' +
    '<div hidden>'.repeat(k) +
    `<main>the entire body${filler(k, budget)}</main>LEAK beside the shell` +
    '</div>'.repeat(k) +
    '</body></html>';

  const probe = (html: string): { scans: number; out: string } => {
    const { document } = parseHTML(html);
    let scans = 0;
    // An own property shadowing the prototype's, rather than a stand-in object: the pass
    // dedupes candidates by identity and hands them back to their real parent to remove,
    // so a wrapper would have to forge both and could pass with the guard deleted.
    const count = (el: VisibilityElement): VisibilityElement => {
      if (Object.prototype.hasOwnProperty.call(el, 'querySelector')) return el;
      const original = el.querySelector.bind(el);
      Object.defineProperty(el, 'querySelector', {
        configurable: true,
        value: (selector: string) => {
          scans++;
          return original(selector);
        },
      });
      return el;
    };
    stripHiddenDom({
      body: document.body as unknown as VisibilityElement,
      querySelectorAll: (selector: string) =>
        Array.from(
          document.querySelectorAll(selector) as unknown as ArrayLike<VisibilityElement>,
        ).map(count),
    });
    return { scans, out: document.body.innerHTML };
  };

  it('scans once for a single hidden wrapper', () => {
    const { scans, out } = probe(detached(1));
    expect(scans).toBe(1);
    expect(out).toContain('visible lead');
    expect(out).not.toContain('SECRETDRAFT');
  });

  it('still scans once when a thousand of them are nested', () => {
    // The detached arm: the outer removal takes all 999 below it out of the document, and a
    // node that is no longer in the document cannot affect the output, so scanning it buys
    // nothing and costs its whole subtree.
    const { scans, out } = probe(detached(1000));
    expect(scans).toBe(1);
    expect(out).toContain('visible lead');
    expect(out).not.toContain('SECRETDRAFT');
  });

  it('still scans once when a thousand nested wrappers all take the shell rescue', () => {
    // The attached arm, which the detachment guard alone does not cover: these wrappers
    // survive on the kept path, so each re-asked the same question about the same <main>
    // and re-ran a prune that was already finished.
    const { scans, out } = probe(rescued(1000));
    expect(scans).toBe(1);
    expect(out).toContain('the entire body');
    expect(out).not.toContain('LEAK beside the shell');
  });

  it('still removes a hidden node INSIDE a rescued <main>', () => {
    // The must-not-fire direction for the kept-path skip, and the reason it is scoped to the
    // wrappers BETWEEN the rescued <main> and the outer wrapper rather than to every
    // descendant of a settled candidate: a hidden node inside the article is not on that
    // path, its own declaration still has to be honoured, and a skip written as
    // "descendant of something already handled" would leak it.
    const { out } = probe(
      '<html><body><div hidden><div hidden><main><p>the entire body</p>' +
        '<span hidden>SECRETDRAFT do not publish</span></main></div></div></body></html>',
    );
    expect(out).toContain('the entire body');
    expect(out).not.toContain('SECRETDRAFT');
  });

  it('stays within a small multiple of K=1 on the clock, on a constant element budget', () => {
    // The counted pins above are the ones that cannot flake, but the finding was a stall,
    // so one row measures the stall. Both sides parse the same number of elements and differ
    // only in how deeply the page nests them; the bound is a multiple of the K=1 measurement
    // on THIS machine plus a floor, because a constant taken from a sample maximum is a
    // constant that expires. The shapes it is protecting against were 100x-plus over the
    // floor on the machine that filed the finding, so the headroom is real in both
    // directions: noise cannot reach it and the regression cannot hide under it.
    const clock = (html: string): number => {
      const { document } = parseHTML(html);
      const started = performance.now();
      stripHiddenDom(document);
      return performance.now() - started;
    };
    // A wider budget than the counted rows use, because the cost being bounded is K times
    // the subtree, so at 4 000 elements the detached arm's regression lands under any floor
    // loose enough to survive a shared CI runner and the row could not go red for it.
    const wide = 20000;
    const one = Math.max(clock(detached(1, wide)), clock(rescued(1, wide)));
    const bound = Math.max(one * 20, 400);
    expect(clock(detached(2000, wide))).toBeLessThan(bound);
    expect(clock(rescued(2000, wide))).toBeLessThan(bound);
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

  /**
   * The rows above all close what they open. A page — hostile or merely hand-formatted —
   * does not have to, and Chromium does not treat an unterminated construct as running to
   * the end of the attribute. Its tokenizer ends a string at a raw newline as a
   * `<bad-string-token>` and ends an unquoted `url(` at the `)` as a `<bad-url-token>`; the
   * declaration parser then discards only up to the next `;` and applies whatever follows.
   * So the suppression AFTER the broken construct is one a reader really does not see.
   *
   * Both spellings are ordinary, not exotic: a font stack written across two lines with an
   * apostrophe in a family name produces the first, and any unquoted `url()` with an
   * apostrophe in the path produces the second. Consuming to end-of-attribute instead
   * swallowed the `display:none` sitting after them and the page's own suppression went
   * unhonoured — on benign markup, not only on an attack.
   *
   * Labelled rather than spelled into the test name because the value carries a real
   * newline, and a multi-line test name is unreadable in every reporter.
   */
  it.each([
    ['a newline ends a string, so the `;` after it separates declarations', "content:'x\n;display:none"],
    ['...the double-quoted twin tokenizes identically', 'content:"x\n;display:none'],
    ['...and the surviving declaration can be the visibility spelling', "content:'x\n;visibility:hidden"],
    [
      'a two-line font stack with an apostrophe in a family name — benign, not hostile',
      "font-family: Bob's Font,\n serif;\n display:none",
    ],
    ['an apostrophe in an unquoted url() ends the token at the `)`', "background:url(a'b);display:none"],
    ['...the same bad-url ahead of the visibility spelling', "background:url(a'b);visibility:hidden"],
    ['a comment opened and never closed runs to EOF, so what precedes it stands', 'display:none/*'],
  ])('hides: %s', (_why, style) => {
    expect(strippedWithStyle(style)).toBe(true);
  });

  /**
   * The same tokenizer read in the other direction, which no row above pinned. A string still
   * open at EOF is NOT a parse error the way a newline is — the tokenizer returns a perfectly
   * good `<string-token>` — so a declaration-shaped substring inside one is content, exactly
   * as it is inside a closed string, and the browser applies nothing. Recovering at the
   * newline without also keeping that direction would invent a suppression the page never
   * declared, which is the mirror defect and the more damaging one: it deletes copy a reader
   * CAN see.
   */
  it.each([
    [
      'a string open at EOF is a valid string token, so its contents stay contents',
      "content:'unclosed; display:none",
    ],
    [
      'the `;` inside a well-formed url() belongs to the url token, not to the declaration list',
      'background:url(a;display:none)',
    ],
    [
      'a `;` before the newline is inside the bad-string, so it separates nothing',
      "content:'a;display:none\n",
    ],
    [
      'with no `;` after it, the bad-string`s own declaration swallows what follows',
      "content:'x\ndisplay:none",
    ],
  ])('keeps: %s', (_why, style) => {
    expect(strippedWithStyle(style)).toBe(false);
  });
});

/**
 * Every row above spells its property and value in ASCII. CSS does not require that: a
 * backslash followed by 1–6 hex digits and one optional trailing whitespace is an escaped
 * code point (css-syntax-3 §4.3.7, "consume an escaped code point"), and an ident sequence
 * is consumed with its escapes RESOLVED (§4.3.11) before the cascade ever compares the
 * property name. `\64 isplay:none` is therefore not a lookalike of `display:none` — to
 * every engine it IS `display:none`, computed style and all.
 *
 * A pattern matching only the literal spellings hands the page a one-character bypass of
 * the WYSIWYG guard: verified against Chromium at SD1 exit-16, which reports
 * `getClientRects().length === 0` for all six spellings below while this pass kept the
 * element for every one of them. Both entry points are pinned because both are load-bearing
 * — `stripHiddenDom` is the removal, and `isHidden` is additionally the skip test inside
 * `hasVisibleTextOutside`, so an escaped hide that reads visible also mis-feeds the
 * shell discriminator's one document-wide fact.
 *
 * The negative rows are the reason this cannot be a blind unescape. A decoded code point is
 * ident CONTENT, never syntax — that is the entire purpose of escaping it — so a decoded
 * `:` does not separate a property from a value and a decoded newline does not delimit
 * anything. Browsers drop both of those declarations, so suppressing them would delete copy
 * a reader can actually see, which is the more damaging direction of the two.
 */
describe('isHidden — CSS identifier escapes are resolved before the property is matched', () => {
  const reads = (style: string): { byIsHidden: boolean; byStrip: boolean } => {
    const { document } = parseHTML(
      '<html><body><p>visible lead</p><div id="t">secret draft copy</div></body></html>',
    );
    const el = document.getElementById('t') as unknown as VisibilityElement & {
      setAttribute(n: string, v: string): void;
    };
    // Set through the DOM, so backslashes in the value are the value rather than something
    // the HTML parser has already had an opinion about.
    el.setAttribute('style', style);
    return {
      byIsHidden: isHidden(el),
      byStrip: (() => {
        stripHiddenDom(document);
        return !document.body.innerHTML.includes('secret draft copy');
      })(),
    };
  };

  it.each([
    ['`\\64 ` is `d`: the hex escape opens the property name', '\\64 isplay:none'],
    ['...and it can sit mid-ident just as legally — `\\70 ` is `p`', 'dis\\70 lay:none'],
    ['six hex digits is the maximum an escape consumes, zero-padded here', '\\000064 isplay:none'],
    ['hex is case-insensitive and `\\44 ` decodes to `D`, which CSS folds', '\\44 isplay:none'],
    ['the VALUE is an ident too, so `\\6e ` is `n` in `none`', 'display:\\6e one'],
    ['the visibility spelling escapes identically — `\\76 ` is `v`', '\\76 isibility:hidden'],
    // Not one of the six, but the same decode step is what settles it: a backslash outside a
    // string escapes the quote into ident content, so `\'` opens nothing and the `;` after it
    // really does start a new declaration. Reading it as a string opener swallowed the
    // suppression written after it.
    ['an escaped quote is ident content, so it never opens a string', "content:\\';display:none"],
  ])('hides: %s', (_why, style) => {
    const { byIsHidden, byStrip } = reads(style);
    expect(byIsHidden).toBe(true);
    expect(byStrip).toBe(true);
  });

  it.each([
    [
      '`\\3a ` escapes the COLON into the ident, so `display\\3a none` is one property name and no declaration',
      'display\\3a none',
    ],
    [
      '`\\d` is a hex escape (U+000D), so `\\display` is CR + `isplay` — not `display`',
      '\\display:none',
    ],
  ])('keeps: %s', (_why, style) => {
    const { byIsHidden, byStrip } = reads(style);
    expect(byIsHidden).toBe(false);
    expect(byStrip).toBe(false);
  });
});

/**
 * The inline test resolves strings and comments out before it runs, and the two patterns that
 * did it were quadratic in a length the PAGE picks — not by backtracking but by repeated
 * failed starts. `'` followed by a run of `\'` gives `/'(?:[^'\\]|\\.)*'/g` a quote to open at
 * every other index, each of which consumes the rest of the attribute before failing for want
 * of a close; `/*` with no `*\/` anywhere gives the lazy comment pattern the same shape. Both
 * measured clean 4x per doubling on tip 6fcfdf13 — 5.0 / 20 / 73 / 304 / 1 246 ms across
 * 4 KB to 64 KB, 19.1 s at a 256 KB attribute, and 17.2 s through this whole pass from a
 * 0.23 MB page. `isHidden` runs on every `[style]` node of every HTML extraction, synchronous
 * on the daemon event loop, so one hostile attribute stalled every concurrent request beside
 * it, live event tails included.
 *
 * Timed rather than counted, unlike the DOM-walk pins above: there is no call to count here —
 * the cost is inside one regex engine — so the clock IS the observable. The bound is a
 * multiple of the SAME-LENGTH benign attribute measured on this machine plus a floor, because
 * a constant taken from a sample maximum expires. The shapes below ran 5x to 20x over that
 * floor on the machine that filed the finding, so noise cannot reach the bound and the
 * regression cannot hide under it.
 *
 * Each shape is asserted twice: once carrying no suppression, where the element must survive,
 * and once with `display:none` in front of the hostile run, where it must still be removed. A
 * fix that made the pass fast by resolving less would go red on the second arm.
 */
describe('a hostile style attribute cannot stall the pass, whatever length the page picks', () => {
  /** Every other index opens a quote that then scans to end-of-attribute and fails. */
  const quoteRun = (bytes: number): string => "content:'" + "\\'".repeat(Math.floor(bytes / 2));
  /**
   * `/*` alone is not enough — `/*\/*` already CONTAINS `*\/`, so the lazy scan matches at
   * once. A filler char between openers keeps every `*` from ever being followed by `/`.
   */
  const commentRun = (bytes: number): string => '/*a'.repeat(Math.floor(bytes / 3));
  /**
   * Resolving an escape reads its hex digits and stops — six of them at the most — so a run
   * of escapes is still one visit per character. Written as `\41` rather than `\\`, because
   * a run of backslashes is a run of escaped BACKSLASHES and would pin half the characters.
   */
  const escapeRun = (bytes: number): string => 'color:' + '\\41'.repeat(Math.floor(bytes / 3));
  /** The same length in characters the sanitizer has no reason to look twice at. */
  const benign = (bytes: number): string => 'color:red;' + 'x'.repeat(bytes);

  const ATTR_BYTES = 128 * 1024;

  const clock = (style: string): { ms: number; kept: boolean } => {
    const { document } = parseHTML(
      '<html><body><p>visible lead</p><div id="t">HOSTILE payload copy</div></body></html>',
    );
    (
      document.getElementById('t') as unknown as { setAttribute(n: string, v: string): void }
    ).setAttribute('style', style);
    const started = performance.now();
    stripHiddenDom(document);
    return {
      ms: performance.now() - started,
      kept: document.body.innerHTML.includes('HOSTILE payload copy'),
    };
  };

  const bound = Math.max(clock(benign(ATTR_BYTES)).ms * 20, 250);

  it.each([
    ['unclosed quote followed by an escaped-quote run', quoteRun],
    ['unclosed comment openers with no close anywhere', commentRun],
    ['a run of hex escapes, each one resolved', escapeRun],
  ])('stays linear on %s', (_name, make) => {
    const visible = clock(make(ATTR_BYTES));
    expect(visible.ms).toBeLessThan(bound);
    // Nothing in either run declares a suppression, so the element is visible copy.
    expect(visible.kept).toBe(true);

    const hiding = clock(`display:none;${make(ATTR_BYTES)}`);
    expect(hiding.ms).toBeLessThan(bound);
    // ...and a real declaration in front of the same run is still honoured.
    expect(hiding.kept).toBe(false);
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
