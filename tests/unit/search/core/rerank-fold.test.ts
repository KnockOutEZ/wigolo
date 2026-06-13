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
