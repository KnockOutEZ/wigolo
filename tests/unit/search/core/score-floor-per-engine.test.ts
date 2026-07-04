import { describe, it, expect } from 'vitest';
import { applyScoreFloor, DEFAULT_SEARCH_SCORE_FLOOR } from '../../../../src/search/core/score-floor.js';

// Per-engine keep-guarantee: a dominant engine/vertical (high lexical
// alignment on its pages) must not floor out ANOTHER engine's entire
// contribution. Fixtures carry an `engine` field so the guarantee can key on
// which engine produced each result — per-result, never a query-wide boolean.
function e(url: string, relevance_score: number, engine: string) {
  return { url, relevance_score, engine };
}

describe('applyScoreFloor — per-engine keep guarantee', () => {
  it('rescues the top survivor of an engine that would otherwise be floored to zero', () => {
    // The kept-0 scenario: MDN (dominant vertical) has 3 high-scored pages;
    // Bing returns correct-entity results that all landed below the floor.
    // Without the guarantee Bing is floored to 0/3; with it, Bing keeps its
    // best result so cross-engine keep is like-for-like.
    const results = [
      e('https://developer.mozilla.org/g1', 0.9, 'mdn'),
      e('https://developer.mozilla.org/g2', 0.8, 'mdn'),
      e('https://developer.mozilla.org/g3', 0.7, 'mdn'),
      e('https://bing-correct-1.example/a', 0.03, 'bing'),
      e('https://bing-correct-2.example/b', 0.02, 'bing'),
      e('https://bing-correct-3.example/c', 0.01, 'bing'),
    ];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, { perEngineKeep: 1 });
    const keptUrls = kept.map((r) => r.url);
    // MDN survives on merit.
    expect(keptUrls).toContain('https://developer.mozilla.org/g1');
    // Bing's best result is rescued — the engine is not floored to zero.
    expect(keptUrls).toContain('https://bing-correct-1.example/a');
    // Only ONE Bing result is rescued (budget-bounded), the deeper two drop.
    expect(keptUrls).not.toContain('https://bing-correct-2.example/b');
    expect(keptUrls).not.toContain('https://bing-correct-3.example/c');
  });

  it('does NOT rescue an engine that already has an above-floor survivor', () => {
    // Engine "b" has one result above the floor; the guarantee must not also
    // pull up its below-floor junk — the engine is already represented.
    const results = [
      e('https://a/1', 0.9, 'a'),
      e('https://b/1', 0.5, 'b'),
      e('https://b/2', 0.02, 'b'),
    ];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, { perEngineKeep: 1 });
    const keptUrls = kept.map((r) => r.url);
    expect(keptUrls).toEqual(['https://a/1', 'https://b/1']);
    expect(keptUrls).not.toContain('https://b/2');
  });

  it('is a no-op relative to the plain floor when every engine has an above-floor survivor', () => {
    const results = [
      e('https://a/1', 0.9, 'a'),
      e('https://b/1', 0.4, 'b'),
      e('https://a/2', 0.01, 'a'),
    ];
    const withGuarantee = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, { perEngineKeep: 1 });
    const plain = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR);
    expect(withGuarantee.kept.map((r) => r.url)).toEqual(plain.kept.map((r) => r.url));
  });

  it('without the option, behaves exactly like the plain floor (default off)', () => {
    const results = [
      e('https://a/1', 0.9, 'a'),
      e('https://b/1', 0.02, 'b'),
    ];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR);
    expect(kept.map((r) => r.url)).toEqual(['https://a/1']);
    expect(dropped.map((r) => r.url)).toEqual(['https://b/1']);
  });

  it('does NOT rescue a floored engine whose best result is genuine far-below-floor junk', () => {
    // The rescue is for correct-entity results that landed JUST below the floor,
    // not for an engine that returned only off-topic junk. An engine whose best
    // is far below the floor (< floor * min-fraction) stays dropped.
    const results = [
      e('https://a/1', 0.9, 'a'),
      e('https://junk/1', 0.006, 'junkengine'),
      e('https://junk/2', 0.004, 'junkengine'),
    ];
    const { kept, dropped } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, { perEngineKeep: 1 });
    const keptUrls = kept.map((r) => r.url);
    // Only the on-merit result survives; the junk engine is not rescued.
    expect(keptUrls).toEqual(['https://a/1']);
    expect(dropped.map((r) => r.url)).toEqual(['https://junk/1', 'https://junk/2']);
  });

  it('rescues a just-below-floor best but not a far-below-floor best from the SAME dominated set', () => {
    // Two floored-out engines: one has a plausibly-relevant result just below
    // the floor (rescued), the other only far-below-floor junk (dropped).
    const results = [
      e('https://top/1', 0.9, 'dominant'),
      e('https://close/1', 0.03, 'closeengine'),   // ~60% of the 0.05 floor → rescue
      e('https://faraway/1', 0.003, 'farengine'),  // ~6% of floor → junk, drop
    ];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, { perEngineKeep: 1 });
    const keptUrls = kept.map((r) => r.url);
    expect(keptUrls).toContain('https://close/1');
    expect(keptUrls).not.toContain('https://faraway/1');
  });

  it('preserves overall input order in the kept set after rescue', () => {
    // b/1 sits just below the floor but above the rescue-min (0.05*0.5=0.025),
    // so it is a plausibly-relevant rescue, not junk.
    const results = [
      e('https://a/1', 0.9, 'a'),
      e('https://b/1', 0.03, 'b'),
      e('https://a/2', 0.6, 'a'),
    ];
    const { kept } = applyScoreFloor(results, DEFAULT_SEARCH_SCORE_FLOOR, { perEngineKeep: 1 });
    // a/1 and a/2 survive on merit, b/1 is rescued; input order is preserved.
    expect(kept.map((r) => r.url)).toEqual(['https://a/1', 'https://b/1', 'https://a/2']);
  });
});
