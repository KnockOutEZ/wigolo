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

// Junk-floor guard: a result that shares NO rare/compound query term cannot
// ride the cross-encoder ALONE into the confidently-relevant tier-1 band. The
// guard is per-result (keyed on the rare-term hit/miss predicate) and uses the
// relative TIER band, not an absolute logit cut — reranker logits are
// miscalibrated per-query. It MUST NOT fire when the query has no rare terms,
// nor on a result that DOES contain the rare term.
describe('foldRerankIntoOrdering — junk-floor guard (no-shared-rare-term)', () => {
  function rr(url: string, score: number, title: string, snippet = ''): RawSearchResult {
    return { title, url, snippet, engine: 'test', relevance_score: score };
  }
  // rerank fn keyed on the TITLE's first token so fixtures can carry real text.
  function rerankByTitleToken(logitsByToken: Record<string, number>) {
    return async (_q: string, cands: { id: string; text: string }[]) => {
      const m = new Map<string, number>();
      for (const c of cands) {
        const firstToken = c.text.split('\n')[0].split(/\s+/)[0];
        m.set(c.id, logitsByToken[firstToken] ?? 0);
      }
      return m;
    };
  }

  it('POSITIVE: a compound-term query junk-miss cannot ride a high logit into tier-1', async () => {
    // Query carries the compound token "sqlite-vec". The junk result shares
    // NONE of the query's rare terms but the (gamed) reranker hands it a high
    // logit. The guard keeps it in tier-0 (< 0.5) so it can't monopolise slots.
    const results = [
      rr('https://github.com/asg017/sqlite-vec', 0.9, 'sqlite-vec vector search extension', 'knn queries with sqlite-vec'),
      rr('https://spam.example/deal', 0.5, 'buy cheap flights today', 'unrelated marketing copy'),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['sqlite-vec knn query'],
      rerank: rerankByTitleToken({ 'sqlite-vec': 5, buy: 9 }),
    });
    const junk = out.find((x) => x.url === 'https://spam.example/deal')!;
    // Despite the higher logit, the no-shared-rare-term junk stays tier-0.
    expect(junk.relevance_score).toBeLessThan(0.5);
    // The rare-term HIT keeps tier-1 even with a lower logit.
    const hit = out.find((x) => x.url.includes('sqlite-vec'))!;
    expect(hit.relevance_score).toBeGreaterThanOrEqual(0.5);
    expect(out[0].url).toContain('sqlite-vec');
  });

  it('NEGATIVE: a result that CONTAINS the compound term is NOT guarded (rides its logit to tier-1)', async () => {
    // Both results share the compound token — the guard must not fire on either.
    const results = [
      rr('https://a.example/vec', 0.5, 'sqlite-vec tutorial', 'about sqlite-vec'),
      rr('https://b.example/vec', 0.5, 'another sqlite-vec guide', 'sqlite-vec usage'),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['sqlite-vec knn query'],
      rerank: rerankByTitleToken({ 'sqlite-vec': 6, another: 8 }),
    });
    // Both share the rare term, both get a positive logit → both tier-1.
    for (const x of out) expect(x.relevance_score).toBeGreaterThanOrEqual(0.5);
  });

  it('NEGATIVE: a query with NO rare/compound terms leaves every result ungated', async () => {
    // Plain concept query without a compound token or a >=2-run concept phrase
    // match — the guard must be a no-op; a high-logit result still reaches tier-1.
    const results = [
      rr('https://x.example/1', 0.5, 'red widgets', 'about widgets'),
      rr('https://y.example/2', 0.5, 'blue gadgets', 'about gadgets'),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['color'],
      rerank: rerankByTitleToken({ red: 7, blue: 2 }),
    });
    // No rare term in the single-token query → nothing is guarded; the high
    // logit reaches tier-1.
    const top = out.find((x) => x.title.startsWith('red'))!;
    expect(top.relevance_score).toBeGreaterThanOrEqual(0.5);
  });

  it('NEGATIVE: a compound-free concept query does NOT gate — the reranker owns paraphrase', async () => {
    // A multi-word concept query with NO compound token must leave the guard a
    // no-op: a legitimate result phrased differently shares none of the literal
    // tokens, and suppressing it would defeat the cross-encoder's whole purpose.
    // A high-logit result reaches tier-1 even though it repeats no query token.
    const results = [
      rr('https://ok.example/a', 0.5, 'reciprocal rank fusion explained', 'reciprocal rank fusion method'),
      rr('https://para.example/b', 0.5, 'combining ranked lists by score sum', 'a paraphrase of the concept'),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['reciprocal rank fusion'],
      rerank: rerankByTitleToken({ reciprocal: 6, combining: 9 }),
    });
    // The paraphrase result rides its high logit to tier-1 — NOT guarded,
    // because the query has no compound token to gate on.
    const para = out.find((x) => x.url === 'https://para.example/b')!;
    expect(para.relevance_score).toBeGreaterThanOrEqual(0.5);
  });

  it('OVER-FIRE PROBE: a plain multi-word query with no compound token never gates synthetic-text results', async () => {
    // A realistic multi-word query with NO compound token (no hyphen / snake /
    // digit-suffix). Results with synthetic titles share none of its literal
    // tokens, yet the guard must NOT fire — the high-logit ONTOPIC result still
    // wins tier-1. This is the fresh over-fire probe for the compound-only gate.
    const results = [
      rr('https://off.example.com', 0.9, 'OFFTOPIC', 'unrelated filler'),
      rr('https://on.example.com', 0.1, 'ONTOPIC', 'the actual answer'),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['balanced rerank fold ordering'],
      rerank: rerankByTitleToken({ OFFTOPIC: -5, ONTOPIC: 5 }),
    });
    expect(out[0].url).toBe('https://on.example.com');
    expect(out[0].relevance_score).toBeGreaterThanOrEqual(0.5);
  });
});

