import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Extractor, ExtractionResult } from '../../types.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

type DocFramework = 'docusaurus' | 'mkdocs' | 'sphinx' | 'gitbook';

const STRIP_SELECTORS = [
  'nav',
  '.docs-sidebar',
  '.sidebar',
  '.toc-wrapper',
  '.table-of-contents',
  '.version-picker',
  '.pagination-nav',
  'header',
  'footer',
];

function detectFramework(html: string): DocFramework | null {
  if (html.includes('docs-sidebar') || html.includes('data-docusaurus-page')) {
    return 'docusaurus';
  }
  if (html.includes('md-content')) {
    return 'mkdocs';
  }
  if (html.includes('class="document"') || html.includes("class='document'") ||
      (html.includes('class="body"') && html.includes('highlight'))) {
    return 'sphinx';
  }
  if (html.includes('page-body')) {
    return 'gitbook';
  }
  return null;
}

function extractWithSelectors(
  document: Document,
  contentSelectors: string[],
): Element | null {
  for (const selector of contentSelectors) {
    const el = document.querySelector(selector);
    if (el) return el as Element;
  }
  return null;
}

function stripElements(root: Element, selectors: string[]): void {
  for (const selector of selectors) {
    for (const el of Array.from(root.querySelectorAll(selector))) {
      el.parentNode?.removeChild(el);
    }
  }
}

function buildResult(
  document: Document,
  contentEl: Element,
): ExtractionResult | null {
  stripElements(contentEl, STRIP_SELECTORS);

  const titleEl =
    contentEl.querySelector('h1') ??
    document.querySelector('h1') ??
    document.querySelector('title');

  const rawTitle = titleEl?.textContent?.trim() ?? '';
  const title = rawTitle.includes('|')
    ? rawTitle.split('|')[0]!.trim()
    : rawTitle;

  if (!title) return null;

  const markdown = turndown.turndown(contentEl.innerHTML).trim();
  if (!markdown) return null;

  return {
    title,
    markdown,
    metadata: {},
    links: [],
    images: [],
    extractor: 'site-specific',
  };
}

export const docsGenericExtractor: Extractor = {
  name: 'docs-generic',

  canHandle(_url: string, html?: string): boolean {
    if (!html) return false;
    return detectFramework(html) !== null;
  },

  extract(html: string, _url: string): ExtractionResult | null {
    if (!html) return null;

    const framework = detectFramework(html);
    if (!framework) return null;

    const { document } = parseHTML(html);

    let contentSelectors: string[];
    switch (framework) {
      case 'docusaurus':
        contentSelectors = ['.markdown', 'article', 'main'];
        break;
      case 'mkdocs':
        contentSelectors = ['.md-content'];
        break;
      case 'sphinx':
        contentSelectors = ['.document', '.body'];
        break;
      case 'gitbook':
        contentSelectors = ['.page-body'];
        break;
    }

    const contentEl = extractWithSelectors(document, contentSelectors);
    if (!contentEl) return null;

    return buildResult(document, contentEl);
  },
};
