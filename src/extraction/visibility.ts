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

const QUOTE_DOUBLE = 0x22;
const QUOTE_SINGLE = 0x27;
const SLASH = 0x2f;
const STAR = 0x2a;
const BACKSLASH = 0x5c;

/**
 * Strings and comments are removed before the test, exactly as a CSS tokenizer resolves
 * them: a `/*` inside a string is not a comment, a quote inside a comment is not a string,
 * and a declaration inside either is not a declaration. Removing them cuts both ways on
 * purpose — `display:/*x*\/none` is a real suppression the raw text hides, and
 * `content:"display:none"` is a false one it would otherwise invent.
 *
 * Written as one left-to-right scan rather than the two `String.replace` passes it replaces,
 * because those were quadratic in a length the PAGE picks. Not by backtracking: by repeated
 * failed starts. `/'(?:[^'\\]|\\.)*'/g` given `'` and then a run of `\'` finds a quote to
 * open at every other index, and each one consumes the rest of the attribute before failing
 * for want of a close; the lazy `/\/\*[\s\S]*?\*\//g` does the same for every `/*` when no
 * `*\/` appears anywhere. Measured clean 4x per doubling — 5 ms at 4 KB to 1.2 s at 64 KB,
 * 19 s at 256 KB — and `isHidden` runs on every `[style]` node of every HTML extraction,
 * synchronous on the daemon event loop, so one attribute stalled every request beside it.
 * A cap on the attribute length would have bought the same latency with a constant that
 * expires; a scan that visits each character once has no constant to expire.
 *
 * An unterminated string or comment consumes to the end of the attribute, which is what a
 * browser does with an unclosed comment and what makes the surviving text the declarations
 * a browser would actually apply. The two `replace` passes left an unterminated construct
 * in place instead, so `style="display:none/*"` read as VISIBLE — the trailing `/` denied
 * the pattern the `;`-or-end it requires — and the page's own suppression went unhonoured.
 */
function stripStringsAndComments(style: string): string {
  let out = '';
  let kept = 0;
  let i = 0;
  while (i < style.length) {
    const ch = style.charCodeAt(i);
    if (ch === QUOTE_DOUBLE || ch === QUOTE_SINGLE) {
      out += style.slice(kept, i);
      for (i++; i < style.length; i++) {
        const inner = style.charCodeAt(i);
        // A backslash escapes whatever follows, the delimiter included, so the pair is
        // consumed whole and a trailing lone backslash simply ends the attribute.
        if (inner === BACKSLASH) i++;
        else if (inner === ch) {
          i++;
          break;
        }
      }
      kept = i;
      continue;
    }
    if (ch === SLASH && style.charCodeAt(i + 1) === STAR) {
      out += style.slice(kept, i);
      const close = style.indexOf('*/', i + 2);
      i = close === -1 ? style.length : close + 2;
      kept = i;
      continue;
    }
    i++;
  }
  return kept === 0 ? style : out + style.slice(kept);
}

/** Never removable: the document scaffolding itself. */
const STRUCTURAL = new Set(['HTML', 'HEAD', 'BODY']);

/**
 * Elements whose text a browser never paints, so it is not "visible copy" for the purpose
 * of telling a pre-hydration shell apart from a page with an article of its own.
 */
const NON_RENDERED = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE']);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_NODE = 9;

export interface VisibilityNode {
  readonly parentNode: VisibilityParentNode | null;
  readonly nodeType: number;
  readonly textContent: string | null;
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
  readonly body: VisibilityElement | null;
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
  return INLINE_HIDDEN.test(stripStringsAndComments(style));
}

/**
 * True when a `<main>` carries content a reader would lose. An EMPTY `<main>` is free for
 * a page to write, which is the whole problem with letting its presence decide anything.
 */
function carriesArticle(main: VisibilityElement): boolean {
  return (main.textContent ?? '').trim() !== '';
}

