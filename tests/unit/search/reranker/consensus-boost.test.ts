import { describe, expect, it } from 'vitest';
import { applyConsensusBoost } from '../../../../src/search/reranker/consensus-boost.js';
import type { MergedSearchResult } from '../../../../src/search/dedup.js';

function mk(url: string, engines: string[], score = 0.5): MergedSearchResult {
  return { title: url, url, snippet: '', relevance_score: score, engines };
}

describe('applyConsensusBoost', () => {
  it('returns input unchanged when all results have a single engine', () => {
    const out = applyConsensusBoost([mk('https://a.test', ['bing'])]);
    expect(out[0].relevance_score).toBeCloseTo(0.5);
  });

  it('applies progressive boost as engine-count rises', () => {
    const out = applyConsensusBoost([
      mk('https://one.test', ['bing']),
      mk('https://two.test', ['bing', 'ddg']),
      mk('https://three.test', ['bing', 'ddg', 'wikipedia']),
      mk('https://four.test', ['bing', 'ddg', 'wikipedia', 'searxng']),
    ]);
    expect(out[0].relevance_score).toBeCloseTo(0.5);
    expect(out[1].relevance_score).toBeCloseTo(0.55);
    expect(out[2].relevance_score).toBeCloseTo(0.60);
    expect(out[3].relevance_score).toBeCloseTo(0.62);
  });

  it('caps boost at 4+ engines', () => {
    const four = applyConsensusBoost([mk('https://x.test', ['a', 'b', 'c', 'd'])]);
    const five = applyConsensusBoost([mk('https://x.test', ['a', 'b', 'c', 'd', 'e'])]);
    expect(five[0].relevance_score).toBeCloseTo(four[0].relevance_score);
  });

  it('deduplicates engine names case-insensitively before counting', () => {
    const out = applyConsensusBoost([mk('https://x.test', ['Bing', 'bing', 'BING'])]);
    expect(out[0].relevance_score).toBeCloseTo(0.5);
  });

  it('clamps relevance_score at 1.0', () => {
    const out = applyConsensusBoost([mk('https://x.test', ['a', 'b', 'c', 'd'], 0.95)]);
    expect(out[0].relevance_score).toBeLessThanOrEqual(1);
  });

  it('handles empty input', () => {
    expect(applyConsensusBoost([])).toEqual([]);
  });

  it('does not depend on query content — pure consensus signal', () => {
    const r = mk('https://x.test', ['a', 'b', 'c']);
    const a = applyConsensusBoost([r]);
    const b = applyConsensusBoost([{ ...r }]);
    expect(a[0].relevance_score).toBeCloseTo(b[0].relevance_score);
  });
});
