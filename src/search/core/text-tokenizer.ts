const LATIN_OR_DIGIT_RE = /[\p{Script=Latin}\p{N}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const ARABIC_RE = /\p{Script=Arabic}/u;
// Include the prolonged sound mark explicitly so it stays inside Katakana runs,
// while punctuation such as 、, 。, and ・ still separates CJK token parts.
const CJK_RUN = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]+`;
// Arabic words are whitespace-delimited like Latin ones, so an Arabic run is
// matched as a whole word (no bigrams). Combining marks are included so a
// word carrying a harakat is not split in two.
const ARABIC_RUN = String.raw`[\p{Script=Arabic}\p{M}]+`;
const TOKEN_PART_RE = new RegExp(
  String.raw`[\p{Script=Latin}\p{N}]+|${CJK_RUN}|${ARABIC_RUN}`,
  'gu',
);
const MAX_INPUT_CODE_UNITS = 4096;
const MAX_TOKENS = 256;

// Arabic diacritics (harakat) + tatweel. Stripped so a word written with and
// without harakat is the SAME token.
const ARABIC_DIACRITICS_RE = /[\u064B-\u0652\u0670\u0640]/g;

/**
 * Fold the Arabic orthographic variants that carry no meaning for ranking:
 * آ/أ/إ/ٱ -> ا, ى -> ي, ة -> ه, ؤ -> و, ئ -> ي. Without this, "أحمد" and
 * "احمد" are two different tokens and the lexical-alignment gate sees zero
 * overlap for Arabic text.
 */
function foldArabic(text: string): string {
  if (!ARABIC_RE.test(text)) return text;
  return text
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A');
}

/**
 * Tokenize ranking text with Unicode awareness so CJK characters are not discarded.
 * Preserve lowercase word semantics for Latin/digits, emit overlapping bigrams for contiguous CJK text,
 * and emit whole (folded) words for Arabic text.
 */
export function tokenizeRankingText(text: string): string[] {
  const tokens: string[] = [];
  // Bound input before lowercasing, regex matching, or Array.from so an oversized query
  // cannot allocate complete intermediate arrays or overflow the RegExp stack before the token cap applies.
  const boundedText = foldArabic(text.slice(0, MAX_INPUT_CODE_UNITS).toLowerCase());
  const parts = boundedText.match(TOKEN_PART_RE) ?? [];

  for (const part of parts) {
    if (tokens.length >= MAX_TOKENS) break;
    if (LATIN_OR_DIGIT_RE.test(part)) {
      tokens.push(part);
      continue;
    }
    if (ARABIC_RE.test(part)) {
      // Arabic words are matched whole — the run regex already captured the
      // full word, diacritics folded away.
      tokens.push(part);
      continue;
    }
    if (!CJK_RE.test(part)) continue;

    const chars = Array.from(part);
    if (chars.length === 1) {
      tokens.push(chars[0]);
      continue;
    }
    for (let i = 0; i < chars.length - 1; i++) {
      tokens.push(chars[i] + chars[i + 1]);
      if (tokens.length >= MAX_TOKENS) break;
    }
  }

  return tokens;
}
