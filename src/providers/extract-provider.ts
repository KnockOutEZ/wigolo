/**
 * Extract provider interface — Phase 1 Task 1.3 of v1 engine overhaul.
 *
 * Wraps the existing ensemble pipeline (Defuddle → Trafilatura → Readability
 * + site extractors) behind a stable interface. The factory always returns
 * the legacy adapter today; Phase 5 swaps in the v1 implementation.
 *
 * Note: named ExtractProvider (not Extractor) to avoid collision with the
 * pre-existing `Extractor` interface in `src/types.ts`, which models a single
 * site-specific extractor within the ensemble pipeline.
 */
import type { ExtractionResult } from '../types.js';

export interface ExtractProviderOptions {
  maxChars?: number;
  section?: string;
  sectionIndex?: number;
  contentType?: string;
  pdfBuffer?: Buffer;
}

export interface ExtractProvider {
  extract(
    html: string,
    url: string,
    options?: ExtractProviderOptions,
  ): Promise<ExtractionResult>;
}

let cached: Promise<ExtractProvider> | null = null;

export function getExtractor(): Promise<ExtractProvider> {
  if (cached) return cached;
  cached = import('../extraction/legacy-provider.js').then(
    m => new m.LegacyExtractProvider(),
    err => { cached = null; throw err; },
  );
  return cached;
}

export function _resetExtractorForTest(): void {
  cached = null;
}
