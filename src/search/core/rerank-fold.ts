import type { RawSearchResult, EvidenceScore } from '../../types.js';
import { getRerankProvider } from '../../providers/rerank-provider.js';
import { detectRareTerms, isRareTermMiss } from './rare-terms.js';
import { lexicalAlignment } from './lexical-alignment.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

export const RERANK_WINDOW = 20;
export const RERANK_RELEVANCE_THRESHOLD = 0;
// A cross-encoder logit at ~0 is the sigmoid midpoint (p≈0.5) — the model is
// UNCERTAIN, not confidently relevant. Tier-1 (the [0.5,1.0] confidently-
// relevant band) requires a logit meaningfully ABOVE zero by this margin, so a
// bare-zero/near-zero logit falls to tier-0 instead of being promoted. Without
// this, an all-near-zero (all-junk) batch — where the normaliser returns the
// neutral 0.5 — mapped every result to 0.5 + 0.5*0.5 = 0.75 (junk saturation).
export const RERANK_TIER_MARGIN = 0.5;
export const RERANK_BLEND_COMPOSITE = 0.5;
export const RERANK_BLEND_RERANK = 0.5;
// Blend-inflation calibration floor. A cross-encoder logit at/above 0 is the
// sigmoid midpoint or better — the model is at least uncertain-leaning-relevant.
// When the WHOLE batch's best logit is strictly below this floor, every member
// is confidently-irrelevant junk: the intra-tier min-max stretch would still
// award the least-bad junk a normalised rerank of 1.0 and spread the batch
// across the tier-0 band. In that all-junk case the stretch is meaningless, so
// the rerank normaliser collapses to a neutral 0.5. Tier assignment (from raw
// logits vs RERANK_RELEVANCE_THRESHOLD + RERANK_TIER_MARGIN) is unchanged.
export const RERANK_CALIBRATION_FLOOR = RERANK_RELEVANCE_THRESHOLD;

// Build the cross-encoder input for one result. Title + snippet ALONE let a
// short off-topic snippet game the reranker into a high logit (the junk-
// saturation bug); appending the host gives the model the domain as an extra
// relevance signal (a dictionary/glossary host reads differently from a docs
// host). Shared by the fold path and the legacy path so both encode identically.
export function rerankInputText(title: string, snippet: string | undefined, url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    host = '';
  }
  const parts = [title ?? '', snippet ?? ''];
  if (host) parts.push(host);
  return parts.join('\n').trim();
}

/** Injectable: given a query + candidates, return id -> raw logit. */
export type RerankFn = (
  query: string,
  candidates: { id: string; text: string }[],
) => Promise<Map<string, number>>;

/**
 * Why the rerank blend contributed NO ordering signal to this result set.
 *
 * All three collapse the blend to a flat 0.5 for EVERY member, which is why the
 * emitted `cross_encoder` component cannot be used to tell them apart — nor to
 * tell any of them apart from a middling result whose score legitimately
 * normalises to 0.5 in a healthy spread. The reason is therefore captured HERE,
 * at the only place that still knows which branch ran.
 *
 *  - `unavailable`      the reranker threw, so it never scored anything. The
 *                       fold returns the composite ordering untouched and no
 *                       `cross_encoder` component is emitted at all.
 *  - `no_relevant_match` the reranker RAN and scored every candidate below the
 *                       relevance floor — it judged the whole set irrelevant.
 *                       The verdict is discarded and the base ordering ships.
 *  - `uniform_scores`   the reranker RAN and returned bit-identical scores, so
 *                       the min-max stretch is degenerate. Indistinguishable
 *                       from a genuine tie, so it asserts nothing about
 *                       relevance and renders NO user-facing notice.
 */
export type RerankSignalReason = 'unavailable' | 'no_relevant_match' | 'uniform_scores';

export interface RerankFoldSignal {
  reason: RerankSignalReason;
  /** How many results the neutralised blend covered (the rerank window). */
  window: number;
  /** Best raw relevance score in the window. Absent when the reranker never ran. */
  max_score?: number;
}

export interface FoldOptions {
  queries: string[];
  deep?: boolean;
  maxResults?: number;
  rerank?: RerankFn;
  /**
   * Called at most once per fold when the rerank blend carried no ordering
   * signal for the window. Never called on a healthy rerank, so a caller can
   * treat any invocation as "this result set is ordered by the base ranking".
   */
  onSignal?: (signal: RerankFoldSignal) => void;
}

/** Response field carrying the user-facing ranking notice. Single source of
 * truth: the provider assigns through it and the instruction-sync test asserts
 * the shipped signal list names it, so a rename cannot silently drift. */
export const RANKING_NOTICE_FIELD = 'ranking_notice';

/**
 * User-facing text per reason, in capability language.
 *
 * `uniform_scores` is deliberately ABSENT. A uniform score set is exactly what a
 * genuine tie looks like — the reranker judging every result equally relevant is
 * bit-identical to the degenerate case — so a notice there would assert a cause
 * we cannot know. Same discipline as `buildPoolAlternatives`, which fires on
 * `pool_collapsed` alone and never on the common, benign `degraded`.
 */
