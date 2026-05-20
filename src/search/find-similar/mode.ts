import type { FindSimilarInput } from '../../types.js';

export type FindSimilarMode = 'auto' | 'cache' | 'web-expansion' | 'crawl-rank';

// Dispatcher only branches on 'crawl-rank' today. 'cache' / 'web-expansion' /
// 'auto' all fall through to the legacy hybrid flow in find-similar.ts so
// existing callers keep their behavior. Crawl-rank requires an explicit
// opt-in and a seed URL — concept-only inputs have nothing to crawl from.
export function selectMode(input: FindSimilarInput): FindSimilarMode {
  if (input.mode === 'crawl-rank') {
    if (input.url && input.url.trim().length > 0) return 'crawl-rank';
    return 'cache';
  }
  if (input.mode === 'cache' || input.mode === 'web-expansion') return input.mode;
  return 'cache';
}
