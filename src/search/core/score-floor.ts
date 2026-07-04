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

export interface ScoreFloorOptions {
  /**
   * Per-engine keep guarantee. When set (>0), any contributing engine that the
   * query-wide floor would otherwise floor out ENTIRELY (kept-0) keeps up to
   * this many of its highest-scored results. Guards the cross-engine keep from
   * being like-unlike: a dominant vertical whose pages share the query's
   * doc-phrase tokens (high lexical alignment) scores high and monopolises the
   * kept set, while a general engine's correct-entity results score low on that
   * same lexical axis and fall below the query-wide floor. The guarantee keys
   * on `engine` PER-RESULT and only rescues engines with no above-floor
   * survivor, so an engine already represented above the floor is never given a
   * second below-floor slot. Budget-bounded to `perEngineKeep` rescues per
   * engine so a floored engine can't refill the whole slice with junk.
   *
   * The rescue is ALSO gated on a minimum relevance: an engine's best
   * below-floor result is only rescued when it is plausibly-relevant-just-
   * below-floor, i.e. `best >= floor * RESCUE_MIN_FLOOR_FRACTION`. An engine
   * that returned only genuine far-below-floor junk stays dropped — on the
   * fast/none path there is no rerank guard to damp junk first, so the floor's
   * own rescue must refuse it.
   */
  perEngineKeep?: number;
}

// A rescued engine's best below-floor result must be at least this fraction of
// the floor to count as plausibly-relevant-just-below-floor rather than junk.
// At the 0.05 default floor this is a 0.025 cutoff: correct-entity results that
// landed just under the floor (observed at ~0.02-0.03 in the kept-0 case) are
// rescued, while genuine off-topic junk (near-zero, ~0.001-0.01) stays dropped.
const RESCUE_MIN_FLOOR_FRACTION = 0.5;

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
 * - `opts.perEngineKeep` adds the cross-engine keep guarantee described on
 *   `ScoreFloorOptions`.
 *
 * The "always keep the top" guard keys off the maximum score, not array
 * position, so it is correct even if the caller hands an unsorted set.
 */
export function applyScoreFloor<T extends { relevance_score: number; engine?: string }>(
  results: T[],
  floor: number,
  opts: ScoreFloorOptions = {},
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

  // Per-engine keep guarantee: identify the below-floor indices to RESCUE so a
  // dominant engine can't floor out another engine entirely. Only engines with
  // zero above-floor survivors are eligible, and each keeps at most
  // `perEngineKeep` of its highest-scored below-floor results.
  const rescued = new Set<number>();
  const perEngineKeep = opts.perEngineKeep ?? 0;
  if (perEngineKeep > 0) {
    const rescueMin = floor * RESCUE_MIN_FLOOR_FRACTION;
    const aboveFloorEngines = new Set<string>();
    const belowFloorByEngine = new Map<string, number[]>();
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const engine = r.engine;
      if (engine === undefined) continue;
      if (r.relevance_score >= floor) {
        aboveFloorEngines.add(engine);
      } else {
        const list = belowFloorByEngine.get(engine);
        if (list) list.push(i);
        else belowFloorByEngine.set(engine, [i]);
      }
    }
    for (const [engine, idxs] of belowFloorByEngine) {
      if (aboveFloorEngines.has(engine)) continue;
      // Highest-scored first; ties break on earliest index for determinism.
      idxs.sort((a, b) =>
        results[b].relevance_score - results[a].relevance_score || a - b,
      );
      for (let k = 0; k < Math.min(perEngineKeep, idxs.length); k++) {
        // Only rescue a plausibly-relevant-just-below-floor result. An engine
        // whose best is far below the floor returned only junk; leave it
        // dropped rather than force pure junk into the slice.
        if (results[idxs[k]].relevance_score >= rescueMin) rescued.add(idxs[k]);
      }
    }
  }

  const kept: T[] = [];
  const dropped: T[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (i === topIdx || r.relevance_score >= floor || rescued.has(i)) {
      kept.push(r);
    } else {
      dropped.push(r);
    }
  }
  return { kept, dropped };
}