const RANKING_NOTICE_TEXT: Partial<Record<RerankSignalReason, string>> = {
  unavailable:
    'Reranking did not run for this search, so these results carry only the base cross-engine ranking and were never re-scored for how well they answer the query. Ordering reflects which results the search engines agreed on, not which are most relevant.',
  no_relevant_match:
    'The ML reranker scored every result in this set below its relevance floor — it found nothing here that genuinely matches the query. Ordering fell back to the base cross-engine ranking, so the top result is the most agreed-upon, not the most relevant. Treat these results as low-confidence and consider rephrasing with more specific or less ambiguous terms.',
};

/** The user-facing notice for a signal, or undefined when the reason renders none. */
export function buildRankingNotice(signal: RerankFoldSignal): string | undefined {
  return RANKING_NOTICE_TEXT[signal.reason];
}

/** Reasons that render a user-facing notice (drives the instruction-sync test). */
export const RANKING_NOTICE_REASONS = Object.keys(RANKING_NOTICE_TEXT) as RerankSignalReason[];

function defaultRerankFn(): RerankFn {
  return async (query, candidates) => {
    const provider = await getRerankProvider();
    const scored = await provider.rerank(query, candidates, candidates.length);
    const m = new Map<string, number>();
    for (const s of scored) m.set(s.id, s.score);
    return m;
  };
}

// min-max normaliser; degenerate (size<=1 or flat) -> neutral 0.5 so a flat
// batch falls back to composite ordering instead of dividing by zero.
function makeNormaliser(values: number[]): (v: number) => number {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  if (!Number.isFinite(range) || range === 0) return () => 0.5;
  return (v: number) => (v - min) / range;
}

