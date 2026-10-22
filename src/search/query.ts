import { cleanQueryForSearch, isArabicQuery } from './arabic/query-cleaner.js';

const MAX_QUERY_LENGTH = 200;
const CLAUSE_SEPARATORS = ['. ', '? ', '! ', '; ', ', and ', ', or ', ' - ', ' — '];

/**
 * Preprocess a user query before it is sent to the search engines.
 *
 * For Arabic queries this strips the leading question scaffolding
 * ("من هو", "حدثني عن", ...), the trailing scaffolding ("وماذا تعرف
 * عنها؟", ...) and common Arabic function words. The cleaned string is
 * what gets sent to the engines; the ORIGINAL wording is kept for display
 * and for downstream consumers that need the question as typed.
 *
 * For non-Arabic queries this is a no-op pass-through.
 *
 * Examples:
 *   "من هي ذات النطاقين وماذا تعرف عنها؟"  → "ذات النطاقين"
 *   "من هو بطل الحرب والسلام؟"             → "بطل الحرب والسلام"
 *   "machine learning papers 2024"          → unchanged (not Arabic)
 */
export function preprocessQueryForSearch(query: string): {
  searchQuery: string;
  subject: string;
  isArabic: boolean;
  changed: boolean;
} {
  const isArabic = isArabicQuery(query);
  if (!isArabic) {
    return { searchQuery: query, subject: query, isArabic: false, changed: false };
  }
  return { ...cleanQueryForSearch(query), isArabic: true };
}

export function decomposeQuery(query: string): string[] {
  if (query.length <= MAX_QUERY_LENGTH) {
    return [query];
  }

  let parts = [query];

  for (const sep of CLAUSE_SEPARATORS) {
    if (parts.every(p => p.length <= MAX_QUERY_LENGTH)) break;

    parts = parts.flatMap(p => {
      if (p.length <= MAX_QUERY_LENGTH) return [p];
      return p.split(sep).map(s => s.trim()).filter(Boolean);
    });
  }

  parts = parts.flatMap(p => {
    if (p.length <= MAX_QUERY_LENGTH) return [p];
    return splitAtWordBoundary(p);
  });

  return parts;
}

function splitAtWordBoundary(text: string): string[] {
  const chunks: string[] = [];
  const words = text.split(' ');
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > MAX_QUERY_LENGTH && current) {
      chunks.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}
