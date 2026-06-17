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

  it('never empties the set — keeps the top result even when everything is below the floor', () => {
    // Degenerate case: the reranker thinks every result is junk. Returning
    // nothing is worse than returning the single best candidate.
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
