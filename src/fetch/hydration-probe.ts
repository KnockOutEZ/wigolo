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
  querySelectorAll(selector: string): { length: number };
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

export function isHydrated(doc: ProbeDocument): boolean {
  const article = doc.querySelector('article');
  if (measure(article) > 500) {
    const pCount = countBlocks(article, 'p');
    const codeCount = countBlocks(article, 'pre, code');
    if (pCount >= 3 || codeCount >= 2 || pCount + codeCount >= 4) return true;
  }

  const main = doc.querySelector('main');
  if (measure(main) > 500) {
    const pCount = countBlocks(main, 'p');
    const codeCount = countBlocks(main, 'pre, code');
    if (pCount >= 3 || codeCount >= 2 || pCount + codeCount >= 4) return true;
  }

  const contentEl = doc.querySelector(SPA_CONTENT_SELECTORS);
  if (measure(contentEl) > 500) {
    const pCount = countBlocks(contentEl, 'p');
    const codeCount = countBlocks(contentEl, 'pre, code');
    if (pCount >= 3 || codeCount >= 2 || pCount + codeCount >= 4) return true;
  }

  const appRoot = doc.querySelector(SPA_APP_ROOT_SELECTORS);
  if (measure(appRoot) > 1200) {
    const pCount = countBlocks(appRoot, 'p');
    const codeCount = countBlocks(appRoot, 'pre, code');
    if (pCount >= 3 || codeCount >= 2 || pCount + codeCount >= 4) return true;
  }

  const paragraphs = doc.querySelectorAll('p');
  let pText = 0;
  const limit = Math.min(paragraphs.length, 12);
  for (let i = 0; i < limit; i++) {
    pText += (paragraphs[i].innerText ?? '').length;
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

// Shared browser-side predicate body. Returns true when the article body is
// present. Inlined as a string so the browser context needs no module graph;
// kept in lockstep with isHydrated() above. Both injectable sources below wrap
// this same expression so the render-tier wait and the app-shell re-poll
// agree on "is the body present?".
const HYDRATED_PREDICATE_BODY = `
  const SPA_APP_ROOT_SELECTORS = ${JSON.stringify(SPA_APP_ROOT_SELECTORS)};
  const SPA_CONTENT_SELECTORS = ${JSON.stringify(SPA_CONTENT_SELECTORS)};
  const measure = (el) => el ? ((el.innerText || '').trim().length) : 0;
  const countBlocks = (el, sel) => {
    if (!el) return 0;
    try { return el.querySelectorAll(sel).length; } catch { return 0; }
  };

  const article = document.querySelector('article');
  if (measure(article) > 500) {
    const p = countBlocks(article, 'p');
    const c = countBlocks(article, 'pre, code');
    if (p >= 3 || c >= 2 || p + c >= 4) return true;
  }

  const main = document.querySelector('main');
  if (measure(main) > 500) {
    const p = countBlocks(main, 'p');
    const c = countBlocks(main, 'pre, code');
    if (p >= 3 || c >= 2 || p + c >= 4) return true;
  }

  const contentEl = document.querySelector(SPA_CONTENT_SELECTORS);
  if (measure(contentEl) > 500) {
    const p = countBlocks(contentEl, 'p');
    const c = countBlocks(contentEl, 'pre, code');
    if (p >= 3 || c >= 2 || p + c >= 4) return true;
  }

  const appRoot = document.querySelector(SPA_APP_ROOT_SELECTORS);
  if (measure(appRoot) > 1200) {
    const p = countBlocks(appRoot, 'p');
    const c = countBlocks(appRoot, 'pre, code');
    if (p >= 3 || c >= 2 || p + c >= 4) return true;
  }

  const paragraphs = document.querySelectorAll('p');
  let pText = 0;
  const limit = Math.min(paragraphs.length, 12);
  for (let i = 0; i < limit; i++) {
    pText += ((paragraphs[i].innerText || '')).length;
  }
  return pText > 700;
`;

// Source string for injection into Playwright's page.waitForFunction. We
// inline the constants so the browser context doesn't need our module graph.
export const HYDRATION_PROBE_SOURCE = `(() => {${HYDRATED_PREDICATE_BODY}})()`;

// Source for the app-shell-only re-poll. Resolves true once the body has
// mounted (so waitForFunction can re-poll for it after a longer budget). We
// reuse the hydrated predicate directly — "wait until hydrated" is the gate
// regardless of whether the first wait timed out. Kept separate from
// HYDRATION_PROBE_SOURCE only for call-site clarity.
export const HYDRATED_WAIT_SOURCE = HYDRATION_PROBE_SOURCE;

// Source that reports whether the current DOM is an app-shell with no body
// yet — an SPA root exists but the hydrated predicate is unsatisfied. Used
// (via page.evaluate) to decide whether a probe timeout warrants escalation.
export const APP_SHELL_ONLY_SOURCE = `(() => {
  const hydrated = (() => {${HYDRATED_PREDICATE_BODY}})();
  if (hydrated) return false;
  const SPA_APP_ROOT_SELECTORS = ${JSON.stringify(SPA_APP_ROOT_SELECTORS)};
  return document.querySelector(SPA_APP_ROOT_SELECTORS) !== null;
})()`;