/**
 * True when the document paints any text outside its hidden subtrees — the discriminator
 * between a page that IS a pre-hydration shell and a page that merely contains one.
 *
 * Narrowing the rescue to a non-empty `<main>` (A-92-1) did not take the switch away from
 * the untrusted party, because an injection payload is non-empty by construction:
 * `carriesArticle` was satisfied by the page's own text, so the page still decided whether
 * its own `hidden` declaration was honoured. Nothing INSIDE the hidden subtree can settle
 * that question, since the author writes all of it. The rest of the document can: a real
 * shell has not painted its article yet, so there is nothing else to read, while a page
 * smuggling copy through a hidden `<main>` has its visible article sitting beside it. The
 * page can still suppress that signal — but only by hiding its own visible content, which
 * costs it the thing it was trying to keep.
 *
 * Hidden subtrees are skipped as they are elsewhere in this pass: counting a second hidden
 * node as "visible text outside" would break the rescue for genuine shells, which routinely
 * ship hidden chrome (GitHub's session banner is the canonical one) beside their wrapper.
 *
 * That skip is also why the candidate under test needs no exclusion of its own, and why the
 * answer is one document-wide fact rather than one per candidate: a candidate only reaches
 * this question after `isHidden` held for it, so the walk drops it below on its own, and
 * `body` — the only root passed — is never a candidate because `STRUCTURAL` filters it out.
 */
function hasVisibleTextOutside(root: VisibilityElement): boolean {
  // An explicit stack rather than recursion, because the depth here is the page's nesting
  // depth and the page picks it: ~40 KB of nested `<div>`s overflowed the call stack, and
  // `cleanHtml` catches a throw from this pass and falls back to the RAW html — so the
  // overflow switched BOTH pre-passes off and carried the page's hidden copy straight
  // through. A WYSIWYG guard may fail closed; failing open on input the untrusted party
  // authors is the one direction that cannot stand.
  const stack: VisibilityParentNode[] = [root];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        if ((child.textContent ?? '').trim() !== '') return true;
        continue;
      }
      if (child.nodeType !== ELEMENT_NODE) continue;
      const el = child as VisibilityElement;
      if (NON_RENDERED.has(el.tagName)) continue;
      if (isHidden(el)) continue;
      stack.push(el);
    }
  }
  return false;
}

/**
 * Remove everything inside `hidden` that is not on the path down to `main`, leaving the
 * article and nothing else. Every node dropped here was declared hidden by the page, so
 * dropping it is the declaration being honoured; what survives is only the shell's own
 * `<main>`, never the text parked beside it.
 */
function pruneToMain(
  hidden: VisibilityElement,
  main: VisibilityElement,
  settled: Set<VisibilityNode>,
): void {
  let keep: VisibilityNode = main;
  while (keep !== hidden) {
    const parent = keep.parentNode;
    if (parent === null) return;
    // Snapshot: childNodes is live, and removing from it while iterating skips nodes.
    for (const child of Array.from(parent.childNodes)) {
      if (child !== keep) parent.removeChild(child);
    }
    keep = parent;
    // The wrappers between the article and the outer candidate survive this prune, are
    // hidden themselves as often as not, and are therefore candidates in their own right —
    // each one asking the same question about the same <main> and re-running a prune that
    // has already finished. `hidden` is excluded because the loop exits before recording it
    // and it cannot recur anyway, and `main` is excluded because it is not a wrapper: a
    // <main> that is itself hidden is still removed on its own turn, exactly as before.
    if (keep !== hidden) settled.add(keep);
  }
}