export async function foldRerankIntoOrdering(
  results: RawSearchResult[],
  opts: FoldOptions,
): Promise<RawSearchResult[]> {
  if (results.length <= 1) return results;
  const queries = opts.queries.filter((q) => typeof q === 'string' && q.trim().length > 0);
  if (queries.length === 0) return results;

  const effectiveMax = opts.maxResults ?? results.length;
  const windowSize = opts.deep
    ? results.length
    : Math.min(results.length, Math.max(effectiveMax, RERANK_WINDOW));

  const windowResults = results.slice(0, windowSize);
  const tail = results.slice(windowSize);

  const candidates = windowResults.map((res, i) => ({
    id: String(i),
    text: rerankInputText(res.title, res.snippet, res.url),
  }));

  const rerankFn = opts.rerank ?? defaultRerankFn();

  // max logit per candidate across all queries -> preserves multi-query hedge.
  const logits = new Array<number>(windowResults.length).fill(-Infinity);
  try {
    for (const q of queries) {
      const scoreMap = await rerankFn(q, candidates);
      for (let i = 0; i < windowResults.length; i++) {
        const s = scoreMap.get(String(i));
        if (typeof s === 'number' && s > logits[i]) logits[i] = s;
      }
    }
  } catch (err) {
    log.debug('rerank-fold failed, keeping composite ordering', { error: String(err) });
    // The literal "the reranker did not run" case. It returns early WITHOUT a
    // cross_encoder component, so nothing downstream could ever have inferred
    // it from the emitted scores — the signal is the only trace.
    opts.onSignal?.({ reason: 'unavailable', window: windowResults.length });
    return results;
  }
  // candidates the provider never scored -> treat as irrelevant (below the
  // tier threshold), not relevant. Only bites a misbehaving injected rerank
  // fn; the default provider scores every candidate (topK = candidates.length).
  for (let i = 0; i < logits.length; i++) {
    if (!Number.isFinite(logits[i])) logits[i] = RERANK_RELEVANCE_THRESHOLD - 1;
  }

  const normComposite = makeNormaliser(windowResults.map((res) => res.relevance_score));
  // Blend-inflation guard (gate b): if the batch's best logit is strictly below
  // the calibration floor, every member is confident junk — the min-max stretch
  // is meaningless and would only inflate the least-bad junk. Use a neutral 0.5
  // rerank blend for the whole batch instead. Otherwise stretch normally.
  const maxLogit = Math.max(...logits);
  const allJunk = Number.isFinite(maxLogit) && maxLogit < RERANK_CALIBRATION_FLOOR;
  const normRerank = allJunk ? () => 0.5 : makeNormaliser(logits);

  // Report a neutralised blend to the caller. Keyed on the SOURCE branch, never
  // on the emitted 0.5 — that value is ambiguous by construction (see
  // RerankSignalReason). The two branches are mutually exclusive: `allJunk`
  // tests the absolute verdict level, so a tie is only reachable below it.
  if (allJunk) {
    opts.onSignal?.({
      reason: 'no_relevant_match',
      window: windowResults.length,
      max_score: maxLogit,
    });
  } else if (maxLogit - Math.min(...logits) === 0) {
    opts.onSignal?.({
      reason: 'uniform_scores',
      window: windowResults.length,
      max_score: maxLogit,
    });
  }

  // Junk-floor guard: a result that shares NONE of the query's rare COMPOUND
  // terms cannot ride the cross-encoder ALONE into the confidently-relevant
  // tier-1 band. Reranker logits are miscalibrated per-query, so a short junk
  // snippet can game a high logit; without a shared high-IDF compound token
  // (hyphenated / snake_case / digit-suffixed — genuinely rare by shape) that
  // logit is not trustworthy evidence of relevance. Per-result (keyed on the
  // rare-term hit/miss predicate) and expressed on the relative TIER band, not
  // an absolute logit cut (reranker logits are miscalibrated per-query).
  //
  // COMPOUND-only on purpose: the concept-phrase branch fires for nearly every
  // multi-word query and a legitimate paraphrased result shares none of its
  // literal tokens — gating on it would suppress exactly the semantic-match
  // cases the cross-encoder exists to catch. Compound tokens are high-precision:
  // a result lacking the query's compound is almost certainly off-topic. A
  // no-op when no query variant carries a compound token, so ordinary queries
  // are untouched. Detected per-variant + unioned: a result matching ANY
  // variant's compound is a HIT and stays ungated.
  const rareCompoundPerQuery = queries.map((q) => {
    const rare = detectRareTerms(q);
    // Zero out the concept phrase so isRareTermMiss keys ONLY on compounds.
    return { compoundTokens: rare.compoundTokens, conceptPhrase: null };
  });
  const queryHasCompound = rareCompoundPerQuery.some((r) => r.compoundTokens.length > 0);

  // Lexical gate (gate a): force tier-0 for a result with ZERO lexical overlap
  // against every query variant AND single-engine consensus (seen by exactly
  // one engine). Zero overlap with a single-engine consensus is the live-
  // incident junk shape (a degraded pool's lone survivor returns an off-topic
  // page sharing NO query token). The consensus conjunct protects a healthy
  // multi-engine zero-lexical (synonym/paraphrase) result, which several
  // engines agreeing on is trustworthy. Inert on empty/stopword-only queries:
  // when NO variant carries a content token, lexicalAlignment is 0 for every
  // result by construction, so the gate would demote everything — we skip it.
  const queryHasContentToken = queries.some(
    (q) => lexicalAlignment(q, q, '') > 0,
  );

  const scored = windowResults.map((res, i) => {
    const logitTier = logits[i] > RERANK_RELEVANCE_THRESHOLD + RERANK_TIER_MARGIN ? 1 : 0;
    // Guarded to tier-0 only when the query carries a compound token AND this
    // result matches NONE of them across every query variant (a true miss).
    const rareMiss =
      queryHasCompound && rareCompoundPerQuery.every((r) => isRareTermMiss(res, r));
    // Zero lexical overlap against ALL query variants -> lexicalMiss. Max over
    // variants: a result aligned with ANY variant is not a miss.
    const maxLexical = queryHasContentToken
      ? Math.max(...queries.map((q) => lexicalAlignment(q, res.title, res.snippet)))
      : 1;
    // engine_consensus is only trustworthy when the evidence components carry
    // it; without it the gate fails open (cannot assert single-engine).
    const consensus = res.evidence_score?.components.engine_consensus;
    const singleEngine = consensus === 1;
    const lexicalMiss = queryHasContentToken && maxLexical === 0 && singleEngine;
    const tier = rareMiss || lexicalMiss ? 0 : logitTier;
    const nr = normRerank(logits[i]);
    const blend =
      RERANK_BLEND_COMPOSITE * normComposite(res.relevance_score) +
      RERANK_BLEND_RERANK * nr;
    return { res, tier, blend, nr };
  });

  scored.sort((a, b) => b.tier - a.tier || b.blend - a.blend);

  const reordered = scored.map((s) => {
    // tier-encoded so relevance_score is monotonic with row order: tier-1 maps
    // to [0.5,1], tier-0 to [0,0.5]. A caller re-sorting by score can't undo
    // the fold.
    const finalScore = s.tier === 1 ? 0.5 + 0.5 * s.blend : 0.5 * s.blend;
    const prev = s.res.evidence_score;
    const evidence_score: EvidenceScore | undefined = prev
      ? {
          ...prev,
          final: finalScore,
          components: { ...prev.components, cross_encoder: s.nr },
          explanation: `${prev.explanation}, xenc=${s.nr.toFixed(2)}`,
        }
      : prev;
    return {
      ...s.res,
      relevance_score: finalScore,
      ...(evidence_score ? { evidence_score } : {}),
    };
  });

  // tail keeps composite order + scores; it never ships because windowSize is
  // always >= the slice ship-count (effectiveMax). Kept for non-slicing callers.
  return [...reordered, ...tail];
}
