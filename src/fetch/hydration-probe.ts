// Hydration probe — shared between browser-pool and playwright-tier so both
// fetch paths agree on "is this SPA done rendering its article body?". The
// probe ships as a self-contained function rather than a string so we can
// unit-test it directly against a linkedom-parsed DOM.
//
// Detection layers (any one fires success):
//   1. Semantic landmark: <article> or <main> with substantial text AND
//      either enough <p> blocks OR enough <pre>/<code> blocks (code-heavy
//      docs like react.dev/learn ship few <p>s).
//   2. Known SPA / docs root: Next.js #__next, React #root/[data-reactroot],
//      Vue 3 [data-v-app], VitePress .vp-doc (and outer .VPDoc), Docusaurus
//      .theme-doc-markdown, GitHub .markdown-body, Tailwind/Astro .prose,
//      [role=main]. Text + content-block threshold.
//   3. Paragraph fallback: many <p>s with combined text, for blogs.
//
// Thresholds are deliberately loose for code-heavy docs since react.dev /
// VitePress / docusaurus articles routinely run < 5 paragraphs of prose
// with the bulk of the content in <pre><code> blocks.

interface ProbeElement {
  innerText?: string | null;
  querySelectorAll(selector: string): ArrayLike<ProbeElement>;
  closest?(selector: string): ProbeElement | null;
}

interface ProbeDocument {
  querySelector(selector: string): ProbeElement | null;
  querySelectorAll(selector: string): ArrayLike<ProbeElement>;
}

// App-root selectors wrap the whole SPA — nav, sidebar, article, footer.
// Need a high text threshold to avoid matching when only the nav-shell mounted.
const SPA_APP_ROOT_SELECTORS = [
  '#__next',
  '#root',
  '[data-reactroot]',
  '[data-v-app]',
].join(', ');

// Site chrome that surrounds the article: nav, header, sidebar, footer. The
// app-root branch must NOT count chrome text or chrome content-blocks, or a
// large nav-only shell (react.dev's sidebar ships > 1200 chars of link text and
// several <p> blocks BEFORE the article mounts) falsely reads as hydrated, the
// escalation re-poll never fires, and page.content() captures nav-only HTML.
const NAV_CHROME_SELECTORS = [
  'nav',
  'header',
  'aside',
  'footer',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '.sidebar',
].join(', ');

// Content-class selectors target the article body only — no nav, no sidebar.
// Lower threshold matches the article/main semantic-landmark path.
const SPA_CONTENT_SELECTORS = [
  '.vp-doc',
  '.VPDoc',
  '.theme-doc-markdown',
  '.markdown-body',
  '.prose',
  '[role="main"]',
].join(', ');

function measure(el: ProbeElement | null): number {
  if (!el) return 0;
  const text = el.innerText ?? '';
  return text.trim().length;
}

