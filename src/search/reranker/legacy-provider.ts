import type {
  RerankProvider,
  RerankCandidate,
  RerankResult,
} from '../../providers/rerank-provider.js';
import { onnxRerank } from './onnx.js';
import { resolveModelId } from './models.js';
import { getConfig } from '../../config.js';

/**
 * Legacy rerank adapter — wraps the existing ONNX-via-subprocess reranker.
 * Translates the {id,text} candidate shape to the underlying {text}[] +
 * index-keyed score array, then re-projects scores onto candidate ids and
 * optionally truncates to topK. Behavior is otherwise unchanged.
 *
 * Note: this adapter intentionally does NOT apply the recency/authority/
 * consensus boosts from `rerankResults()` in `search/rerank.ts` — those
 * operate on `MergedSearchResult` (url + published_date + engines), which
 * is richer than the {id,text} contract here. Phase 4 will revisit whether
 * boosts live in the provider or stay in the search pipeline.
 */
export class LegacyRerankProvider implements RerankProvider {
  get modelId(): string {
    return resolveModelId(getConfig().rerankerModel ?? 'bge-reranker-v2-m3');
  }

  async rerank(
    query: string,
    candidates: RerankCandidate[],
    topK?: number,
  ): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    const scores = await onnxRerank(
      query,
      candidates.map((c) => ({ text: c.text })),
    );
    const projected = scores.map((s) => ({
      id: candidates[s.index].id,
      score: s.score,
    }));
    return typeof topK === 'number' ? projected.slice(0, topK) : projected;
  }
}
