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

// Arabic function words. They carry no entity signal, so they must not
// dilute the alignment ratio — and a query made only of them has nothing to
// align against. The list is written in the FOLDED form the tokenizer emits
// (alef-maksura -> ya, ta-marbuta -> ha), so it matches the tokens.
const ARABIC_STOPWORDS: ReadonlySet<string> = new Set([
  'من', 'في', 'عن', 'علي', 'مع', 'الي', 'هذا', 'هذه', 'ذلك', 'التي', 'الذي',
  'الذين', 'اللذان', 'اللاتي', 'ما', 'ماذا', 'كيف', 'متي', 'اين', 'لماذا', 'هل',
  'او', 'و', 'ثم', 'قد', 'كان', 'كانت', 'يكون', 'تكون', 'كل', 'بعض', 'بين',
  'بعد', 'قبل', 'حتي', 'عند', 'لدي', 'نحو', 'حيث', 'ايضا', 'هو', 'هي', 'هم',
  'نحن', 'انا',
]);

function tokenize(s: string): string[] {
  return tokenizeRankingText(s).filter(
    (t) => t.length >= 2 && !STOPWORDS.has(t) && !ARABIC_STOPWORDS.has(t),
  );
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

/**
 * True when the query carries at least one content token — a token a result
 * could legitimately match. A query made only of stopwords has nothing to
 * align against, so every alignment-based gate must stay open for it.
 */
export function hasContentTokens(query: string): boolean {
  return tokenize(query).length > 0;
}
