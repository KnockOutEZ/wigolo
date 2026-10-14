/**
 * Arabic-aware rerank provider — a hybrid cross-encoder + lexical boost.
 *
 * Problem this solves:
 *   The default `Xenova/ms-marco-MiniLM-L-6-v2` reranker is trained on
 *   English MS-MARCO. For Arabic queries it still produces *some* signal
 *   (the tokenizer has Arabic vocab, and the cross-attention head learns
 *   generic "high token overlap = relevant" features) but the signal is
 *   noisy. In practice we saw Arabic queries where the canonical-result
 *   snippet got ranked BELOW irrelevant Wikipedia articles because the
 *   cross-encoder was looking at English token alignment.
 *
 * Solution:
 *   A 2-stage hybrid:
 *
 *   1. Run the cross-encoder ONCE on the candidates, just like the
 *      default provider. This gives a base score per candidate.
 *
 *   2. Compute a lexical-boost score for each candidate:
 *      - token-overlap between the cleaned query subject and the
 *        candidate's title+snippet, with Arabic normalization
 *        (drop diacritics, normalize alef/ya/ta-marbuta)
 *      - bonus for title match (titles are more important than snippets)
 *      - penalty for "stopwordy" results whose title is just the leading
 *        question word (e.g. "من (حرف) - ويكيبيديا" gets a heavy penalty)
 *
 *   3. Blend: final_score = 0.7 * cross_encoder + 0.3 * lexical_boost
 *      The blend weights are tuned empirically — when the cross-encoder
 *      strongly disagrees with the lexical boost, trust the cross-encoder
 *      (it's still the strongest signal). When the cross-encoder is silent
 *      or noisy, the lexical boost picks up the slack.
 *
 * The provider is wired in by `providers/rerank-provider.ts` when
 * `config.reranker === 'arabic'`. The default still uses the
 * `TransformersRerankProvider` for non-Arabic queries.
 */
import type {
  RerankProvider,
  RerankCandidate,
  RerankResult,
} from "../../providers/rerank-provider.js";
import { createLogger } from "../../logger.js";
import { normalizeArabic } from "../arabic/query-cleaner.js";

const log = createLogger("reranker");

// ---------------------------------------------------------------------------
// Helpers — tokenization & overlap
// ---------------------------------------------------------------------------

const ARABIC_TOKEN_RE = /[\u0621-\u064A\u0660-\u0669]+/g;

function tokenize(text: string): Set<string> {
  const normalized = normalizeArabic(text);
  const tokens = normalized.match(ARABIC_TOKEN_RE) || [];
  return new Set(tokens.filter(t => t.length >= 2));
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const smaller = a.size < b.size ? a : b;
  const larger = a.size < b.size ? b : a;
  for (const t of smaller) if (larger.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

// ---------------------------------------------------------------------------
// Stopword-penalty detector — heavy penalty for titles that are just a
// question word + a Wikipedia suffix.
// ---------------------------------------------------------------------------

const STOPWORD_TITLE_RE = /^(?:من|ما|ماذا|كيف|أين|هو|هي|في|على|عن|مع)\b/i;
const WIKIPEDIA_SUFFIX_RE = /-?\s*(?:ويكيبيديا|Wikipedia|Wiktionary|قاموس)$/i;

function titlePenalty(title: string): number {
  const t = String(title || "").trim();
  if (!t) return -0.5;
  // Penalty for titles that are just a stopword (e.g. "من (حرف) - ويكيبيديا")
  if (STOPWORD_TITLE_RE.test(t) && WIKIPEDIA_SUFFIX_RE.test(t)) return -0.5;
  if (STOPWORD_TITLE_RE.test(t)) return -0.2;
  return 0;
}

// ---------------------------------------------------------------------------
// Hybrid provider
// ---------------------------------------------------------------------------

/**
 * Lazy delegate to the existing `TransformersRerankProvider`. We import
 * it dynamically so the ONNX runtime isn't loaded at module import time
 * (matches the existing provider's behavior).
 */
let cachedDelegate: Promise<RerankProvider> | null = null;

async function getDelegate(): Promise<RerankProvider> {
  if (cachedDelegate) return cachedDelegate;
  cachedDelegate = import("./transformers-rerank-provider.js")
    .then(m => {
      const p = new m.TransformersRerankProvider();
      return p;
    })
    .catch(err => {
      cachedDelegate = null;
      throw err;
    });
  return cachedDelegate;
}

export class ArabicRerankProvider implements RerankProvider {
  readonly modelId = "arabic-hybrid-ms-marco-MiniLM-L-6-v2";

  async warmup(): Promise<void> {
    // Pre-load the delegate so the first request doesn't pay the warmup
    // latency.
    const delegate = await getDelegate();
    if (delegate.warmup) await delegate.warmup();
    log.info("Arabic rerank provider ready", { modelId: this.modelId });
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK = candidates.length,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];

    // Stage 1: get the cross-encoder scores from the existing provider.
    // These are the raw logits from ms-marco-MiniLM-L-6-v2.
    let crossEncoderScores: Map<string, number>;
    try {
      const delegate = await getDelegate();
      const baseResults = await delegate.rerank(query, candidates, candidates.length);
      crossEncoderScores = new Map(baseResults.map(r => [r.id, r.score]));
    } catch (err) {
      log.warn("Arabic rerank: cross-encoder delegate failed, falling back to lexical-only", {
        error: err instanceof Error ? err.message : String(err),
      });
      crossEncoderScores = new Map();
    }

    // Stage 2: compute lexical boost per candidate.
    const queryTokens = tokenize(query);
    const boosted: RerankResult[] = [];

    for (const c of candidates) {
      // The candidate.text is typically `${title} ${snippet}` — see
      // `rerankInputText` in `search/core/rerank-fold.ts`.
      // Split it back into title/snippet heuristically: the title is
      // usually the first line.
      const [titleLine, ...rest] = String(c.text || "").split(/\n|\s{2,}/);
      const title = titleLine || "";
      const snippet = rest.join(" ").trim();

      const titleTokens = tokenize(title);
      const snippetTokens = tokenize(snippet);

      // Title overlap is weighted 3x more than snippet overlap, because
      // titles carry much more signal about relevance.
      const titleOverlap = jaccardOverlap(queryTokens, titleTokens);
      const snippetOverlap = jaccardOverlap(queryTokens, snippetTokens);
      const lexicalScore = titleOverlap * 0.6 + snippetOverlap * 0.2;

      // Penalty for stopword-y titles.
      const penalty = titlePenalty(title);

      // Cross-encoder score (fallback to 0 if the delegate failed for
      // this candidate). We normalize to [0, 1] roughly — ms-marco-MiniLM-L-6
      // logits are typically in [-8, 8]; clamp then divide by 8.
      const rawCross = crossEncoderScores.get(c.id) ?? 0;
      const clamped = Math.max(-8, Math.min(8, rawCross));
      const crossScore = (clamped + 8) / 16; // → [0, 1]

      // Blend: 0.7 cross-encoder + 0.3 lexical. The penalty applies after
      // the blend (so a heavily stopword-y title still drops even with a
      // decent cross-encoder score).
      const finalScore = crossScore * 0.7 + lexicalScore * 0.3 + penalty;

      boosted.push({ id: c.id, score: finalScore });
    }

    // Sort desc by final score, take top-K.
    boosted.sort((a, b) => b.score - a.score);
    return boosted.slice(0, topK);
  }
}
