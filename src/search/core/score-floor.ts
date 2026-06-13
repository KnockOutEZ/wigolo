// Relevance-score floor — drops near-zero/negative-scored junk from an
// already-ranked result set.
//
// Why this exists: the cross-encoder rerank-fold (rerank-fold.ts) scores
// genuinely off-topic results into the tier-0 band [0, 0.5), with the worst
// junk landing near 0 (benchmark 2026-06-14 A1: Cambridge-dictionary results
// at normalized 0.0097 / 0.0003). The reranker scores them correctly LOW, but
// nothing removed them — they consumed top-N slots. This floor is the cheap
// pre-slice cut that drops them.
//
// Pure + score-shape-only: it reads `relevance_score` and is agnostic to the
// rest of the result object, so both the search final-ordering seam and the
// research source pool can share it. It is NOT a relevance re-ranker — order
// is decided upstream; this only trims the tail.

/**
 * Default floor for the search top-N, on the [0,1]-normalized score the
 * caller sees in `relevance_score`. Tuned against the A1 fixture: the
 * near-zero tail (0.0097 / 0.0003) drops, on-topic results (post-rerank-fold
 * tier-1 ≥ 0.5, or strong tier-0) stay. Low enough that the keyless
 * deterministic path (min normalized score ~0.13 in practice) is untouched —
 * the floor only bites the reranker's tier-0 near-zero band.
 */
export const DEFAULT_SEARCH_SCORE_FLOOR = 0.05;

export interface ScoreFloorResult<T> {
  kept: T[];
  dropped: T[];
}

/**
 * Partition a ranked result set by a relevance-score floor.
 *
 * - `floor <= 0` is a no-op: everything is kept (preserves legacy behaviour
 *   when no floor is configured).
 * - The single highest-scored result is ALWAYS kept, even if it sits below the
 *   floor — returning nothing is worse than returning the best candidate when
 *   the reranker has damped every result into the junk band.
 * - Input order is preserved in both `kept` and `dropped` (the caller already
 *   ranked the set; this only trims).
 *
 * The "always keep the top" guard keys off the maximum score, not array
 * position, so it is correct even if the caller hands an unsorted set.
 */
export function applyScoreFloor<T extends { relevance_score: number }>(
  results: T[],
  floor: number,
): ScoreFloorResult<T> {
  if (results.length === 0) return { kept: [], dropped: [] };
  if (!Number.isFinite(floor) || floor <= 0) {
    return { kept: [...results], dropped: [] };
  }

  let maxScore = -Infinity;
  let topIdx = 0;
  for (let i = 0; i < results.length; i++) {
    if (results[i].relevance_score > maxScore) {
      maxScore = results[i].relevance_score;
      topIdx = i;
    }
  }

  const kept: T[] = [];
  const dropped: T[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (i === topIdx || r.relevance_score >= floor) {
      kept.push(r);
    } else {
      dropped.push(r);
    }
  }
  return { kept, dropped };
}
