/**
 * Visibility pre-pass — drop DOM-hidden subtrees before any extractor runs.
 *
 * WYSIWYG is the claim being defended: text a human cannot see must not reach an
 * agent's context as though they had read it. Before this pass, whether that held
 * depended on which extractor happened to win the route — the content extractor's
 * readability tier drops `style="display:none"`, its defuddle tier and the turndown
 * floor do not, and a site-specific extractor sidesteps the question entirely by
 * scoping to a region. That is why GitHub's `[hidden]` session banner was suppressed
 * on a repo page and leaked on the JS shell beside it: same markup, different route.
 * Filtering here, in the shared pre-pass, makes suppression extractor-independent.
 */

/** The mechanisms filtered on. Attribute-value nuance is applied in `isHidden`. */
export const HIDDEN_SELECTORS: ReadonlyArray<string> = ['[hidden]', '[style]'];

/**
 * `display:none` / `visibility:hidden` in an inline style, tolerant of spacing, case and
 * `!important`.
 *
 * `!important` is not an exotic spelling to tolerate — it is the one a page that MEANS to
 * hide something reaches for, because it is how an inline declaration overrides a
 * stylesheet. A version of this pattern that required `;` or end-of-string immediately
 * after the value therefore missed the likeliest real spelling while matching the
 * textbook one, and a draft hidden with `display: none !important` read as visible.
 * Whitespace is allowed between `!` and `important` because the CSS grammar allows it.
 */
const INLINE_HIDDEN =
  /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i;

/**
 * Strings and comments are removed before the test, in that order, exactly as a CSS
 * tokenizer resolves them: a `/*` inside a string is not a comment, and a declaration
 * inside either is not a declaration. Removing them cuts both ways on purpose —
 * `display:/*x*\/none` is a real suppression the raw text hides, and
 * `content:"display:none"` is a false one it would otherwise invent.
 */
const CSS_STRING = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;

/** Never removable: the document scaffolding itself. */
const STRUCTURAL = new Set(['HTML', 'HEAD', 'BODY']);

export interface VisibilityNode {
  readonly parentNode: VisibilityParentNode | null;
}

export interface VisibilityParentNode extends VisibilityNode {
  readonly childNodes: ArrayLike<VisibilityNode>;
  removeChild(child: VisibilityNode): void;
}

export interface VisibilityElement extends VisibilityParentNode {
  readonly tagName: string;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): VisibilityElement | null;
}

export interface VisibilityDocument {
  querySelectorAll(selector: string): ArrayLike<VisibilityElement>;
}

/**
 * True when the element is hidden from a sighted reader by the DOM itself.
 *
 * `aria-hidden="true"` is deliberately NOT a trigger: it hides an element from
 * assistive technology while leaving it on screen, so removing it would delete
 * visible content in the name of suppressing invisible content — the opposite
 * defect. `hidden="until-found"` is likewise kept: find-in-page reveals it, so
 * the text is reachable by a human.
 */
export function isHidden(el: VisibilityElement): boolean {
  const hidden = el.getAttribute('hidden');
  if (hidden !== null && hidden.trim().toLowerCase() !== 'until-found') return true;
  const style = el.getAttribute('style');
  if (style === null) return false;
  return INLINE_HIDDEN.test(style.replace(CSS_STRING, '').replace(CSS_COMMENT, ''));
}

/**
 * True when a `<main>` carries content a reader would lose. An EMPTY `<main>` is free for
 * a page to write, which is the whole problem with letting its presence decide anything.
 */
function carriesArticle(main: VisibilityElement): boolean {
  return (main.textContent ?? '').trim() !== '';
}

/**
 * Remove everything inside `hidden` that is not on the path down to `main`, leaving the
 * article and nothing else. Every node dropped here was declared hidden by the page, so
 * dropping it is the declaration being honoured; what survives is only the shell's own
 * `<main>`, never the text parked beside it.
 */
function pruneToMain(hidden: VisibilityElement, main: VisibilityElement): void {
  let keep: VisibilityNode = main;
  while (keep !== hidden) {
    const parent = keep.parentNode;
    if (parent === null) return;
    // Snapshot: childNodes is live, and removing from it while iterating skips nodes.
    for (const child of Array.from(parent.childNodes)) {
      if (child !== keep) parent.removeChild(child);
    }
    keep = parent;
  }
}

export function stripHiddenDom(document: VisibilityDocument): void {
  const seen = new Set<VisibilityElement>();
  const candidates: VisibilityElement[] = [];
  for (const sel of HIDDEN_SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (seen.has(el)) continue;
      seen.add(el);
      candidates.push(el);
    }
  }

  for (const el of candidates) {
    if (STRUCTURAL.has(el.tagName)) continue;
    if (!isHidden(el)) continue;
    // A pre-hydration shell that marks its layout wrapper hidden must not cost us the
    // article — but the rescue is scoped to the article, not extended to the wrapper.
    // stripBoilerplateDom's version of this guard softens a class-name HEURISTIC, so
    // erring towards keeping is right there; here it would soften an explicit author
    // declaration, and the author is the untrusted party. Skipping the whole subtree made
    // the presence of a `<main>` — free to write, empty or not — a page-controlled switch
    // deciding whether suppression fired at all (A-92-1).
    const main = el.querySelector('main');
    if (main !== null && carriesArticle(main)) {
      pruneToMain(el, main);
      continue;
    }
    el.parentNode?.removeChild(el);
  }
}
