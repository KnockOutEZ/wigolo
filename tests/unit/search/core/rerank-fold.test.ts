import { describe, it, expect } from 'vitest';
import { foldRerankIntoOrdering } from '../../../../src/search/core/rerank-fold.js';
import type { RawSearchResult } from '../../../../src/types.js';

// Honest RawSearchResult — `engine` is required (types.ts). Do NOT use
// `as RawSearchResult`; tsc excludes tests/ and vitest strips types, so a
// missing required field would be invisible to both gates.
function r(url: string, score: number, title = url, snippet = ''): RawSearchResult {
  return {
    title,
    url,
    snippet,
    engine: 'test',
    relevance_score: score,
    evidence_score: {
      final: score,
      components: {
        base_rrf: score, context_cosine: 0, domain_quality: 1,
        lexical_alignment: 0.5, recency_boost: 1, engine_consensus: 1,
      },
      explanation: 'base',
    },
  };
}

// fake rerank: logit looked up by the title (we set title = url in fixtures)
function fakeRerank(logitsByUrl: Record<string, number>) {
  return async (_q: string, cands: { id: string; text: string }[]) => {
    const m = new Map<string, number>();
    for (const c of cands) {
      const url = c.text.split('\n')[0];
      m.set(c.id, logitsByUrl[url] ?? 0);
    }
    return m;
  };
}

describe('foldRerankIntoOrdering — rerank input includes URL/domain context', () => {
  it('passes the result domain into the candidate text so a short snippet cannot game the reranker', async () => {
    const seen: string[] = [];
    const capture = async (_q: string, cands: { id: string; text: string }[]) => {
      const m = new Map<string, number>();
      for (const c of cands) {
        seen.push(c.text);
        m.set(c.id, 1);
      }
      return m;
    };
    const results = [
      r('https://developer.mozilla.org/en-US/docs/Web/JavaScript', 0.9, 'Array.prototype.map', 'maps values'),
      r('https://spam.example/x', 0.1, 'buy now', 'cheap'),
    ];
    await foldRerankIntoOrdering(results, { queries: ['array map'], rerank: capture });
    // Each candidate's text carries its host so the domain is a rerank signal,
    // not just title+snippet.
    expect(seen.some((t) => t.includes('developer.mozilla.org'))).toBe(true);
    expect(seen.some((t) => t.includes('spam.example'))).toBe(true);
    // Title + snippet are still present.
    expect(seen.some((t) => t.includes('Array.prototype.map') && t.includes('maps values'))).toBe(true);
  });
});

describe('foldRerankIntoOrdering — bare-zero logit does not saturate to the tier-1 band', () => {
  it('an all-near-zero-logit (uncertain) batch stays out of [0.75,1.0]', async () => {
    // The junk-saturation case: every result has a logit at ~0 (sigmoid 0.5 =
    // "uncertain"), and the min-max normaliser returns the neutral 0.5. The old
    // tier gate (logit >= 0 -> tier 1) mapped these to 0.5 + 0.5*0.5 = 0.75.
    // A merely-uncertain result must NOT be promoted into the confidently-
    // relevant band.
    const results = [r('A', 0.5), r('B', 0.5)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ A: 0.0001, B: 0.0001 }),
    });
    for (const x of out) {
      expect(x.relevance_score).toBeLessThan(0.75);
    }
  });

  it('a bare-zero logit ranks below a genuinely positive-logit result', async () => {
    const results = [r('good', 0.5), r('bare', 0.9)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ good: 4, bare: 0.0001 }),
    });
    expect(out[0].url).toBe('good');
    expect(out[0].relevance_score).toBeGreaterThanOrEqual(0.5);
    // The bare-zero result is uncertain, not confidently relevant.
    expect(out.find((x) => x.url === 'bare')!.relevance_score).toBeLessThan(0.5);
  });

  it('a clearly-positive logit still lands in the tier-1 band [0.5,1.0]', async () => {
    // Guard the fix does not over-suppress: a real positive logit stays tier-1.
    const results = [r('A', 0.5), r('B', 0.5)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ A: 5, B: -5 }),
    });
    const a = out.find((x) => x.url === 'A')!;
    expect(a.relevance_score).toBeGreaterThanOrEqual(0.5);
  });
});