export function stripHiddenDom(document: VisibilityDocument): void {
  const body = document.body;
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

  // The shell-vs-contains-shell question is one document-wide fact, not one per candidate:
  // nothing this loop does can change the answer, because every node it removes lies inside
  // a hidden subtree and the walk already skips those. Asking it per candidate made a page
  // of K hidden `<main>` wrappers O(K × DOM) — a page-controlled synchronous stall on the
  // unauthenticated fetch path, measured at 4.1 s for K=500 beside a 50 000-node body.
  // Lazy, so an ordinary page — where no candidate ever reaches the question — never walks.
  let paintsOutsideHidden: boolean | undefined;
  const pageIsShell = (): boolean => {
    // No body is no evidence of shell-ness, and this is a suppression gate: the absence of
    // the signal declines the exemption rather than granting it. Honouring the page's own
    // `hidden` is the safe direction to fall.
    if (body === null) return false;
    paintsOutsideHidden ??= hasVisibleTextOutside(body);
    return !paintsOutsideHidden;
  };

  // Removing a candidate detaches every hidden node below it, but those nodes are already in
  // `candidates` and each was still asked the rescue question — one `querySelector` over its
  // own detached-but-populated subtree apiece, so K nested wrappers cost K × subtree. Nothing
  // outside the document can affect the output, so the answer is not worth its price: this is
  // the same page-controlled superlinear shape the memo above removed from `pageIsShell`,
  // left behind on the scan beside it and measured at 3.8 s for K=5 000 on a 40 000-element
  // budget, synchronous, on the unauthenticated fetch path.
  //
  // Reachability is read off the tree — the question `isConnected` answers, asked by walking
  // parents up to the document — rather than inferred from a note taken at each removal, so
  // it cannot drift from what the tree actually says if a later edit detaches a node by some
  // other route. It is written out rather than delegated because that walk is O(depth) and
  // the page picks the depth: detachment is permanent within one pass, so every node proven
  // detached is cached and a nest that reaches an already-proven ancestor stops there, which
  // the DOM property cannot do and which is what keeps the guard itself from being the next
  // O(K²). Proven-CONNECTED is deliberately not cached — a node connected now can be
  // detached by any later removal, and a stale yes there would leak hidden copy.
  const offDocument = new Set<VisibilityNode>();
  const isDetached = (start: VisibilityElement): boolean => {
    const path: VisibilityNode[] = [];
    let node: VisibilityNode | null = start;
    while (node !== null && !offDocument.has(node)) {
      if (node.nodeType === DOCUMENT_NODE) return false;
      path.push(node);
      node = node.parentNode;
    }
    for (const seenOff of path) offDocument.add(seenOff);
    return true;
  };

  // Wrappers a completed prune has already settled — see `pruneToMain`.
  const settled = new Set<VisibilityNode>();

  for (const el of candidates) {
    if (STRUCTURAL.has(el.tagName)) continue;
    // Ordered cheapest-first, and `isHidden` before the reachability walk on purpose: an
    // ordinary page ships thousands of `[style]` nodes that declare nothing about
    // visibility, and they are the ones that must not pay for a walk they cannot use.
    if (!isHidden(el)) continue;
    if (settled.has(el)) continue;
    if (isDetached(el)) continue;
    // A pre-hydration shell that marks its layout wrapper hidden must not cost us the
    // article — but the rescue is scoped to the article, not extended to the wrapper.
    // stripBoilerplateDom's version of this guard softens a class-name HEURISTIC, so
    // erring towards keeping is right there; here it would soften an explicit author
    // declaration, and the author is the untrusted party. Skipping the whole subtree made
    // the presence of a `<main>` — free to write, empty or not — a page-controlled switch
    // deciding whether suppression fired at all (A-92-1). Both conditions below are the
    // same requirement asked of the two things the page controls separately: the `<main>`
    // must not be the throwaway an author writes for free, AND the page must actually BE a
    // shell rather than merely contain one. Neither alone survives an author who wants the
    // exemption; the second is the one an injection payload cannot satisfy.
    const main = el.querySelector('main');
    if (main !== null && carriesArticle(main) && pageIsShell()) {
      pruneToMain(el, main, settled);
      continue;
    }
    el.parentNode?.removeChild(el);
  }
}
