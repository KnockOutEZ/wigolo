/**
 * Rerank provider interface — Phase 1 Task 1.3 of v1 engine overhaul.
 *
 * Wraps the existing ONNX-via-subprocess reranker (with recency/authority/
 * consensus boosts) behind a stable interface. The factory always returns
 * the legacy adapter today; Phase 4 swaps in the v1 implementation.
 */
export interface RerankCandidate {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface RerankProvider {
  rerank(
    query: string,
    candidates: RerankCandidate[],
    topK?: number,
  ): Promise<RerankResult[]>;
  /** Model identifier (for cache invalidation / provenance). */
  readonly modelId: string;
}

let cached: Promise<RerankProvider> | null = null;

export function getRerankProvider(): Promise<RerankProvider> {
  if (cached) return cached;
  cached = import('../search/reranker/legacy-provider.js').then(
    m => new m.LegacyRerankProvider(),
    err => { cached = null; throw err; },
  );
  return cached;
}

export function _resetRerankProviderForTest(): void {
  cached = null;
}
