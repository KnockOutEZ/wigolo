import { parseHTML } from 'linkedom';
import type { ExtractionResult, Extractor } from '../../types.js';
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
import { extractRedditThread } from '../site-extractors/reddit.js';
import { extractAmazonProduct } from '../site-extractors/amazon.js';

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
  if (!out) return null;
  const siteData = buildSiteData(match, out, originalHtml, url);
  if (siteData) return { ...out, site_data: siteData };
  return out;
}

/**
 * Build the per-site structured `site_data` JSON for site-extractor matches.
 *
 * Reddit and Amazon extractors keep their structured shape internal — only the
 * markdown-rendered ExtractionResult crosses the boundary. We re-call the
 * exported parse helpers here to recover the structured record. YouTube emits
 * its structured fields into the extractor's `metadata` slot as untyped extras
 * (see youtube.ts); `applyPostProcessing` later drops anything outside the
 * typed ExtractionResult.metadata shape, so we snapshot them here before the
 * loss. Any other site extractor returns no `site_data` — the field is
 * intentionally additive and absent on plain pages.
 */
function buildSiteData(
  match: Extractor,
  out: ExtractionResult,
  originalHtml: string,
  url: string,
): Record<string, unknown> | null {
  try {
    switch (match.name) {
      case 'reddit': {
        const thread = extractRedditThread(originalHtml, url);
        return thread ? (thread as unknown as Record<string, unknown>) : null;
      }
      case 'amazon': {
        const product = extractAmazonProduct(originalHtml, url);
        return product ? (product as unknown as Record<string, unknown>) : null;
      }
      case 'youtube': {
        // YouTube's structured fields live on the ExtractionResult.metadata
        // slot as untyped extras (see src/extraction/site-extractors/youtube.ts).
        // Pull them out before applyPostProcessing strips anything not in the
        // typed metadata shape.
        const m = out.metadata as Record<string, unknown>;
        const keys = [
          'video_id',
          'channel',
          'duration',
          'duration_seconds',
          'view_count',
          'posted_at',
          'chapters',
          'caption_tracks',
          'transcript',
          'playability_status',
        ];
        const site: Record<string, unknown> = {};
        for (const k of keys) {
          if (k in m) site[k] = m[k];
        }
        // Title travels on the top-level ExtractionResult — surface it on
        // site_data too so callers don't have to peek at two fields.
        if (out.title) site.title = out.title;
        return Object.keys(site).length > 0 ? site : null;
      }
      default:
        return null;
    }
  } catch (err) {
    log.warn('site_data build failed', { url, name: match.name, error: String(err) });
    return null;
  }
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
