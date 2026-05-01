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
];

export interface BoilerplateDocument {
  querySelectorAll(selector: string): ArrayLike<BoilerplateElement>;
}

interface BoilerplateElement {
  parentNode: { removeChild(child: BoilerplateElement): void } | null;
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
      el.parentNode?.removeChild(el);
    }
  }
}
