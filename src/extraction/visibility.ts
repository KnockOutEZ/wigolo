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

/** `display:none` / `visibility:hidden` in an inline style, tolerant of spacing and case. */
const INLINE_HIDDEN = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:;|$)/i;

/** Never removable: the document scaffolding itself. */
const STRUCTURAL = new Set(['HTML', 'HEAD', 'BODY']);

export interface VisibilityElement {
  readonly tagName: string;
  parentNode: { removeChild(child: VisibilityElement): void } | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): unknown;
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
  return style !== null && INLINE_HIDDEN.test(style);
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
    // Same guard stripBoilerplateDom uses, for the same reason: a pre-hydration
    // shell that marks its layout wrapper hidden must not cost us the article.
    // Real hidden chrome sits beside <main>, never around it.
    if (el.querySelector('main')) continue;
    el.parentNode?.removeChild(el);
  }
}
