// Lexical alignment between a query and a result's (title + snippet).
//
// Returns the fraction of non-stopword query tokens that appear in the
// result's title or snippet token set. 0..1. Used by the core ranker to
// damp results whose surface text has near-zero overlap with the query.

import { SEARCH_STOPWORDS, tokenizeContent } from './text-normalization.js';

// Kept as a local alias for compatibility/readability in this module; the
// canonical stopword set is shared with rare-term phrase matching.
void SEARCH_STOPWORDS;

function tokenize(s: string): string[] {
  return tokenizeContent(s);
}

/**
 * Fraction of unique non-stopword query tokens that appear in (title + snippet).
 * Range: [0, 1].
 */
export function lexicalAlignment(query: string, title: string, snippet: string): number {
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;

  const docTokens = new Set<string>();
  for (const t of tokenize(title)) docTokens.add(t);
  for (const t of tokenize(snippet)) docTokens.add(t);
  if (docTokens.size === 0) return 0;

  let overlap = 0;
  for (const t of qTokens) {
    if (docTokens.has(t)) overlap++;
  }
  return overlap / qTokens.size;
}
