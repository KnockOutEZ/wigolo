import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { Extractor, ExtractionResult } from '../../types.js';

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });

const STRIP_SELECTORS = [
  'nav',
  '.sidebar',
  'header',
  'footer',
  '.bc-head',
  '.metadata',
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
      document.querySelector('.section-content') ??
      document.querySelector('article');

    if (!article) return null;

    for (const selector of STRIP_SELECTORS) {
      for (const el of Array.from(article.querySelectorAll(selector))) {
        el.parentNode?.removeChild(el);
      }
    }

    const titleEl =
      article.querySelector('h1') ??
      document.querySelector('title');

    const rawTitle = titleEl?.textContent?.trim() ?? '';
    const title = rawTitle.includes('|')
      ? rawTitle.split('|')[0]!.trim()
      : rawTitle;

    if (!title) return null;

    const markdown = turndown.turndown((article as Element).innerHTML).trim();
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
