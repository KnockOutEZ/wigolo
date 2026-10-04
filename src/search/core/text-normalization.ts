// Shared Unicode-aware text normalization/tokenization for search signals.
// Keeps Latin/Arabic/numbers intact while normalizing punctuation and common
// Arabic orthographic variants. This is deliberately dependency-free so every
// search path uses the same behavior.

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu;

export const SEARCH_STOPWORDS: ReadonlySet<string> = new Set([
  // English function words / generic query modifiers
  'the', 'a', 'an', 'what', 'is', 'are', 'was', 'were', 'how', 'why', 'when', 'where', 'who',
  'do', 'does', 'did', 'for', 'of', 'to', 'in', 'on', 'with', 'and', 'or', 'but', 'as', 'at',
  'by', 'from', 'into', 'about', 'than', 'this', 'that', 'these', 'those', 'it', 'its',
  'be', 'been', 'has', 'have', 'had', 'can', 'could', 'should', 'would', 'may', 'might',
  'must', 'will', 'shall', 'i', 'you', 'we', 'they', 'he', 'she', 'them', 'my', 'your',
  'our', 'their', 'latest', 'current', 'newest', 'recent', 'best', 'top', 'most',
  // Arabic function words / generic question and time modifiers
  'ما', 'ماذا', 'متى', 'أين', 'اين', 'من', 'هل', 'هو', 'هي', 'هم', 'هن', 'أنا', 'انا',
  'انت', 'أنت', 'أنتم', 'انتم', 'نحن', 'في', 'من', 'إلى', 'الى', 'على', 'عن', 'مع', 'بين',
  'و', 'أو', 'او', 'ثم', 'لكن', 'هذا', 'هذه', 'ذلك', 'تلك', 'الذي', 'التي', 'الذين',
  'اللاتي', 'كان', 'كانت', 'يكون', 'تكون', 'تم', 'قد', 'لقد', 'لـ', 'خلال', 'عام', 'سنة',
  'آخر', 'اخر', 'أحدث', 'احدث', 'جديد', 'جديدة', 'حديث', 'حديثة',
]);

/** Normalize common Arabic orthographic noise without transliterating Arabic. */
export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/ـ/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ى/gu, 'ي')
    .toLowerCase();
}

/** Unicode-aware tokens; punctuation is a boundary, including Arabic punctuation. */
export function tokenizeSearchText(value: string): string[] {
  return normalizeSearchText(value)
    .replace(/[^\\p{L}\\p{N}]+/gu, ' ')
    .split(/\\s+/u)
    .filter(Boolean);
}

/** Content tokens used by lexical alignment and phrase matching. */
export function tokenizeContent(value: string): string[] {
  return tokenizeSearchText(value).filter((token) =>
    token.length >= 2 && !SEARCH_STOPWORDS.has(token),
  );
}

/** Lightweight script-based language guess; explicit caller language still wins. */
export function detectSearchLanguage(value: string): string {
  const normalized = normalizeSearchText(value);
  const arabic = normalized.match(/[\\u0600-\\u06FF]/gu)?.length ?? 0;
  const latin = normalized.match(/[A-Za-z]/g)?.length ?? 0;
  if (arabic === 0 && latin === 0) return 'unknown';
  if (arabic >= 2 && arabic >= latin) return 'ar';
  return 'en';
}
