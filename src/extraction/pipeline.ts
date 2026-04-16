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
import type { ExtractionResult, Extractor } from '../types.js';
import { githubExtractor } from './site-extractors/github.js';
import { stackoverflowExtractor } from './site-extractors/stackoverflow.js';
import { mdnExtractor } from './site-extractors/mdn.js';
import { docsGenericExtractor } from './site-extractors/docs-generic.js';
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

const siteExtractors: Extractor[] = [
  githubExtractor,
  stackoverflowExtractor,
  mdnExtractor,
  docsGenericExtractor,
];

export function registerExtractor(extractor: Extractor): void {
  siteExtractors.push(extractor);
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

  const siteExtractor = siteExtractors.find((e) => e.canHandle(url, html));
  if (siteExtractor) {
    const extracted = siteExtractor.extract(html, url);
    if (extracted) {
      result = extracted;
      return applyPostProcessing(result, url, html, options);
    }
  }

  result = await defuddleExtract(html, url);

  if (!result) {
    const config = getConfig();
    if (config.trafilatura !== 'never') {
      const trafAvailable = await isTrafilaturaAvailable();
      if (trafAvailable) {
        result = await trafilaturaExtract(html, url);
        if (result) {
          log.info('Trafilatura extraction succeeded', { url, chars: result.markdown.length });
          return applyPostProcessing(result, url, html, options);
        }
      }
    }
  }

  if (!result) {
    result = readabilityExtract(html, url);
  }

  if (!result) {
    const markdown = htmlToMarkdown(html);
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

function mergeMetadata(
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

function applyPostProcessing(
  result: ExtractionResult,
  url: string,
  html: string,
  options: ExtractionOptions,
): ExtractionResult {
  let markdown = result.markdown;

  // Resolve relative links/images before slicing so downstream consumers get absolute URLs.
  markdown = resolveRelativeUrls(markdown, url);
  markdown = filterDecorativeImages(markdown);

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
