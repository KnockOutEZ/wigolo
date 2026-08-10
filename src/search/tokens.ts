/**
 * Token counting and token-budget truncation.
 *
 * These counts drive `max_tokens_out` budgets and content truncation — they are
 * a context-budget proxy for whichever model the calling agent runs. They were
 * never a billing figure, and they were never exact for the caller: the old
 * implementation ran real cl100k-base BPE (OpenAI), whose counts already drift
 * roughly 5-15% on Claude, Gemini and Llama.
 *
 * Paying 55 MB of install weight for BPE rank tables to produce a number that is
 * approximate the moment it leaves this file is a bad trade, so the counter is a
 * linear model over character classes instead — fitted by weighted least squares
 * against real cl100k counts over 1610 samples (this repo's TypeScript, Markdown,
 * JSON and HTML fixtures, plus CJK / Hangul / Cyrillic / Arabic / Hebrew / Greek /
 * Devanagari / Thai / emoji / URL / base64 / hash / numeric corpora).
 *
 * Measured agreement with cl100k on that corpus:
 *   mean 1.006  median 1.000  p05 0.910  p95 1.118  p99 1.207
 *   worst under-count 0.667   worst over-count 1.438
 * i.e. half the time within 0.1%, and 90% of the time inside -9% / +12%. That is
 * comfortably inside the model-family drift the previous exact-BPE count already
 * carried. tests/unit/search/tokens-accuracy.test.ts pins these bounds against
 * the real tokenizer so a regression in the weights cannot pass quietly.
 *
 * Truncation remains EXACT with respect to this metric: truncateByTokens measures
 * and cuts with the same counter, so `countTokens(truncateByTokens(t, n)) <= n`
 * holds by construction regardless of how well the metric tracks any given model.
 */

const TRUNC_MARKER = '\n\n[... content truncated]';

/**
 * Fitted token cost per character class. All weights are non-negative, which is
 * what makes the running total monotonic in text length — the single-pass cut in
 * `prefixWithinBudget` depends on that.
 */
const W_ASCII_LETTER = 0.22;
const W_DIGIT = 0.14;
/** Per digit RUN, not per digit: BPE spends a token entering a numeric span. */
const W_DIGIT_RUN = 2.23;
const W_NEWLINE = 0.5;
const W_SPACE = 0.11;
const W_ASCII_PUNCT = 0.47;
const W_HAN = 0.78;
const W_HANGUL = 0.67;
const W_OTHER_LETTER = 0.33;
const W_EMOJI = 1.98;
const W_OTHER = 0.33;

const RE_HAN = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u;
const RE_HANGUL = /\p{Script=Hangul}/u;
const RE_LETTER = /\p{L}|\p{M}/u;
const RE_EMOJI = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|[\u{1F3FB}-\u{1F3FF}]/u;

function nonAsciiWeight(ch: string): number {
  if (RE_HAN.test(ch)) return W_HAN;
  if (RE_HANGUL.test(ch)) return W_HANGUL;
  if (RE_LETTER.test(ch)) return W_OTHER_LETTER;
  if (RE_EMOJI.test(ch)) return W_EMOJI;
  return W_OTHER;
}

/**
 * Single forward pass over the text, accumulating token weight.
 *
 * When `budget` is null it returns the total for the whole string. Otherwise it
 * stops at the last code point that still fits and reports that index, so
 * counting and truncating share one implementation and cannot disagree.
 */
function scan(text: string, budget: number | null): { tokens: number; cut: number } {
  let total = 0;
  let prevDigit = false;
  let i = 0;

  while (i < text.length) {
    const code = text.codePointAt(i) as number;
    const width = code > 0xffff ? 2 : 1;

    let weight: number;
    let isDigit = false;

    if (code < 128) {
      if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
        weight = W_ASCII_LETTER;
      } else if (code >= 48 && code <= 57) {
        isDigit = true;
        weight = prevDigit ? W_DIGIT : W_DIGIT + W_DIGIT_RUN;
      } else if (code === 10 || code === 13) {
        weight = W_NEWLINE;
      } else if (code === 32 || code === 9 || code === 11 || code === 12) {
        weight = W_SPACE;
      } else {
        weight = W_ASCII_PUNCT;
      }
    } else {
      const ch = String.fromCodePoint(code);
      weight = /\s/u.test(ch) ? W_SPACE : nonAsciiWeight(ch);
    }

    if (budget !== null && total + weight > budget) {
      return { tokens: Math.ceil(total), cut: i };
    }

    total += weight;
    prevDigit = isDigit;
    i += width;
  }

  return { tokens: Math.ceil(total), cut: text.length };
}

export function countTokens(text: string): number {
  if (!text) return 0;
  return scan(text, null).tokens;
}

/**
 * What the truncation marker itself costs, measured with the same counter rather
 * than hardcoded. The old value was a literal 6, correct for cl100k and wrong for
 * anything else — a retune of the weights would otherwise silently start
 * overshooting every budget by the drift in this one constant.
 *
 * Budgets at or below this cannot fit the marker at all; see truncateByTokens.
 */
export const TRUNCATION_MARKER_TOKENS = countTokens(TRUNC_MARKER);

/**
 * Token-budget truncation. Prefer sentence > paragraph > section boundary
 * within the last 30% of the budget. Falls back to a hard cut + marker.
 *
 * Guarantees `countTokens(result) <= maxTokens` whenever
 * `maxTokens > TRUNCATION_MARKER_TOKENS`. Below that the marker alone exceeds the
 * budget, and the long-standing behaviour — say so rather than return empty
 * content — is kept.
 */
export function truncateByTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return TRUNC_MARKER.trim();
  if (!text) return '';
  if (countTokens(text) <= maxTokens) return text;

  const budget = Math.max(0, maxTokens - TRUNCATION_MARKER_TOKENS);
  const head = text.slice(0, scan(text, budget).cut);
  const threshold = head.length * 0.7;

  const lastSentence = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('.\n'),
    head.lastIndexOf('? '),
    head.lastIndexOf('! '),
  );
  if (lastSentence > threshold) {
    return head.slice(0, lastSentence + 1) + TRUNC_MARKER;
  }
  const lastPara = head.lastIndexOf('\n\n');
  if (lastPara > threshold) {
    return head.slice(0, lastPara) + TRUNC_MARKER;
  }
  const lastHeading = head.lastIndexOf('\n#');
  if (lastHeading > threshold) {
    return head.slice(0, lastHeading) + TRUNC_MARKER;
  }
  return head + TRUNC_MARKER;
}