// Blend-inflation guard (gate b): when EVERY raw logit is below the
// calibration floor (an all-junk batch — the reranker is confident nothing is
// relevant), the intra-tier min-max stretch would still hand the LEAST-bad junk
// a normalised rerank of 1.0, inflating its blend across the tier-0 band. The
// guard replaces the stretch with a neutral 0.5 blend so junk batches stop
// being stretched apart. Tier assignment from RAW logits is unchanged — this
// only touches the intra-tier blend value.
// Lexical gate (gate a): a result with ZERO lexical overlap with the query AND
// single-engine consensus (seen by exactly one engine) is forced to tier-0 —
// it cannot ride a gamed cross-encoder logit into the confidently-relevant
// band. The consensus conjunct is deliberate: a healthy multi-engine
// zero-lexical result (a synonym/paraphrase match several engines agree on) is
// NOT demoted. Gate is inert on empty / stopword-only queries.
describe('foldRerankIntoOrdering — lexical gate (zero-overlap single-engine junk)', () => {
  // Result carrying an explicit engine_consensus so the gate can read it. la is
  // recomputed inside the fold from the query+title+snippet, so fixture text
  // controls the lexical-alignment signal directly.
  // fakeRerank keys on the TITLE (rerankInputText puts title on the first
  // line), so fixtures carry distinct one-word title heads and key the logit
  // map on that head. rc() sets a zero lexical_alignment component (unused by
  // the gate — la is recomputed live — but present for shape realism) and an
  // explicit engine_consensus the gate reads.
  function rc(
    url: string,
    score: number,
    title: string,
    snippet: string,
    engine_consensus: number,
  ): RawSearchResult {
    return {
      title, url, snippet, engine: 'test', relevance_score: score,
      evidence_score: {
        final: score,
        components: {
          base_rrf: score, context_cosine: 0, domain_quality: 1,
          lexical_alignment: 0, recency_boost: 1, engine_consensus,
        },
        explanation: 'base',
      },
    };
  }
  function byTitleHead(logits: Record<string, number>) {
    return async (_q: string, cands: { id: string; text: string }[]) => {
      const m = new Map<string, number>();
      for (const c of cands) {
        const head = c.text.split('\n')[0].split(/\s+/)[0];
        m.set(c.id, logits[head] ?? 0);
      }
      return m;
    };
  }

  it('POSITIVE: a zero-lexical single-engine result cannot ride a high logit into tier-1', async () => {
    // The live-incident shape: an English tech query, a survivor engine returns
    // ONE off-topic result (a driving-school page) with ZERO shared query
    // tokens, seen by exactly one engine, handed a high (gamed) logit.
    const results = [
      rc('https://on.example/a', 0.5, 'kubernetes ingress controller setup', 'configure kubernetes ingress', 1),
      rc('https://junk.example/jp', 0.5, 'driving school reservation', 'lessons and pricing', 1),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['kubernetes ingress'],
      rerank: byTitleHead({ kubernetes: 4, driving: 9 }),
    });
    const junk = out.find((x) => x.url === 'https://junk.example/jp')!;
    expect(junk.relevance_score).toBeLessThan(0.5); // forced tier-0
    const hit = out.find((x) => x.url === 'https://on.example/a')!;
    expect(hit.relevance_score).toBeGreaterThanOrEqual(0.5);
    expect(out[0].url).toBe('https://on.example/a');
  });

  it('NEGATIVE: a zero-lexical result seen by MULTIPLE engines is NOT demoted (paraphrase case)', async () => {
    // The k8s/Kubernetes synonym case: a result whose surface text shares no
    // literal query token but several engines agree on (engine_consensus > 1).
    // The cross-encoder rightly promotes it and the gate must NOT fire.
    const results = [
      rc('https://para.example/syn', 0.5, 'container orchestration platform', 'manage clusters at scale', 3),
      rc('https://other.example/b', 0.5, 'kubernetes docs reference', 'k8s reference', 1),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['kubernetes'],
      rerank: byTitleHead({ container: 6, kubernetes: 1 }),
    });
    // Multi-engine zero-lexical result keeps its cross-encoder promotion.
    const para = out.find((x) => x.url === 'https://para.example/syn')!;
    expect(para.relevance_score).toBeGreaterThanOrEqual(0.5);
    expect(out[0].url).toBe('https://para.example/syn');
  });

  it('NEGATIVE: a single-engine result WITH lexical overlap is NOT demoted', async () => {
    // Shares a query token ("kubernetes") — not zero-lexical, so the gate is
    // inert regardless of consensus.
    const results = [
      rc('https://hit.example/a', 0.5, 'kubernetes networking guide', 'kubernetes cni', 1),
      rc('https://low.example/b', 0.5, 'unrelated storage topic', 'volumes', 1),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['kubernetes'],
      rerank: byTitleHead({ kubernetes: 5, unrelated: -3 }),
    });
    const hit = out.find((x) => x.url === 'https://hit.example/a')!;
    expect(hit.relevance_score).toBeGreaterThanOrEqual(0.5);
  });

  it('NEGATIVE: an empty query leaves the gate inert (fold short-circuits)', async () => {
    // No content tokens in the query -> the fold short-circuits empty queries,
    // so results are returned unchanged and nothing is demoted.
    const results = [
      rc('https://a.example/1', 0.5, 'anything here', 'body', 1),
      rc('https://b.example/2', 0.5, 'other text', 'body', 1),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: [''],
      rerank: byTitleHead({ anything: 5, other: 1 }),
    });
    const a = out.find((x) => x.url === 'https://a.example/1')!;
    expect(a.relevance_score).toBe(0.5); // unchanged, fold short-circuits empty queries
  });

  it('NEGATIVE: a stopword-only query leaves the gate inert', async () => {
    // Query is all stopwords -> zero content tokens -> lexicalAlignment 0 for
    // all. The gate must not fire; the high-logit result still reaches tier-1.
    const results = [
      rc('https://a.example/1', 0.5, 'kubernetes ingress', 'setup', 1),
      rc('https://b.example/2', 0.5, 'other content topic', 'body', 1),
    ];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['the what is of'],
      rerank: byTitleHead({ kubernetes: 5, other: -3 }),
    });
    const a = out.find((x) => x.url === 'https://a.example/1')!;
    expect(a.relevance_score).toBeGreaterThanOrEqual(0.5);
  });

  it('NEGATIVE: a zero-lexical single-engine result with NO evidence_score is NOT gated (fail-open)', async () => {
    // Consensus is unknown without evidence_score, so the gate must fail open:
    // it cannot assert single-engine consensus, so it does not demote.
    const results = [
      { title: 'driving school lessons', url: 'https://j.example/x', snippet: 'lessons', engine: 'test', relevance_score: 0.5 },
      { title: 'kubernetes ingress setup', url: 'https://k.example/y', snippet: 'setup', engine: 'test', relevance_score: 0.5 },
    ] as RawSearchResult[];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['kubernetes ingress'],
      rerank: byTitleHead({ driving: 5, kubernetes: 1 }),
    });
    // No evidence_score -> gate inert -> the high-logit (junk) result rides its
    // logit as it did before this gate existed.
    const junk = out.find((x) => x.url === 'https://j.example/x')!;
    expect(junk.relevance_score).toBeGreaterThanOrEqual(0.5);
  });
});

