import type {
  ExtractProvider,
  ExtractProviderOptions,
} from '../providers/extract-provider.js';
import type { ExtractionResult } from '../types.js';
import { extractContent } from './pipeline.js';

/**
 * Legacy extraction adapter — wraps the existing ensemble pipeline. Pure
 * pass-through: `ExtractProviderOptions` is structurally identical to the
 * pipeline's `ExtractionOptions`, so no conversion is needed beyond
 * delegation. Behavior is unchanged.
 */
export class LegacyExtractProvider implements ExtractProvider {
  async extract(
    html: string,
    url: string,
    options: ExtractProviderOptions = {},
  ): Promise<ExtractionResult> {
    return extractContent(html, url, options);
  }
}
