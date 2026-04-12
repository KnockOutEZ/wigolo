import { defuddleExtract } from './defuddle.js';
import { readabilityExtract } from './readability.js';
import { trafilaturaExtract, isTrafilaturaAvailable } from './trafilatura.js';
import { htmlToMarkdown, extractSection, extractLinksAndImages } from './markdown.js';
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
    return applyPostProcessing(result, options);
  }

  const siteExtractor = siteExtractors.find((e) => e.canHandle(url, html));
  if (siteExtractor) {
    const extracted = siteExtractor.extract(html, url);
    if (extracted) {
      result = extracted;
      return applyPostProcessing(result, options);
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
          return applyPostProcessing(result, options);
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
