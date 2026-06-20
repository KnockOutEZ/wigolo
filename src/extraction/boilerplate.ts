export const BOILERPLATE_TEXT_EQUALITY: ReadonlyArray<string> = [
  'was this helpful?',
  'send',
  'edit this page',
  'edit on github',
  'suggest changes',
  'skip to main content',
  'on this page',
];

export const BOILERPLATE_TEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /^\s*last updated on .+$/i,
];

export const BOILERPLATE_SELECTORS: ReadonlyArray<string> = [
  '[class*="feedback"]',
  '[class*="edit-page"]',
  '[aria-label*="Edit"]',
  'footer[class*="docs"]',
  '[class*="sticky-cta"]',
  'main [role="banner"]',
  '[role="navigation"]',
  // Match genuine sidebars (sidebar, docs-sidebar, sidebar-nav) and the layout
  // wrappers whose state/grid class merely contains the substring (react.dev's
  // `grid-cols-sidebar-content`, VitePress's `has-sidebar`). The main-landmark
  // guard in stripBoilerplateDom keeps any matched element that WRAPS the page's
  // single <main>, so this stays broad without deleting the article body.
  '[class*="sidebar"]',
  '[data-collection="docs"]',
];

export interface BoilerplateDocument {
  querySelectorAll(selector: string): ArrayLike<BoilerplateElement>;
}

interface BoilerplateElement {
  parentNode: { removeChild(child: BoilerplateElement): void } | null;
  querySelector(selector: string): unknown;
}

export function stripBoilerplateMarkdown(md: string): string {
  if (!md) return md;
  const lines = md.split('\n');
  const kept = lines.filter((line) => {
    const t = line.trim().toLowerCase();
    if (!t) return true;
    if (BOILERPLATE_TEXT_EQUALITY.includes(t)) return false;
    return !BOILERPLATE_TEXT_PATTERNS.some((re) => re.test(line));
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

export function stripBoilerplateDom(document: BoilerplateDocument): void {
  for (const sel of BOILERPLATE_SELECTORS) {
    const nodes = document.querySelectorAll(sel);
    const list: BoilerplateElement[] = [];
    for (let i = 0; i < nodes.length; i++) list.push(nodes[i]);
    for (const el of list) {
      // Never remove a wrapper that contains the page's primary content
      // landmark. Boilerplate (nav/sidebar/footer/feedback) never wraps the
      // single <main>; a layout/state class that merely contains "sidebar"
      // (react.dev's grid-cols-sidebar-content, VitePress's has-sidebar) does.
      // Guarding on <main> keeps the article body while still removing genuine
      // sidebars and chrome (which sit beside <main>, not around it).
      if (el.querySelector('main')) continue;
      el.parentNode?.removeChild(el);
    }
  }
}
