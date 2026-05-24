import { parseHTML } from 'linkedom';
import { htmlToMarkdown } from '../markdown.js';
import type { Extractor, ExtractionResult } from '../../types.js';

const STRIP_SELECTORS = [
  'nav',
  'aside',
  '.sidebar',
  '.sidebar-container',
  '[class*="sidebar"]',
  '[id*="sidebar"]',
  'header',
  'footer',
  '.bc-head',
  '.metadata',
  '.breadcrumbs-container',
  '.toc',
  '.document-toc',
  'nav.toc',
];

export const mdnExtractor: Extractor = {
  name: 'mdn',

  canHandle(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return hostname === 'developer.mozilla.org';
    } catch {
      return false;
    }
  },

  extract(html: string, _url: string): ExtractionResult | null {
    if (!html) return null;

    const { document } = parseHTML(html);

    const article =
      document.querySelector('article.main-page-content') ??
      document.querySelector('main#content article') ??
      document.querySelector('main#content') ??
      document.querySelector('.section-content') ??
      document.querySelector('[role="main"] article') ??
      document.querySelector('article');

    if (!article) return null;

    for (const selector of STRIP_SELECTORS) {
      for (const el of Array.from(article.querySelectorAll(selector))) {
        el.parentNode?.removeChild(el);
      }
    }

    // Title chain: article h1, og:title meta, document.title with the "| MDN"
    // suffix stripped. The bench saw empty titles when the article block had
    // no h1 (modern MDN renders the h1 inside main but outside the
    // main-page-content wrapper for some doc types).
    const articleH1 = article.querySelector('h1')?.textContent?.trim();
    const mainH1 = document.querySelector('main h1')?.textContent?.trim();
    const ogTitleEl = document.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
    const ogTitle = ogTitleEl?.getAttribute('content')?.trim();
    const docTitle = document.querySelector('title')?.textContent?.trim();

    const candidateRaw = articleH1 || mainH1 || ogTitle || docTitle || '';
    const title = candidateRaw.includes('|')
      ? candidateRaw.split('|')[0]!.trim()
      : candidateRaw;

    if (!title) return null;

    const markdown = htmlToMarkdown((article as Element).innerHTML).trim();
    if (!markdown) return null;

    return {
      title,
      markdown,
      metadata: {},
      links: [],
      images: [],
      extractor: 'site-specific',
    };
  },
};
