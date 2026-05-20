/**
 * Rerank provider interface — Phase 1 Task 1.3 of v1 engine overhaul.
 *
 * Phase 4 Part A switches the default factory to TransformersRerankProvider
 * (Transformers.js cross-encoder, in-process ONNX runtime). The legacy
 * Python FlashRank adapter still exists in `search/reranker/legacy-provider.ts`
 * pending Phase 4 Part B deletions, but it is no longer wired in.
 */
import { createLogger } from '../logger.js';

const log = createLogger('providers');
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
  cached = import('../search/reranker/transformers-rerank-provider.js')
    .then(async (m) => {
      const p = new m.TransformersRerankProvider();
      await p.warmup();
      log.info('rerank provider ready', {
        provider: 'rerank',
        impl: 'transformers',
        modelId: p.modelId,
      });
      return p;
    })
    .catch((err) => {
      cached = null;
      throw err;
    });
  return cached;
}

export function _resetRerankProviderForTest(): void {
  cached = null;
}
