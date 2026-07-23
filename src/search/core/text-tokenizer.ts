const LATIN_OR_DIGIT_RE = /[\p{Script=Latin}\p{N}]/u;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// `Script_Extensions` 将 ー 等日文共享符号保留在 Katakana 序列中，
// 避免把 ニュース 错分成 ニュ + ス。
const CJK_RUN = String.raw`[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]+`;
const TOKEN_PART_RE = new RegExp(String.raw`[\p{Script=Latin}\p{N}]+|${CJK_RUN}`, 'gu');
const MAX_INPUT_CODE_UNITS = 4096;
const MAX_TOKENS = 256;

/**
 * 对 ranking 文本做 Unicode-aware 分词，避免丢失 CJK 字符。
 * Latin/数字沿用小写单词语义，连续 CJK 文本生成重叠 bigram，保证无空格查询可比较。
 */
export function tokenizeRankingText(text: string): string[] {
  const tokens: string[] = [];
  // 先限制待处理输入，再执行 lowercase/regex/Array.from，避免超长 query
  // 在 token cap 生效前产生完整中间数组或触发 RegExp stack overflow。
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