describe('foldRerankIntoOrdering — blend-inflation guard (all-below-calibration batch)', () => {
  it('an all-negative-logit batch is NOT stretched: no result gets a normalised rerank of 1.0', async () => {
    // Every logit is confidently-negative (junk). Old min-max would map the
    // largest (-6) to nr=1.0 and the smallest (-9) to nr=0.0, spreading junk
    // across the whole tier-0 band. The guard collapses the intra-tier blend to
    // the neutral 0.5 point so the least-bad junk is not inflated.
    const results = [r('A', 0.5), r('B', 0.5), r('C', 0.5)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ A: -6, B: -7.5, C: -9 }),
    });
    // No cross_encoder component may reach 1.0 (the stretched top of an
    // uncalibrated junk batch). Neutral 0.5 blend on all-junk.
    for (const x of out) {
      expect(x.evidence_score!.components.cross_encoder).toBeCloseTo(0.5, 6);
      // tier-0 (all logits below the tier margin) with a neutral 0.5 blend
      // maps to 0.5 * (0.5*composite + 0.5*0.5); it can never reach the top of
      // the tier-0 band the way a stretched nr=1.0 would.
      expect(x.relevance_score).toBeLessThan(0.5);
    }
  });

  it('BOUNDARY: a batch whose max logit sits AT the calibration floor is not treated as all-junk', async () => {
    // The gate fires only when EVERY logit is strictly below the floor. A batch
    // whose best logit is exactly at the floor still gets the normal stretch —
    // it is not an all-junk batch.
    const results = [r('A', 0.5), r('B', 0.5)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ A: 0, B: -4 }),
    });
    // A (at the floor) and B (well below) are stretched apart — A's normalised
    // rerank is the top of the range (1.0), NOT the neutral 0.5.
    const a = out.find((x) => x.url === 'A')!;
    expect(a.evidence_score!.components.cross_encoder).toBeCloseTo(1, 6);
  });

  it('MUST-NOT-FIRE: a batch with any above-floor logit is still stretched (wide range)', async () => {
    // A genuinely-relevant member (logit 5) plus junk (logit -8): the batch is
    // NOT all-junk, so the min-max stretch is preserved and the relevant member
    // reaches nr=1.0 as before.
    const results = [r('A', 0.5), r('B', 0.5)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ A: 5, B: -8 }),
    });
    const a = out.find((x) => x.url === 'A')!;
    expect(a.evidence_score!.components.cross_encoder).toBeCloseTo(1, 6);
    expect(a.relevance_score).toBeGreaterThanOrEqual(0.5); // still tier-1
  });

  it('MUST-NOT-FIRE: a tiny-but-real above-floor range is handled sanely (still stretched)', async () => {
    // Both logits are just above the floor with a narrow spread. The batch is
    // not all-junk, so the normal stretch applies (the higher logit -> nr=1.0)
    // and no NaN is produced.
    const results = [r('A', 0.5), r('B', 0.5)];
    const out = await foldRerankIntoOrdering(results, {
      queries: ['q'], rerank: fakeRerank({ A: 0.2, B: 0.1 }),
    });
    const a = out.find((x) => x.url === 'A')!;
    const b = out.find((x) => x.url === 'B')!;
    expect(Number.isNaN(a.relevance_score)).toBe(false);
    expect(Number.isNaN(b.relevance_score)).toBe(false);
    expect(a.evidence_score!.components.cross_encoder).toBeCloseTo(1, 6);
    expect(b.evidence_score!.components.cross_encoder).toBeCloseTo(0, 6);
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
    // Titles carry a query token ("topic") so the lexical gate is inert and
    // this test isolates the max-logit-across-queries hedge. rerank keys on the
    // title's SECOND token (the discriminating A/B/C word).
    const results = [
      r('A', 0.9, 'topic alpha'),
      r('B', 0.1, 'topic beta'),
      r('C', 0.5, 'topic gamma'),
    ];
    const rerank = async (q: string, cands: { id: string; text: string }[]) => {
      const m = new Map<string, number>();
      for (const c of cands) {
        const word = c.text.split('\n')[0].split(/\s+/)[1];
        if (word === 'gamma') m.set(c.id, -3);
        else if (q === 'q1 topic') m.set(c.id, word === 'alpha' ? 3 : -3);
        else m.set(c.id, word === 'beta' ? 3 : -3);
      }
      return m;
    };
    const out = await foldRerankIntoOrdering(results, { queries: ['q1 topic', 'q2 topic'], rerank });
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
