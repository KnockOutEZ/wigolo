import { parseHTML } from 'linkedom';
import type { ExtractionResult } from '../../types.js';
import { defuddleExtract } from '../defuddle.js';
import { readabilityExtract } from '../readability.js';
import { htmlToMarkdown } from '../markdown.js';
import { stripBoilerplateDom } from '../boilerplate.js';
import { stripHiddenDom } from '../visibility.js';
import { createLogger } from '../../logger.js';
import { classifyContent, type ContentType } from './classifier.js';
import { isolateContentRoot } from './content-root.js';
import { narrowToGrid } from '../div-grid.js';
import { extractRecipe } from './recipe.js';
import { extractProduct } from './product.js';
import { extractNews } from './news.js';
import { getSiteExtractors } from './site-extractors.js';
import { assessListTitleAttrition } from '../completeness.js';
import { xExtractor } from '../site-extractors/x.js';
import { detectAntiBotBlock as detectRedditBlock } from '../site-extractors/reddit.js';
import { detectAntiBotBlock as detectAmazonBlock } from '../site-extractors/amazon.js';

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

  // When no site extractor matched, the URL might still belong
  // to a site we know — Reddit / Amazon — and the body might be an anti-bot
  // challenge or "page not found" landing. Detect that case so the caller
  // sees an honest `fetch_failed="blocked"` instead of silent fake success.
  const blocked = detectSiteBlock(url, html);

  const type = classifyContent(url, html);
  log.debug('classified content', { url, type, blocked });

  // Narrow app-shell/SPA pages to their main-content region before the
  // category extractors serialize, so a small max_content_chars cap returns
  // body content instead of leading nav chrome. Inert on clean pages and
  // unrendered shells (two-factor guard). Classification above stays on the
  // full html so type detection is unaffected.
  const rooted = isolateContentRoot(cleanedHtml);

  // Then narrow div/flex pricing grids to the card region by sibling-removal
  // so markdown extraction of a table-less pricing page returns the tiers
  // instead of surrounding chrome. Inert on non-grid pages (two-factor guard).
  const scoped = narrowToGrid(rooted);

  const result = await (async () => {
    switch (type) {
      case 'recipe':
        return (
          (await extractRecipe(scoped, url)) ?? (await fallbackChain(scoped, url))
        );
      case 'product':
        return (
          (await extractProduct(scoped, url)) ?? (await fallbackChain(scoped, url))
        );
      case 'news':
        return (await extractNews(scoped, url)) ?? (await fallbackChain(scoped, url));
      case 'code':
      case 'docs':
      case 'generic':
      default:
        return fallbackChain(scoped, url, type);
    }
  })();

  if (blocked) {
    result.site_data_blocked = blocked;
  }

  // Structural completeness is judged against `scoped` — the exact HTML the
  // extractor was handed — so the verdict is a true input/output differential
  // and never blames the extractor for content the pre-passes had already
  // removed. Site-extractor hits returned above are deliberately exempt: they
  // reshape a page into a per-site record on purpose, so markdown attrition
  // there is intent, not loss.
  const completeness = assessListTitleAttrition(scoped, result.markdown);
  if (completeness) {
    result.contentCompleteness = completeness;
  }

  return result;
}

// URL-scoped block detection. Only fires for hosts where we
// have a site extractor and a known anti-bot body shape — Reddit / Amazon.
// A generic block body on an unrelated host is not our problem here; that
// case is covered by the fetch tier's http_status / router escalation.
function detectSiteBlock(url: string, html: string): string | null {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }

  if (host === 'reddit.com' || host === 'redd.it' ||
      host.endsWith('.reddit.com') || host.endsWith('.redd.it')) {
    return detectRedditBlock(html);
  }

  if (host.includes('amazon.') || host === 'amzn.to' || host === 'a.co' ||
      host.endsWith('.amzn.to') || host.endsWith('.a.co')) {
    return detectAmazonBlock(html);
  }

  return null;
}

function cleanHtml(html: string, url: string): string {
  try {
    const { document } = parseHTML(html);
    // Visibility first, boilerplate second. Hidden chrome is dropped before any
    // extractor sees it, so suppression no longer depends on which tier wins the
    // route — the divergence that let GitHub's session banner leak on a JS shell
    // while the same markup was suppressed on the site's repo pages.
    stripHiddenDom(document);
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
  // X post permalinks are handled by a built-in extractor that runs ahead of
  // the shared registry. It reads X's own card metadata out of the response
  // wigolo already holds, so a post page is served without the third-party API
  // calls the bundled content extractor would otherwise make for it.
  const extractors = [xExtractor, ...getSiteExtractors()];
  const match = extractors.find((e) => e.canHandle(url, originalHtml));
  if (!match) return null;
  // Site extractors that emit a structured record populate `site_data`
  // directly on the ExtractionResult (see reddit / amazon / youtube). The
  // structured shape is built once, inside the extractor's single HTML
  // parse — no re-parse, no helper re-call here.
  return match.extract(cleanedHtml, url);
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
