import { parseHTML } from 'linkedom';
import type { ExtractionResult } from '../../types.js';
import { defuddleExtract } from '../defuddle.js';
import { readabilityExtract } from '../readability.js';
import { htmlToMarkdown } from '../markdown.js';
import { stripBoilerplateDom } from '../boilerplate.js';
import { createLogger } from '../../logger.js';
import { classifyContent, type ContentType } from './classifier.js';
import { extractRecipe } from './recipe.js';
import { extractProduct } from './product.js';
import { extractNews } from './news.js';
import { getSiteExtractors } from './site-extractors.js';

const log = createLogger('extract');

export interface RoutedExtractInput {
  html: string;
  url: string;
  cleanedHtml?: string;
  contentType?: string;
}

/**
 * V1 routed extractor — picks a category-specific extractor based on the
 * classifier output, with defuddle → readability → turndown fallbacks. Site
 * extractors (github/stackoverflow/mdn/docs-generic + plugins) run first and
 * short-circuit on match, matching legacy behavior.
 *
 * PDF handling lives in V1Extractor — this router assumes HTML.
 */
export async function routedExtract(input: RoutedExtractInput): Promise<ExtractionResult> {
  const { html, url } = input;
  const cleanedHtml = input.cleanedHtml ?? cleanHtml(html, url);

  const siteHit = trySiteExtractors(cleanedHtml, url, html);
  if (siteHit) return siteHit;

  const type = classifyContent(url, html);
  log.debug('classified content', { url, type });

  switch (type) {
    case 'recipe':
      return (
        (await extractRecipe(cleanedHtml, url)) ?? (await fallbackChain(cleanedHtml, url))
      );
    case 'product':
      return (
        (await extractProduct(cleanedHtml, url)) ?? (await fallbackChain(cleanedHtml, url))
      );
    case 'news':
      return (await extractNews(cleanedHtml, url)) ?? (await fallbackChain(cleanedHtml, url));
    case 'code':
    case 'docs':
    case 'generic':
    default:
      return fallbackChain(cleanedHtml, url, type);
  }
}

function cleanHtml(html: string, url: string): string {
  try {
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    return document.toString();
  } catch (err) {
    log.warn('boilerplate DOM pre-pass failed', { url, error: String(err) });
    return html;
  }
}

function trySiteExtractors(
  cleanedHtml: string,
  url: string,
  originalHtml: string,
): ExtractionResult | null {
  const extractors = getSiteExtractors();
  const match = extractors.find((e) => e.canHandle(url, originalHtml));
  if (!match) return null;
  const out = match.extract(cleanedHtml, url);
  return out ?? null;
}

async function fallbackChain(
  cleanedHtml: string,
  url: string,
  _type?: ContentType,
): Promise<ExtractionResult> {
  const fromDefuddle = await defuddleExtract(cleanedHtml, url);
  if (fromDefuddle) return fromDefuddle;

  const fromReadability = readabilityExtract(cleanedHtml, url);
  if (fromReadability) return fromReadability;

  return {
    title: '',
    markdown: htmlToMarkdown(cleanedHtml),
    metadata: {},
    links: [],
    images: [],
    extractor: 'turndown',
  };
}
