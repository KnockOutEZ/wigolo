import { defuddleExtract } from './defuddle.js';
import { readabilityExtract } from './readability.js';
import { htmlToMarkdown, extractSection, extractLinksAndImages } from './markdown.js';
import type { ExtractionResult, Extractor } from '../types.js';

export interface ExtractionOptions {
  maxChars?: number;
  section?: string;
  sectionIndex?: number;
  contentType?: string;
}

const siteExtractors: Extractor[] = [];

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
    result = {
      title: '',
      markdown: '',
      metadata: {},
      links: [],
      images: [],
      extractor: 'turndown',
    };
    return applyPostProcessing(result, options);
  }

  const siteExtractor = siteExtractors.find((e) => e.canHandle(url));
  if (siteExtractor) {
    const extracted = siteExtractor.extract(html, url);
    if (extracted) {
      result = extracted;
      return applyPostProcessing(result, options);
    }
  }

  result = await defuddleExtract(html, url);

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

  return applyPostProcessing(result, options);
}

function applyPostProcessing(
  result: ExtractionResult,
  options: ExtractionOptions,
): ExtractionResult {
  let markdown = result.markdown;

  if (options.section) {
    const { content } = extractSection(markdown, options.section, options.sectionIndex ?? 0);
    markdown = content;
  }

  const { links, images } = extractLinksAndImages(markdown);

  if (options.maxChars && markdown.length > options.maxChars) {
    markdown = markdown.slice(0, options.maxChars);
  }

  return { ...result, markdown, links, images };
}
