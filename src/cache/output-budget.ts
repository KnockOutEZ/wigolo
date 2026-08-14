import { applyAggregateMarkdownBudget } from '../search/evidence.js';
import { repairTruncatedMarkdown, closeTruncatedFence } from '../search/truncate.js';
import type { CacheResultItem, CacheTruncation } from '../types.js';

/**
 * Default aggregate token budget for a `cache` response.
 *
 * `limit` caps ROWS, never bytes, so before this existed a single default-limit
 * call could return an arbitrary number of characters — a live call returned
 * 171,751 and had to be spilled to a file to be readable. Every other
 * content-returning tool already defaults a budget; this one did not.
 *
 * Sized against the real corpus (1,134 cached pages, ~11.3M chars of markdown):
 * a page is p50 1,402 / p90 7,098 / p99 13,086 tokens, so a default-limit
 * (5-row) response is p50 11,816 / p90 21,768 tokens.
 *   - 16,000 leaves 72% of default-limit responses untouched and holds 99.6% of
 *     single cached pages whole.
 *   - The repo-wide 4,000 used by search/agent/find_similar would leave only
 *     5.7% untouched — those tools return excerpts, this one returns whole
 *     cached pages, which is why the number differs.
 * The cap costs a caller ~8% of a 200k context window instead of the ~21% the
 * reported call actually spent.
 *
 * Every figure above comes from `scripts/derive-cache-budget.mjs`, which reads a
 * real cache and prints them — run it to re-check this number against a cache
 * whose contents have moved on, rather than trusting a measurement frozen here.
 */
export const DEFAULT_CACHE_MAX_TOKENS_OUT = 16000;

/**
 * Row cap for `check_changes`, which returns change reports rather than page
 * bodies and so cannot use the token budget above.
 *
 * Derived from the same budget: against the real cache the widest report shape
 * (changed, both hashes, a diff summary) costs ~150 tokens, so 16,000 tokens
 * holds ~106 of them — rounded down for headroom. Unbounded, this path emitted
 * 358,152 chars / 169,979 tokens over 1,134 entries, twice the response that
 * prompted this budget, and re-fetched every one of those URLs over the network.
 *
 * `scripts/derive-cache-budget.mjs` re-derives both this and the token budget.
 */
export const DEFAULT_CHECK_CHANGES_LIMIT = 100;

/** Marker `truncateByTokens` appends; used to find where a body was cut. */
const TRUNCATION_MARKER = '\n\n[... content truncated]';

const HINT =
  'Body content was trimmed to fit the output budget. Raise max_tokens_out for more, ' +
  'narrow the result set with query / url_pattern / limit, or fetch a specific url for its full body.';

export interface BudgetedCacheResults {
  results: CacheResultItem[];
  truncation?: CacheTruncation;
}

/**
 * Bound the aggregate markdown a `cache` response carries, and say so.
 *
 * Reuses the shared aggregate-markdown budget every other multi-item tool goes
 * through — this adds a default and an honest report, not a second mechanism.
 * A trimmed body is repaired at a markdown boundary — a half-open fence, link or
 * emphasis span is dropped, and a body that is one lone fence has the fence
 * closed around whatever code fits rather than being repaired away to nothing.
 * Every row the budget touched is labelled so an emptied body is not read as
 * "this cached page is blank".
 *
 * Mutates and returns `results` (same convention as the shared helper).
 */
export function applyCacheOutputBudget(
  results: CacheResultItem[],
  maxTokensOut?: number,
): BudgetedCacheResults {
  const budget = maxTokensOut ?? DEFAULT_CACHE_MAX_TOKENS_OUT;
  const originals = results.map((r) => r.markdown ?? '');
  const originalChars = originals.reduce((n, body) => n + body.length, 0);

  applyAggregateMarkdownBudget(
    results,
    (r) => r.markdown,
    (r, body) => { r.markdown = body; },
    { maxTokensOut: budget },
  );

  let truncated = 0;
  let omitted = 0;
  for (let i = 0; i < results.length; i++) {
    const before = originals[i];
    const after = results[i].markdown;
    // A row that had no body was already empty — the budget did not drop it.
    if (!before || after === before) continue;
    if (after === '') {
      results[i].truncated = 'omitted';
      omitted++;
    } else {
      results[i].markdown = repairAtBoundary(after);
      results[i].truncated = 'partial';
      truncated++;
    }
  }

  if (truncated === 0 && omitted === 0) return { results };

  const returnedChars = results.reduce((n, r) => n + (r.markdown?.length ?? 0), 0);
  return {
    results,
    truncation: {
      budget_tokens: budget,
      original_chars: originalChars,
      returned_chars: returnedChars,
      dropped_chars: originalChars - returnedChars,
      results_truncated: truncated,
      results_omitted: omitted,
      hint: HINT,
    },
  };
}

/**
 * Re-cut a trimmed body so it does not end inside a markdown construct.
 *
 * The repair is strictly subtractive, so the result stays inside the budget the
 * body was just cut to. It runs on the content BEFORE the truncation marker and
 * the marker is re-appended, because the repair walks backwards from the end of
 * the string and would otherwise delete the very signal that says the body was
 * cut.
 *
 * The subtractive repair deletes an unterminated fence and everything inside it,
 * so a body that IS one code fence — a gist, a config file, a source page, all
 * ordinary contents of a developer's cache — repairs to nothing. Closing the
 * fence recovers the code that fits instead, the same second chance
 * `truncateSmartly` and `truncateAtBoundary` already give it. `head.length` as
 * the char budget makes the result strictly shorter than the cut it replaces, so
 * it cannot escape the token budget.
 */
function repairAtBoundary(body: string): string {
  if (!body.endsWith(TRUNCATION_MARKER)) return body;
  const head = body.slice(0, body.length - TRUNCATION_MARKER.length);
  const repaired = repairTruncatedMarkdown(head).trimEnd();
  if (repaired) return repaired + TRUNCATION_MARKER;
  const fenced = closeTruncatedFence(head, head.length);
  return (fenced ?? head) + TRUNCATION_MARKER;
}
