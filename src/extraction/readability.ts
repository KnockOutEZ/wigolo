import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { ExtractionResult } from '../types.js';

const MIN_CONTENT_THRESHOLD = 100;

export function readabilityExtract(html: string, _url: string): ExtractionResult | null {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as any);
    const article = reader.parse();
    if (!article || !article.content) return null;

    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const markdown = turndown.turndown(article.content);

    if (markdown.length < MIN_CONTENT_THRESHOLD) return null;

    return {
      title: article.title ?? '',
      markdown,
      metadata: {
        author: article.byline || undefined,
        language: article.lang || undefined,
      },
      links: [],
      images: [],
      extractor: 'readability',
    };
  } catch {
    return null;
  }
}
