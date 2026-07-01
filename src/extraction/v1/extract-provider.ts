import type {
  ExtractProvider,
  ExtractProviderOptions,
} from '../../providers/extract-provider.js';
import type { ExtractionResult } from '../../types.js';
import { routedExtract } from './routed.js';
import { applyPostProcessing } from '../pipeline.js';
import { createLogger } from '../../logger.js';

const log = createLogger('extract');

/**
 * V1 extract provider — wires the classifier + category extractors via the
 * routed pipeline, then applies the legacy post-processing (URL resolution,
 * boilerplate stripping, sanitization, section selection, link/image
 * extraction, metadata merging, max_chars truncation) to preserve output
 * parity with the legacy provider.
 *
 * PDF handling is kept inline (small enough) and matches legacy semantics.
 */
export class V1Extractor implements ExtractProvider {
  readonly name = 'v1' as const;

  async extract(
    html: string,
    url: string,
    options: ExtractProviderOptions = {},
  ): Promise<ExtractionResult> {
    if (options.contentType === 'application/pdf') {
      const pdf = await handlePdf(html, url, options);
      return applyPostProcessing(pdf, url, html, options);
    }

    const base = await routedExtract({
      html,
      url,
      contentType: options.contentType,
    });

    return applyPostProcessing(base, url, html, options);
  }
}

async function handlePdf(
  _html: string,
  url: string,
  options: ExtractProviderOptions,
): Promise<ExtractionResult> {
  // arxiv / generic PDF fetch returned an empty body
  // because the code called `(await import('pdf-parse')).default(...)`,
  // which throws "pdfParse is not a function" against pdf-parse@2.x.
  // The v2 API exposes a `PDFParse` class with `.getText({})`. Wire the
  // class form so arxiv (and every other PDF source) returns the actual
  // extracted text.
  let pdfText = '';
  if (options.pdfBuffer) {
    try {
      const mod = await import('pdf-parse');
      const Ctor = mod.PDFParse;
      const parser = new Ctor({ data: options.pdfBuffer });
      const parsed = await parser.getText({});
      pdfText = parsed.text ?? '';
    } catch (err) {
      log.warn('pdf-parse failed', { url, error: String(err) });
    }
  }
  return {
    title: '',
    markdown: pdfText,
    metadata: {},
    links: [],
    images: [],
    extractor: 'turndown',
  };
}
