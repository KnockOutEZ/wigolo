import { Defuddle } from 'defuddle/node';
import type { ExtractionResult } from '../types.js';
import { htmlToMarkdown } from './markdown.js';

const MIN_CONTENT_THRESHOLD = 100;

// The bundled content extractor ships "async extractors" that issue their OWN
// outbound requests from inside the parse — below wigolo's fetch layer, on the
// bare global fetch. They therefore ignore the user's configured proxy, ignore
// wigolo's timeouts and headers, and never appear in any wigolo log. One of the
// known destinations is an unaffiliated third-party API that receives the
// user's complete requested URL.
//
// `useAsync: false` is the library's own supported switch for that whole class
// (documented as "allow async extractors to fetch content from third-party
// APIs"). It is deliberately set on the ONE wigolo call site so the guarantee
// holds for every async extractor the library ships today AND any it adds in a
// future release — never a per-destination denylist, which would go stale on
// the next upgrade. Extraction stays purely a function of HTML wigolo already
// fetched.
const NO_THIRD_PARTY_EGRESS = { useAsync: false } as const;

export async function defuddleExtract(html: string, url: string): Promise<ExtractionResult | null> {
  try {
    const result = await Defuddle(html, url, NO_THIRD_PARTY_EGRESS);
    if (!result.content) return null;
    const markdown = htmlToMarkdown(result.content);
    if (markdown.length < MIN_CONTENT_THRESHOLD) return null;
    return {
      title: result.title ?? '',
      markdown,
      metadata: {
        description: result.description || undefined,
        author: result.author || undefined,
        date: result.published || undefined,
        language: result.language || undefined,
      },
      links: [],
      images: [],
      extractor: 'defuddle',
    };
  } catch {
    return null;
  }
}
