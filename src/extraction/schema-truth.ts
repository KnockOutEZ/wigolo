/**
 * Evidence-only constraint for LLM-sourced schema fields.
 *
 * Why this exists:
 *   An LLM can free-form-complete missing fields with confidently-wrong
 *   values — e.g. `developer: "Nvidia"` and `introduced: "May 2024"` on the
 *   Model Context Protocol Wikipedia page, where the source plainly says
 *   `Anthropic` / `November 25, 2024`. That is a major trust killer.
 *
 * What we do:
 *   For every field whose provenance is `llm`, verify the returned value is
 *   literally present in the source text (or a trivially derivable transform:
 *   number parse, year parse from a date string). If the verifier rejects, we
 *   set the field to `null` and emit a warning so the caller can debug why.
 *
 * What we deliberately don't do:
 *   - LLM-based hallucination detection / cross-encoder verification.
 *   - Replace the LLM with a pure rule-based extractor.
 *   - Verify heuristic / structured-data values — those are already trusted.
 */
import { parseHTML } from 'linkedom';

/** Internal: normalize a string for substring matching.
 *  - lowercase (case-insensitive match)
 *  - collapse all whitespace (multi-line snippets become single line) */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract plain text from HTML for verification. This must include all
 * user-facing content: regular text, `<code>`, `<pre>`, `<blockquote>`. We
 * use `textContent` on the document body — it gives us the same content a
 * reader would see, minus tags but including code/quote spans.
 *
 * Cached at the call boundary; re-computing per field would be O(N*HTML).
 */
export function getSourceText(html: string): string {
  if (!html) return '';
  try {
    const { document: doc } = parseHTML(html);
    const body = doc.body ?? doc.documentElement;
    return body?.textContent ?? '';
  } catch {
    // Malformed HTML — fall back to a raw-string scan with tags stripped.
    return html.replace(/<[^>]+>/g, ' ');
  }
}

/**
 * Verify a single LLM-sourced field value against the source text.
 *
 * Returns `true` when:
 *   - the value (case- and whitespace-normalized) appears as a substring of
 *     the source text;
 *   - the value is a number AND the same number (as a string) appears in
 *     the source text;
 *   - the value is `null` / `undefined` (nothing to verify).
 *
 * Returns `false` when the value is not derivable from source — meaning the
 * LLM hallucinated and the caller should null the field.
 *
 * This is a thin wrapper that normalizes `sourceText` once and delegates to
 * `verifyAgainstNormalizedSource`. Hot-path callers that verify many fields
 * against the same source MUST normalize once at the call boundary and use
 * `verifyAgainstNormalizedSource` directly — see `applyEvidenceFilter`.
 */
export function verifyAgainstSource(value: unknown, sourceText: string): boolean {
  if (value === null || value === undefined) return true;
  if (!sourceText) return false;
  return verifyAgainstNormalizedSource(value, normalize(sourceText));
}

/**
 * Internal hot-path verifier: takes an ALREADY-normalized haystack so the
 * caller can cache the O(N*HTML) work across many fields. The per-value
 * `normalize(String(value))` is still done here — that's bounded by value
 * length, not source length, and is unavoidable.
 *
 * Contract: `haystack` MUST be the output of `normalize(sourceText)`. Pass
 * `''` for an empty/missing source — the function returns false for any
 * non-null value, matching `verifyAgainstSource`'s behavior.
 */
function verifyAgainstNormalizedSource(value: unknown, haystack: string): boolean {
  if (value === null || value === undefined) return true;
  if (!haystack) return false;

  if (typeof value === 'string') {
    const needle = normalize(value);
    if (!needle) return false;
    return haystack.includes(needle);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    // Numeric trivial transform: accept when the same digits appear in
    // source. Accept both the bare number ("42") and a representation
    // padded by punctuation/currency ("$42", "42,000"). We match the
    // bare digit run via a regex anchored on word boundaries to avoid
    // matching e.g. "242" as proof of "42".
    const asString = String(value);
    // Word-boundary check on the digit run.
    const re = new RegExp(`(?:^|[^0-9])${escapeRe(asString)}(?:[^0-9]|$)`);
    return re.test(haystack);
  }

  if (typeof value === 'boolean') {
    // Booleans don't carry a literal source signal — accept only when the
    // word "true"/"false" is present in the source (rare but unambiguous).
    return haystack.includes(value ? 'true' : 'false');
  }

  // Objects / arrays — we don't attempt structural verification in this
  // slice. Accept by default; richer constrainers are out of scope.
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ApplyEvidenceFilterInput {
  values: Record<string, unknown>;
  provenance: Record<string, string>;
  sourceText: string;
  /** Only verify these fields — typically the LLM-sourced subset. */
  fields: string[];
}

export interface ApplyEvidenceFilterResult {
  values: Record<string, unknown>;
  rejectedFields: string[];
}

/**
 * Apply the evidence-only filter to a subset of fields. Returns a new
 * `values` object where every rejected field is set to `null`, plus the
 * list of fields that were rejected (so callers can emit a warning).
 *
 * Non-listed fields are passed through untouched — heuristic /
 * structured-data values do not go through the verifier.
 */
export function applyEvidenceFilter(
  input: ApplyEvidenceFilterInput,
): ApplyEvidenceFilterResult {
  const out: Record<string, unknown> = { ...input.values };
  const rejected: string[] = [];

  // Normalize the haystack ONCE — the per-field loop below would otherwise
  // re-run an O(N*HTML) normalize for every field. See file-level comment
  // ("Cached at the call boundary; re-computing per field would be O(N*HTML).").
  const haystack = input.sourceText ? normalize(input.sourceText) : '';

  for (const key of input.fields) {
    const v = out[key];
    if (v === null || v === undefined) continue;
    if (!verifyAgainstNormalizedSource(v, haystack)) {
      out[key] = null;
      rejected.push(key);
    }
  }
  return { values: out, rejectedFields: rejected };
}
