const LATIN_OR_DIGIT_RE = /[\p{Script=Latin}\p{N}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Include the prolonged sound mark explicitly so it stays inside Katakana runs,
// while punctuation such as 、, 。, and ・ still separates CJK token parts.
const CJK_RUN = String.raw`[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC]+`;
const TOKEN_PART_RE = new RegExp(String.raw`[\p{Script=Latin}\p{N}]+|${CJK_RUN}`, 'gu');
const MAX_INPUT_CODE_UNITS = 4096;
const MAX_TOKENS = 256;

/**
 * Tokenize ranking text with Unicode awareness so CJK characters are not discarded.
 * Preserve lowercase word semantics for Latin/digits and emit overlapping bigrams for contiguous CJK text.
 */
export function tokenizeRankingText(text: string): string[] {
  const tokens: string[] = [];
  // Bound input before lowercasing, regex matching, or Array.from so an oversized query
  // cannot allocate complete intermediate arrays or overflow the RegExp stack before the token cap applies.
  const boundedText = text.slice(0, MAX_INPUT_CODE_UNITS).toLowerCase();
  const parts = boundedText.match(TOKEN_PART_RE) ?? [];

  for (const part of parts) {
    if (tokens.length >= MAX_TOKENS) break;
    if (LATIN_OR_DIGIT_RE.test(part)) {
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
