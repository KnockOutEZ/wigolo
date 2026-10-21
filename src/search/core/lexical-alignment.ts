// Lexical alignment between a query and a result's (title + snippet).
//
// Returns the fraction of non-stopword query tokens that appear in the
// result's title or snippet token set. 0..1. Used by the core ranker to
// damp results whose surface text has near-zero overlap with the query
// (typical brand-collision pattern: query about a technology, result is
// a retail homepage with no technical tokens).

import { tokenizeRankingText } from './text-tokenizer.js';

const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an',
  'what', 'is', 'are', 'was', 'were', 'how', 'why', 'when', 'where', 'who',
  'do', 'does', 'did',
  'for', 'of', 'to', 'in', 'on', 'with', 'and', 'or', 'but', 'as', 'at',
  'by', 'from', 'into', 'about', 'than',
  'this', 'that', 'these', 'those', 'it', 'its',
  'be', 'been', 'has', 'have', 'had',
  'can', 'could', 'should', 'would', 'may', 'might', 'must',
  'will', 'shall',
  'i', 'you', 'we', 'they', 'he', 'she', 'them',
  'my', 'your', 'our', 'their',
  'latest', 'current', 'newest', 'recent', 'best', 'top', 'most',
]);

function tokenize(s: string): string[] {
  return tokenizeRankingText(s).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
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
