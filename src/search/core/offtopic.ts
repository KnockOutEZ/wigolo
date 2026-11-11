// Foreign-script detection for whole result batches.
//
// WHY THIS EXISTS
// The ranking gates are lexical: a result that shares no token with the
// query is treated as off-topic. That works for Latin-script queries, but
// the failure mode for a non-Latin query is louder — the engine answers in
// ANOTHER language, so nothing in the payload shares the query's script at
// all. A classic shape: an Arabic query answered by one engine with
// unrelated English pages. Those rows are well-formed (title, URL, snippet),
// so every count-based health check passes, and the junk is then written to
// the persistent search cache and replayed for the whole TTL.
//
// The gate here is: "the query is written in Arabic and NOT ONE result is
// written in Arabic" -> the engine answered in the wrong language and the
// payload is noise.
//
// SCOPE — Arabic only, deliberately:
//   * Latin queries are untouched: their junk is already handled by the
//     existing (English-calibrated) gates, and changing that behaviour would
//     change the contract for every caller.
//   * CJK (Han, Kana, Hangul) is untouched: the ranking tokenizer emits CJK
//     tokens, so lexical alignment already judges those rows, and a CJK query
//     answered by an English page is a legitimate cross-language answer.
//     Gating it would empty the payload (and make every cached CJK answer a
//     miss).
//   * Hebrew, Cyrillic, Greek, Indic and Thai produce NO content tokens in the
//     shared tokenizer, so `hasContentTokens()` is false for those queries and
//     both gates below are already inert. They are not "covered" by this file.

import { lexicalAlignment, hasContentTokens } from './lexical-alignment.js';

export interface AlignableResult {
  title?: string;
  snippet?: string;
  url?: string;
}

// Non-Latin script ranges. The FIRST range present in the query defines the
// query's script; a result counts as "in-script" when it contains ANY
// character from that range.
const NON_LATIN_SCRIPTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/, 'arabic'],
  [/[\u0590-\u05FF]/, 'hebrew'],
  [/[\u0400-\u04FF]/, 'cyrillic'],
  [/[\u0370-\u03FF]/, 'greek'],
  [/[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F]/, 'indic'],
  [/[\u0E00-\u0E7F]/, 'thai'],
  [/[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9D]/, 'kana'],
  [/[\u4E00-\u9FFF\u3400-\u4DBF\uF900-\uFAFF]/, 'han'],
  [/[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/, 'hangul'],
];

function detectNonLatinScript(text: string): string | null {
  for (const [re, name] of NON_LATIN_SCRIPTS) {
    if (re.test(text)) return name;
  }
  return null;
}

// Unicode-aware: æ, ø, œ, … any Latin-script letter counts, not just A-Z.
const LATIN_RE = /\p{Script=Latin}/u;

// The only script these gates may act on. See the SCOPE note at the top of the
// file: CJK is tokenizer-covered, so gating it would drop legitimate rows, and
// the remaining non-Latin scripts never reach here (no content tokens).
const GATED_SCRIPTS = new Set(['arabic']);

function containsScript(text: string, script: string): boolean {
  for (const [re, name] of NON_LATIN_SCRIPTS) {
    if (name === script) return re.test(text);
  }
  return false;
}

/**
 * True when the query is written in Arabic and NOT ONE result in the batch is
 * written in Arabic — i.e. the engine answered in a different language.
 * Returns false for Latin-script queries, for scripts these gates do not own
 * (CJK — see SCOPE), for stopword-only queries, and for an empty batch.
 */
export function isForeignScriptBatch(query: string, results: AlignableResult[]): boolean {
  if (!results || results.length === 0) return false;
  if (!hasContentTokens(query)) return false;
  const script = detectNonLatinScript(query);
  if (!script || !GATED_SCRIPTS.has(script)) return false;
  // MIXED-script query (e.g. Arabic + "docker"): the Latin part is a
  // content token of its own, so an all-Latin result set is a legitimate
  // answer — the query's language does not pin the answer's language.
  if (LATIN_RE.test(query)) return false;
  return results.every(
    (r) => !containsScript(`${r.title ?? ''} ${r.snippet ?? ''}`, script),
  );
}

// Scripts the shared ranking tokenizer ALREADY covers (Han, Kana, Hangul).
// Their alignment is meaningful, so the demotion below must not change
// their ranking.
const TOKENIZER_COVERED_SCRIPTS = new Set(['han', 'kana', 'hangul']);


/**
 * Sink the rows that cannot be about the query instead of dropping them: for
 * a non-Latin-script query, a row that shares NO content token with the
 * query is almost certainly noise (another language, another topic). It is
 * demoted (score x factor) rather than removed — a degraded pool may have
 * produced nothing else — so the score floor can trim it and the on-topic
 * rows keep the top slots. Latin-script queries are untouched, and so are
 * the scripts the tokenizer already handles (CJK).
 */
export function demoteUnalignedResults<
  T extends AlignableResult & { relevance_score: number },
>(query: string, results: T[], factor = 0.05): T[] {
  if (!results || results.length === 0) return results;
  if (!hasContentTokens(query)) return results;
  const script = detectNonLatinScript(query);
  if (!script) return results;
  if (TOKENIZER_COVERED_SCRIPTS.has(script)) return results;
  // MIXED-script query (Arabic + a Latin term such as "docker"): the Latin
  // part is a content token of its own, so an English row that shares no
  // Arabic token can still be the right answer. Demoting it on the Arabic
  // half alone is what sank relevant English pages.
  if (LATIN_RE.test(query)) return results;
  return results.map((r) =>
    lexicalAlignment(query, r.title ?? '', r.snippet ?? '') === 0
      ? { ...r, relevance_score: r.relevance_score * factor }
      : r,
  );
}
