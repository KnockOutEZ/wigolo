import { parseHTML } from 'linkedom';
import { defuddleExtract } from './defuddle.js';
import { readabilityExtract } from './readability.js';
import { trafilaturaExtract, isTrafilaturaAvailable } from './trafilatura.js';
import {
  htmlToMarkdown,
  extractSection,
  extractLinksAndImages,
  filterDecorativeImages,
  resolveRelativeUrls,
} from './markdown.js';
import { extractMetadata } from './extract.js';
import { stripBoilerplateDom, stripBoilerplateMarkdown } from './boilerplate.js';
import { sanitizeExtractedMarkdown } from './markdown-sanitize.js';
import type { ExtractionResult, Extractor } from '../types.js';
import {
  getSiteExtractors,
  registerSiteExtractor,
} from './v1/site-extractors.js';
import { createLogger } from '../logger.js';
import { getConfig } from '../config.js';

const log = createLogger('extract');

export interface ExtractionOptions {
  maxChars?: number;
  section?: string;
  sectionIndex?: number;
  contentType?: string;
  pdfBuffer?: Buffer;
}

// Plugin entry point — back-compat alias. `src/server.ts` imports
// `registerExtractor` from here. The registry lives in v1/site-extractors.ts
// so both pipelines see the same plugin-registered extractors.
export function registerExtractor(extractor: Extractor): void {
  registerSiteExtractor(extractor);
}

export async function extractContent(
  html: string,
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  let result: ExtractionResult | null = null;

  if (options.contentType === 'application/pdf') {
    let pdfText = '';
    if (options.pdfBuffer) {
      try {
        const pdfParse = (await import('pdf-parse')).default;
        const parsed = await pdfParse(options.pdfBuffer);
        pdfText = parsed.text ?? '';
      } catch (err) {
        log.warn('pdf-parse failed', { url, error: String(err) });
      }
    }
    result = {
      title: '',
      markdown: pdfText,
      metadata: {},
      links: [],
      images: [],
      extractor: 'turndown',
    };
    return applyPostProcessing(result, url, html, options);
  }

  let cleanedHtml = html;
  try {
    const { document } = parseHTML(html);
    stripBoilerplateDom(document);
    cleanedHtml = document.toString();
  } catch (err) {
    log.warn('boilerplate DOM pre-pass failed', { url, error: String(err) });
  }

  const siteExtractor = getSiteExtractors().find((e) => e.canHandle(url, html));
  if (siteExtractor) {
    const extracted = siteExtractor.extract(cleanedHtml, url);
    if (extracted) {
      result = extracted;
      return applyPostProcessing(result, url, html, options);
    }
  }

  result = await defuddleExtract(cleanedHtml, url);

  if (!result) {
    const config = getConfig();
    if (config.trafilatura !== 'never') {
      const trafAvailable = await isTrafilaturaAvailable();
      if (trafAvailable) {
        result = await trafilaturaExtract(cleanedHtml, url);
        if (result) {
          log.info('Trafilatura extraction succeeded', { url, chars: result.markdown.length });
          return applyPostProcessing(result, url, html, options);
        }
      }
    }
  }

  if (!result) {
    result = readabilityExtract(cleanedHtml, url);
  }

  if (!result) {
    const markdown = htmlToMarkdown(cleanedHtml);
    result = {
      title: '',
      markdown,
      metadata: {},
      links: [],
      images: [],
      extractor: 'turndown',
    };
  }

  return applyPostProcessing(result, url, html, options);
}

export function mergeMetadata(
  base: ExtractionResult['metadata'],
  html: string,
): ExtractionResult['metadata'] {
  try {
    const meta = extractMetadata(html);
    return {
      ...meta,
      // Extractor-provided fields win when set (they already inspected the article body).
      description: base.description || meta.description,
      author: base.author || meta.author,
      date: base.date || meta.date,
      language: base.language,
      og_image: base.og_image ?? meta.og_image,
      og_type: base.og_type ?? meta.og_type,
      canonical_url: base.canonical_url ?? meta.canonical_url,
      keywords: base.keywords ?? meta.keywords,
    };
  } catch {
    return base;
  }
}

export function applyPostProcessing(
  result: ExtractionResult,
  url: string,
  html: string,
  options: ExtractionOptions,
): ExtractionResult {
  let markdown = result.markdown;

  // Resolve relative links/images before slicing so downstream consumers get absolute URLs.
  markdown = resolveRelativeUrls(markdown, url);
  markdown = stripBoilerplateMarkdown(markdown);
  markdown = filterDecorativeImages(markdown);
  markdown = sanitizeExtractedMarkdown(markdown);

  if (options.section) {
    const { content } = extractSection(markdown, options.section, options.sectionIndex ?? 0);
    markdown = content;
  }

  const { links, images } = extractLinksAndImages(markdown);
  const metadata = mergeMetadata(result.metadata, html);

  if (options.maxChars && markdown.length > options.maxChars) {
    markdown = markdown.slice(0, options.maxChars);
  }

  return { ...result, markdown, links, images, metadata };
}
