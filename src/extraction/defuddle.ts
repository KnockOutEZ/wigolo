import { Defuddle } from 'defuddle/node';
import type { ExtractionResult } from '../types.js';

const MIN_CONTENT_THRESHOLD = 100;

export async function defuddleExtract(html: string, url: string): Promise<ExtractionResult | null> {
  try {
    const result = await Defuddle(html, url, { markdown: true });
    if (!result.content || result.content.length < MIN_CONTENT_THRESHOLD) return null;
    return {
      title: result.title ?? '',
      markdown: result.content,
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