function countBlocks(el: ProbeElement | null, selector: string): number {
  if (!el) return 0;
  try {
    return el.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

// Within an app-root that wraps the whole SPA, measure ONLY genuine article
// content: prose/code blocks that are NOT inside nav/header/aside/footer
// chrome. Returns combined block text length plus separate <p> and code counts
// so the app-root branch can apply the same content-block threshold the
// semantic-landmark branches use, but against article body only — never the
// surrounding chrome. This is what stops a nav-only shell reading as hydrated.
function measureContentOutsideChrome(
  root: ProbeElement | null,
): { textLen: number; pCount: number; codeCount: number; rowCount: number } {
  if (!root) return { textLen: 0, pCount: 0, codeCount: 0, rowCount: 0 };
  const inChrome = (el: ProbeElement): boolean =>
    typeof el.closest === 'function' && el.closest(NAV_CHROME_SELECTORS) !== null;
  let textLen = 0;
  let pCount = 0;
  let codeCount = 0;
  let rowCount = 0;
  const tally = (selector: string, onMatch: (el: ProbeElement) => void): void => {
    let nodes: ArrayLike<ProbeElement>;
    try {
      nodes = root.querySelectorAll(selector);
    } catch {
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (inChrome(node)) continue;
      onMatch(node);
    }
  };
  // Mirror the semantic-landmark branches' counting (p separately, pre+code
  // together, tr separately) but only over blocks OUTSIDE site chrome, and sum
  // their text so the threshold reflects genuine article prose, never
  // nav/sidebar link text. Table rows count only alongside prose at the call
  // site — see the app-root condition's `pCount >= 1 && …` gate.
  tally('p', (el) => {
    pCount += 1;
    textLen += measure(el);
  });
  tally('pre, code', (el) => {
    codeCount += 1;
    textLen += measure(el);
  });
  tally('tr', (el) => {
    rowCount += 1;
    textLen += measure(el);
  });
  return { textLen, pCount, codeCount, rowCount };
}

// A hydrated landmark needs substantial text AND enough genuine content
// blocks. Data-table articles (pricing grids, API tables) carry body in <tr>
// rows — but rows ONLY count toward the threshold when at least one prose <p>
// is co-present. A real data-table article has surrounding paragraphs; a
// nav-as-table or a "Loading…" skeleton table has rows but no prose, so it must
// NOT read as hydrated (that would leak a shell as content in the render gate).
// There is deliberately no standalone row-count disjunct.
function hasContentBlocks(el: ProbeElement | null): boolean {
  if (measure(el) <= 500) return false;
  const pCount = countBlocks(el, 'p');
  const codeCount = countBlocks(el, 'pre, code');
  const rowCount = countBlocks(el, 'tr');
  return pCount >= 3 || codeCount >= 2 || (pCount >= 1 && pCount + codeCount + rowCount >= 4);
}

export function isHydrated(doc: ProbeDocument): boolean {
  if (hasContentBlocks(doc.querySelector('article'))) return true;
  if (hasContentBlocks(doc.querySelector('main'))) return true;
  if (hasContentBlocks(doc.querySelector(SPA_CONTENT_SELECTORS))) return true;

  // App-root catch-all: an SPA root wraps nav + sidebar + article + footer, so
  // measuring its whole innerText counts chrome. Require genuine article
  // content OUTSIDE that chrome — otherwise a large nav-only shell (react.dev's
  // sidebar) reads as hydrated before the body mounts and escalation never fires.
  const appRoot = doc.querySelector(SPA_APP_ROOT_SELECTORS);
  if (appRoot) {
    const { textLen, pCount, codeCount, rowCount } = measureContentOutsideChrome(appRoot);
    if (textLen > 500 && (pCount >= 3 || codeCount >= 2 || (pCount >= 1 && pCount + codeCount + rowCount >= 4))) return true;
  }

  // Paragraph fallback for blogs without semantic landmarks. Skip paragraphs
  // living inside site chrome so a nav/sidebar whose link descriptions are <p>
  // tags (react.dev's sidebar) can't satisfy the body threshold on its own.
  const paragraphs = doc.querySelectorAll('p');
  let pText = 0;
  let counted = 0;
  for (let i = 0; i < paragraphs.length && counted < 12; i++) {
    const p = paragraphs[i];
    if (typeof p.closest === 'function' && p.closest(NAV_CHROME_SELECTORS)) continue;
    pText += (p.innerText ?? '').length;
    counted += 1;
  }
  return pText > 700;
}

// Is this DOM an SPA app-shell that has NOT yet mounted its article body?
// True when a known SPA app-root exists (so the page IS a client-rendered
// app) but the hydration probe is not satisfied (body still absent). Used to
// decide whether a probe timeout warrants a longer-budget re-poll vs. the page
// genuinely having no semantic body (a plain doc that simply isn't an SPA).
export function isAppShellOnly(doc: ProbeDocument): boolean {
  if (isHydrated(doc)) return false;
  return doc.querySelector(SPA_APP_ROOT_SELECTORS) !== null;
}

// Body innerText below this many characters is a near-empty page — a blank
// SPA root, an error stub, or a challenge interstitial that never mounted a
// body. Distinct from nav_shell/app_shell (which have chrome text but no
// article) so the completeness taxonomy can report `empty` for a page with
// essentially nothing rendered at all.
const NEAR_EMPTY_BODY_CHARS = 80;

// The primitives the completeness taxonomy is derived from, read once after the
// settle gate exits. `hasContent` is the same predicate the render gate waits on
// (isHydrated), so a page that settled via the probe is hasContent=true by
// construction; `hasSpaRoot` marks a client-app frame; `hasNavChrome` marks
// site chrome (nav/header/aside/footer). A page with neither frame signal AND
// no content is thin/frameless (rendered but unstructured), NOT a shell —
// nav_shell/app_shell REQUIRE their frame evidence. `nearEmpty` flags a page
// with essentially no rendered body.
export interface DomVerdict {
  hasContent: boolean;
  hasSpaRoot: boolean;
  hasNavChrome: boolean;
  nearEmpty: boolean;
}

export function classifyDom(doc: ProbeDocument): DomVerdict {
  const body = doc.querySelector('body');
  const bodyLen = body ? (body.innerText ?? '').trim().length : 0;
  return {
    hasContent: isHydrated(doc),
    hasSpaRoot: doc.querySelector(SPA_APP_ROOT_SELECTORS) !== null,
    hasNavChrome: doc.querySelector(NAV_CHROME_SELECTORS) !== null,
    nearEmpty: bodyLen < NEAR_EMPTY_BODY_CHARS,
  };
}

// Shared browser-side predicate body. Returns true when the article body is
// present. Inlined as a string so the browser context needs no module graph;
// kept in lockstep with isHydrated() above. Both injectable sources below wrap
// this same expression so the render-tier wait and the app-shell re-poll
// agree on "is the body present?".
const HYDRATED_PREDICATE_BODY = `
  const SPA_APP_ROOT_SELECTORS = ${JSON.stringify(SPA_APP_ROOT_SELECTORS)};
  const SPA_CONTENT_SELECTORS = ${JSON.stringify(SPA_CONTENT_SELECTORS)};
  const NAV_CHROME_SELECTORS = ${JSON.stringify(NAV_CHROME_SELECTORS)};
  const measure = (el) => el ? ((el.innerText || '').trim().length) : 0;
  const countBlocks = (el, sel) => {
    if (!el) return 0;
    try { return el.querySelectorAll(sel).length; } catch { return 0; }
  };
  const measureContentOutsideChrome = (root) => {
    if (!root) return { textLen: 0, pCount: 0, codeCount: 0, rowCount: 0 };
    const inChrome = (el) => typeof el.closest === 'function' && el.closest(NAV_CHROME_SELECTORS) !== null;
    let textLen = 0, pCount = 0, codeCount = 0, rowCount = 0;
    const tally = (sel, onMatch) => {
      let nodes;
      try { nodes = root.querySelectorAll(sel); } catch { return; }
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        if (inChrome(node)) continue;
        onMatch(node);
      }
    };
    tally('p', (el) => { pCount += 1; textLen += measure(el); });
    tally('pre, code', (el) => { codeCount += 1; textLen += measure(el); });
    tally('tr', (el) => { rowCount += 1; textLen += measure(el); });
    return { textLen, pCount, codeCount, rowCount };
  };

  const hasBlocks = (el) => {
    if (measure(el) <= 500) return false;
    const p = countBlocks(el, 'p');
    const c = countBlocks(el, 'pre, code');
    const r = countBlocks(el, 'tr');
    return p >= 3 || c >= 2 || (p >= 1 && p + c + r >= 4);
  };
  if (hasBlocks(document.querySelector('article'))) return true;
  if (hasBlocks(document.querySelector('main'))) return true;
  if (hasBlocks(document.querySelector(SPA_CONTENT_SELECTORS))) return true;

  const appRoot = document.querySelector(SPA_APP_ROOT_SELECTORS);
  if (appRoot) {
    const m = measureContentOutsideChrome(appRoot);
    if (m.textLen > 500 && (m.pCount >= 3 || m.codeCount >= 2 || (m.pCount >= 1 && m.pCount + m.codeCount + m.rowCount >= 4))) return true;
  }

  const paragraphs = document.querySelectorAll('p');
  let pText = 0;
  let counted = 0;
  for (let i = 0; i < paragraphs.length && counted < 12; i++) {
    const p = paragraphs[i];
    if (typeof p.closest === 'function' && p.closest(NAV_CHROME_SELECTORS)) continue;
    pText += ((p.innerText || '')).length;
    counted += 1;
  }
  return pText > 700;
`;

// Source string for injection into Playwright's page.waitForFunction. We
// inline the constants so the browser context doesn't need our module graph.
export const HYDRATION_PROBE_SOURCE = `(() => {${HYDRATED_PREDICATE_BODY}})()`;

// Source that reports whether the current DOM is an app-shell with no body
// yet — an SPA root exists but the hydrated predicate is unsatisfied. Used
// (via page.evaluate) to decide whether a probe timeout warrants escalation.
export const APP_SHELL_ONLY_SOURCE = `(() => {
  const hydrated = (() => {${HYDRATED_PREDICATE_BODY}})();
  if (hydrated) return false;
  const SPA_APP_ROOT_SELECTORS = ${JSON.stringify(SPA_APP_ROOT_SELECTORS)};
  return document.querySelector(SPA_APP_ROOT_SELECTORS) !== null;
})()`;

// Browser-side companion to classifyDom(): returns the {hasContent, hasSpaRoot,
// hasNavChrome, nearEmpty} verdict in one page.evaluate after the settle gate
// exits. Reuses HYDRATED_PREDICATE_BODY for hasContent so the verdict and the
// render gate can never disagree on "is the body present?".
export const DOM_VERDICT_SOURCE = `(() => {
  const hasContent = (() => {${HYDRATED_PREDICATE_BODY}})();
  const SPA_APP_ROOT_SELECTORS = ${JSON.stringify(SPA_APP_ROOT_SELECTORS)};
  const NAV_CHROME_SELECTORS = ${JSON.stringify(NAV_CHROME_SELECTORS)};
  const hasSpaRoot = document.querySelector(SPA_APP_ROOT_SELECTORS) !== null;
  const hasNavChrome = document.querySelector(NAV_CHROME_SELECTORS) !== null;
  const bodyLen = (document.body && document.body.innerText ? document.body.innerText : '').trim().length;
  const nearEmpty = bodyLen < ${NEAR_EMPTY_BODY_CHARS};
  return { hasContent, hasSpaRoot, hasNavChrome, nearEmpty };
})()`;

// Content metrics snapshot for the stability poller: text length + node count
// of article content OUTSIDE nav chrome. Cheap enough to run every poll tick.
//
// Both metrics are derived from the SAME set of LEAF content blocks (no
// article/main containers, which would double-count their own children), each
// excluded via per-element closest() if it lives inside nav chrome. A nav-only
// SPA shell (react.dev's sidebar, 40 stable link descriptions) therefore reads
// textLen≈0 — never a large STABLE value the stability gate could lock onto
// before the article body mounts. Per-element exclusion (not body-minus-Σchrome)
// avoids double-subtracting NESTED chrome (e.g. an <aside class="sidebar"> and
// its child <nav>), which would otherwise drive a real article's textLen to 0
// and mask the stability fallback. isStable()'s ratio guard (prev.textLen>0)
// rejects a textLen≈0 shell as unstable, so only the probe or the budget ends
// that wait.
export const CONTENT_METRICS_SOURCE = `(() => {
  const NAV_CHROME_SELECTORS = ${JSON.stringify(NAV_CHROME_SELECTORS)};
  const inChrome = (el) => typeof el.closest === 'function' && el.closest(NAV_CHROME_SELECTORS) !== null;
  let textLen = 0;
  let nodes = 0;
  const blocks = document.querySelectorAll('p, pre, code, li, h1, h2, h3, td');
  for (let i = 0; i < blocks.length; i++) {
    const el = blocks[i];
    if (inChrome(el)) continue;
    nodes += 1;
    textLen += ((el.innerText || '')).length;
  }
  return { textLen, nodes };
})()`;
