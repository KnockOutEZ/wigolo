import {
  extractSection,
  extractLinksAndImages,
  filterDecorativeImages,
  resolveRelativeUrls,
} from './markdown.js';
import { extractMetadata } from './extract.js';
import { stripBoilerplateMarkdown } from './boilerplate.js';
import { sanitizeExtractedMarkdown } from './markdown-sanitize.js';
import type { ExtractionResult, Extractor } from '../types.js';
import { registerSiteExtractor } from './v1/site-extractors.js';
import { getExtractProvider } from '../providers/extract-provider.js';

export interface ExtractionOptions {
  maxChars?: number;
  section?: string;
  sectionIndex?: number;
  contentType?: string;
  pdfBuffer?: Buffer;
}

// Plugin entry point — back-compat alias. `src/server.ts` imports
// `registerExtractor` from here. The registry lives in v1/site-extractors.ts
// so both the facade and the v1 router see the same plugin-registered extractors.
export function registerExtractor(extractor: Extractor): void {
  registerSiteExtractor(extractor);
}

/**
 * @deprecated Use `getExtractProvider().extract(...)` from
 * `src/providers/extract-provider.ts`. This facade remains for backwards
 * compatibility with existing test mocks and benchmark runners that import
 * `extractContent` directly. Will be removed after the test-mock migration.
 */
export async function extractContent(
  html: string,
  url: string,
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const provider = await getExtractProvider();
  return provider.extract(html, url, options);
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
