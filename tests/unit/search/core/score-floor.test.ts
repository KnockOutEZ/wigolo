import { describe, it, expect } from 'vitest';
import { applyScoreFloor, DEFAULT_SEARCH_SCORE_FLOOR } from '../../../../src/search/core/score-floor.js';

// Honest minimal scored shape: applyScoreFloor only reads relevance_score and
// keeps the rest of the object intact, so a tiny structural fixture is enough.
function s(url: string, relevance_score: number) {
  return { url, relevance_score };
}

describe('applyScoreFloor', () => {
  // A1 fixture: the exact failing distribution from the 2026-06-14 benchmark.
  // Three on-topic results (high, post-rerank-fold tier-1 / strong tier-0),
  // and the two Cambridge-dictionary results at near-zero (tier-0, blend ~0).
  it('drops the A1 near-zero tail (0.0097 / 0.0003) and keeps the 3 on-topic results', () => {
    const results = [
      s('https://en.wikipedia.org/wiki/Reciprocal_rank_fusion', 1.0),
      s('https://safjan.com/implementing-rank-fusion-in-python/', 0.71),
      s('https://plg.uwaterloo.ca/cormack-rrf.pdf', 0.63),
      s('https://dictionary.cambridge.org/dictionary/english/reciprocal', 0.0097),
      s('https://dictionary.cambridge.org/dictionary/english/rank', 0.0003),
    ];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR);
    expect(kept.map((r) => r.url)).toEqual([
      'https://en.wikipedia.org/wiki/Reciprocal_rank_fusion',
      'https://safjan.com/implementing-rank-fusion-in-python/',
      'https://plg.uwaterloo.ca/cormack-rrf.pdf',
    ]);
    expect(dropped.map((r) => r.url)).toEqual([
      'https://dictionary.cambridge.org/dictionary/english/reciprocal',
      'https://dictionary.cambridge.org/dictionary/english/rank',
    ]);
  });

  it('keeps a borderline-but-relevant result just above the floor', () => {
    // A result sitting just above the floor is legitimate signal, not junk.
    const results = [s('a', 1.0), s('b', DEFAULT_SEARCH_SCORE_FLOOR + 0.001)];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR);
    expect(kept.map((r) => r.url)).toEqual(['a', 'b']);
    expect(dropped).toHaveLength(0);
  });

  it('keeps the top result even when everything is below the floor (healthy pool, no lexical gate)', () => {
    // Degenerate case on a HEALTHY pool (no degraded flag): the reranker thinks
    // every result is junk, but the top-1 exemption still keeps the single best
    // candidate — returning nothing is worse when we have no degraded-pool
    // zero-lexical signal telling us the survivor is genuine off-topic junk.
    const results = [s('a', 0.004), s('b', 0.002), s('c', 0.001)];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR);
    expect(kept.map((r) => r.url)).toEqual(['a']);
    expect(dropped.map((r) => r.url)).toEqual(['b', 'c']);
  });

  it('a floor of 0 is a no-op (preserves the legacy keyless default)', () => {
    const results = [s('a', 0.13), s('b', 0.0001)];
    const { kept, dropped } = applyScoreFloor(results, 0);
    expect(kept.map((r) => r.url)).toEqual(['a', 'b']);
    expect(dropped).toHaveLength(0);
  });

  it('empty input returns empty kept/dropped without throwing', () => {
    const { kept, dropped } = applyScoreFloor([], DEFAULT_SEARCH_SCORE_FLOOR);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(0);
  });
});

// Degraded-pool lexical gate (gate c). When the engine pool has degraded (all
// but one engine down under burst), the always-keep-top exemption and the
// per-engine rescue must NOT rescue a zero-lexical result — that is exactly the
// live-incident junk (a lone survivor's off-topic page sharing NO query token
// ranked top with a ~1.0 score). A pool that is ENTIRELY zero-lexical under
// degradation returns EMPTY rather than surfacing junk as the answer. The gate
// keys per-result on the injected lexical-alignment accessor + the degraded
// flag — never a query-wide boolean on healthy pools.
function sl(url: string, relevance_score: number, la: number, engine?: string) {
  return { url, relevance_score, lexical_alignment: la, ...(engine ? { engine } : {}) };
}
const laOf = (r: { lexical_alignment: number }) => r.lexical_alignment;