describe('foldRerankIntoOrdering', () => {
  it('a negative-logit result cannot outrank a positive-logit result even with max composite', async () => {
    const results = [r('A', 1.0), r('B', 0.01)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'],
      rerank: fakeRerank({ A: -2, B: +2 }),
    });
    expect(out.map((x) => x.url)).toEqual(['B', 'A']);
    expect(out[0].relevance_score).toBeGreaterThanOrEqual(0.5);
    expect(out[1].relevance_score).toBeLessThan(0.5);
    expect(out[0].relevance_score).toBeGreaterThan(out[1].relevance_score);
  });

  it('within a tier, higher blend ranks first; evidence carries cross_encoder + synced final', async () => {
    const results = [r('A', 0.5), r('B', 0.5)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'],
      rerank: fakeRerank({ A: 1, B: 5 }),
    });
    expect(out.map((x) => x.url)).toEqual(['B', 'A']);
    expect(out[0].evidence_score?.components.cross_encoder).toBeGreaterThan(
      out[1].evidence_score!.components.cross_encoder!,
    );
    expect(out[0].evidence_score?.final).toBe(out[0].relevance_score);
  });

  it('uses max logit across queries — A relevant to q1, B to q2, both outrank always-negative C', async () => {
    const results = [r('A', 0.9), r('B', 0.1), r('C', 0.5)];
    const rerank = async (q: string, cands: { id: string; text: string }[]) => {
      const m = new Map<string, number>();
      for (const c of cands) {
        const url = c.text.split('\n')[0];
        if (url === 'C') m.set(c.id, -3);
        else if (q === 'q1') m.set(c.id, url === 'A' ? 3 : -3);
        else m.set(c.id, url === 'B' ? 3 : -3);
      }
      return m;
    };
    const out = await foldRerankIntoOrdering(results, { queries: ['q1', 'q2'], rerank });
    // A (relevant to q1) and B (relevant to q2) both keep tier-1 via max-over-queries;
    // C is negative for every query so it falls to tier-0 and sorts last. A
    // queries[0]-only impl would push B below C.
    expect(out[out.length - 1].url).toBe('C');
    expect(out[0].relevance_score).toBeGreaterThanOrEqual(0.5);
    expect(out[1].relevance_score).toBeGreaterThanOrEqual(0.5);
    expect(out[2].relevance_score).toBeLessThan(0.5);
  });

  it('a candidate the rerank fn never scores -> tier-0 (irrelevant), sorts last', async () => {
    const results = [r('A', 0.5), r('B', 0.5)];
    // injected fn scores only id '0' (A); B's id is absent from the map.
    const rerank = async (_q: string, cands: { id: string; text: string }[]) => {
      const m = new Map<string, number>();
      for (const c of cands) {
        if (c.id === '0') m.set(c.id, 5);
      }
      return m;
    };
    const out = await foldRerankIntoOrdering(results, { queries: ['q'], rerank });
    expect(out.map((x) => x.url)).toEqual(['A', 'B']);
    expect(out[0].relevance_score).toBeGreaterThanOrEqual(0.5);
    expect(out[1].relevance_score).toBeLessThan(0.5);
  });

  it('rerank throwing -> input ordering preserved, no throw', async () => {
    const results = [r('A', 0.9), r('B', 0.1)];
    const rerank = async () => { throw new Error('model down'); };
    const out = await foldRerankIntoOrdering(results, { queries: ['q'], rerank });
    expect(out.map((x) => x.url)).toEqual(['A', 'B']);
    expect(out[0].relevance_score).toBe(0.9);
  });

  it('flat/degenerate logits -> no reorder, no NaN', async () => {
    const results = [r('A', 0.9), r('B', 0.5), r('C', 0.1)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ A: 2, B: 2, C: 2 }),
    });
    expect(out.map((x) => x.url)).toEqual(['A', 'B', 'C']);
    for (const x of out) expect(Number.isNaN(x.relevance_score)).toBe(false);
  });

  it('single result -> returned unchanged', async () => {
    const results = [r('A', 0.9)];
    const out = await foldRerankIntoOrdering(results, { queries: ['q'], rerank: fakeRerank({ A: -9 }) });
    expect(out.map((x) => x.url)).toEqual(['A']);
  });

  it('balanced window bounds rerank to max(maxResults,20); deep reranks the full list', async () => {
    const results = Array.from({ length: 25 }, (_, i) => r(`U${i}`, (25 - i) / 25));
    const logits: Record<string, number> = {};
    for (let i = 0; i < 25; i++) logits[`U${i}`] = -1;
    logits['U24'] = 10;
    const bal = await foldRerankIntoOrdering(results, {
      queries: ['q'], maxResults: 10, rerank: fakeRerank(logits),
    });
    expect(bal[bal.length - 1].url).toBe('U24');
    const deep = await foldRerankIntoOrdering(results, {
      queries: ['q'], deep: true, maxResults: 10, rerank: fakeRerank(logits),
    });
    expect(deep[0].url).toBe('U24');
  });

  it('undefined max_results -> full-list rerank (effectiveMax = len, no tail ships)', async () => {
    const results = Array.from({ length: 25 }, (_, i) => r(`U${i}`, (25 - i) / 25));
    const logits: Record<string, number> = {};
    for (let i = 0; i < 25; i++) logits[`U${i}`] = -1;
    logits['U24'] = 10;
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank(logits),
    });
    expect(out[0].url).toBe('U24');
  });

  it('post-merge invariant: a tier-0 result a 2nd query ranked #1 still sorts below tier-1', async () => {
    const results = [r('B', 1.0), r('A', 0.2)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ B: -4, A: +4 }),
    });
    expect(out.map((x) => x.url)).toEqual(['A', 'B']);
  });
});
