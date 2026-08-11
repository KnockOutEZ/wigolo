import type { FindSimilarInput } from '../../types.js';

export type FindSimilarMode = 'auto' | 'cache' | 'web-expansion' | 'crawl-rank';

// Dispatcher only branches on 'crawl-rank' today. 'cache' / 'web-expansion' /
// 'auto' all fall through to the legacy hybrid flow in find-similar.ts so
// existing callers keep their behavior. Crawl-rank requires an explicit
// opt-in and a seed URL — concept-only inputs have nothing to crawl from.
export function selectMode(input: FindSimilarInput): FindSimilarMode {
  if (input.mode === 'crawl-rank') {
    if (!input.url || input.url.trim().length === 0) return 'cache';
    // crawl-rank builds its ENTIRE rank list from a live 1-hop crawl, so
    // `include_web: false` has to bind the dispatcher and not just the
    // web-search fallback downstream. The studio DB broker forces
    // include_web: false on every proxied find_similar to keep a session on
    // local state; a caller-supplied mode: 'crawl-rank' walked past that and
    // fetched from the network anyway. Downgrade to the local lane rather than
    // refusing: the cache lane is a legitimate answer, an error is not.
    if (input.include_web === false) return 'cache';
    return 'crawl-rank';
  }
  if (input.mode === 'cache' || input.mode === 'web-expansion') return input.mode;
  return 'cache';
}