describe('applyScoreFloor — degraded-pool lexical gate', () => {
  it('a degraded pool that is ENTIRELY zero-lexical returns EMPTY (no top-1 exemption)', () => {
    // The live incident: a single degraded survivor returns off-topic results
    // that share NO query token. Under degradation the top-1 exemption is
    // withdrawn for zero-lexical results, so the set empties instead of
    // surfacing junk as the top answer.
    const results = [sl('a', 0.004, 0), sl('b', 0.002, 0)];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, {
      degraded: true,
      lexicalAlignmentOf: laOf,
    });
    expect(kept).toHaveLength(0);
    expect(dropped.map((r) => r.url)).toEqual(['a', 'b']);
  });

  it('a degraded pool keeps a lexically-aligned result and drops the zero-lexical junk', () => {
    // Mixed degraded pool: the lexical hit survives on merit (above floor), the
    // zero-lexical junk is neither exempted nor rescued.
    const results = [sl('hit', 0.6, 0.5, 'e1'), sl('junk', 0.004, 0, 'e2')];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, {
      degraded: true,
      lexicalAlignmentOf: laOf,
      perEngineKeep: 1,
    });
    expect(kept.map((r) => r.url)).toEqual(['hit']);
    expect(dropped.map((r) => r.url)).toEqual(['junk']);
  });

  it('under degradation the per-engine rescue does NOT rescue a zero-lexical engine', () => {
    // Engine e2 would normally get its best below-floor result rescued
    // (perEngineKeep) — but its result is zero-lexical under a degraded pool, so
    // the rescue is withdrawn.
    const results = [
      sl('top', 0.9, 0.8, 'e1'),
      sl('rescue-candidate', 0.03, 0, 'e2'),
    ];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, {
      degraded: true,
      lexicalAlignmentOf: laOf,
      perEngineKeep: 1,
    });
    expect(kept.map((r) => r.url)).toEqual(['top']);
    expect(dropped.map((r) => r.url)).toEqual(['rescue-candidate']);
  });

  it('MUST-NOT-FIRE: a zero-lexical result that clears the floor on a degraded pool is kept', () => {
    // The gate only withdraws EXEMPTION/RESCUE — a zero-lexical result that
    // independently clears the floor is legitimate and stays kept even under
    // degradation.
    const results = [sl('a', 0.6, 0.4), sl('zero-but-strong', 0.2, 0)];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, {
      degraded: true,
      lexicalAlignmentOf: laOf,
    });
    expect(kept.map((r) => r.url)).toEqual(['a', 'zero-but-strong']);
  });

  it('MUST-NOT-FIRE: on a HEALTHY pool a zero-lexical below-floor result still gets the top-1 exemption', () => {
    // No degraded flag -> the gate is inert -> the top-1 exemption behaves
    // exactly as before, keeping the best candidate even if zero-lexical.
    const results = [sl('a', 0.004, 0), sl('b', 0.002, 0)];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, {
      lexicalAlignmentOf: laOf,
    });
    expect(kept.map((r) => r.url)).toEqual(['a']);
  });

  it('MUST-NOT-FIRE: a zero-lexical below-floor result on a HEALTHY pool is still per-engine rescued', () => {
    // Healthy pool, no degraded flag: the per-engine rescue is unchanged — a
    // just-below-floor result from an otherwise-floored engine is still rescued.
    const results = [
      sl('top', 0.9, 0.8, 'e1'),
      sl('rescue-candidate', 0.03, 0, 'e2'),
    ];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, {
      lexicalAlignmentOf: laOf,
      perEngineKeep: 1,
    });
    expect(kept.map((r) => r.url)).toContain('rescue-candidate');
  });

  it('MUST-NOT-FIRE: without a lexicalAlignmentOf accessor the degraded flag is inert', () => {
    // The gate needs the per-result lexical signal to act. Without the accessor
    // it fails open (top-1 exemption preserved) even under degradation.
    const results = [sl('a', 0.004, 0), sl('b', 0.002, 0)];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, { degraded: true });
    expect(kept.map((r) => r.url)).toEqual(['a']);
  });
});
