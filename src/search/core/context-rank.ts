// Context-aware re-ranking.
//
// Re-scores RawSearchResult[] using cosine similarity against an embedded
// `query + agent context` vector. Maps cosine ∈ [-1, 1] to a multiplier in
// [min, max] and rescales relevance_score. Embedding failures are non-fatal:
// on any error the input array is returned unchanged.

import type { RawSearchResult } from '../../types.js';
import { getEmbedProvider } from '../../providers/embed-provider.js';
import { createLogger } from '../../logger.js';

const log = createLogger('search');

export interface ContextRankOptions {
  /** Multiplier range; results closer to context vector get higher boost. */
  minMultiplier?: number;
  maxMultiplier?: number;
}

const DEFAULT_MIN_MULTIPLIER = 0.8;
const DEFAULT_MAX_MULTIPLIER = 1.2;

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function mapCosineToMultiplier(cos: number, min: number, max: number): number {
  const clamped = cos < -1 ? -1 : cos > 1 ? 1 : cos;
  return min + (max - min) * (clamped + 1) / 2;
}

/**
 * Re-score results using cosine similarity vs the embedded query+context.
 * Returns a new array; does NOT mutate input. Returns input unchanged when
 * contextText is empty, the embed provider is unavailable, or embedding fails.
 */
export async function applyContextRank(
  results: RawSearchResult[],
  query: string,
  contextText: string | undefined,
  options?: ContextRankOptions,
): Promise<RawSearchResult[]> {
  if (results.length === 0) return results;
  const ctx = contextText?.trim();
  if (!ctx) return results;

  const min = options?.minMultiplier ?? DEFAULT_MIN_MULTIPLIER;
  const max = options?.maxMultiplier ?? DEFAULT_MAX_MULTIPLIER;

  let provider;
  try {
    provider = await getEmbedProvider();
  } catch (err) {
    log.warn('context-rank: embed provider unavailable, skipping', {
      error: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  const combinedQuery = `${query}\n\nContext:\n${ctx}`;
  const resultTexts = results.map((r) => `${r.title}\n${r.snippet}`);

  let vectors: Float32Array[];
  try {
    vectors = await provider.embed([combinedQuery, ...resultTexts]);
  } catch (err) {
    log.warn('context-rank: embed call failed, skipping', {
      error: err instanceof Error ? err.message : String(err),
    });
    return results;
  }

  if (vectors.length !== results.length + 1) {
    log.warn('context-rank: unexpected vector count, skipping', {
      expected: results.length + 1,
      got: vectors.length,
    });
    return results;
  }

  const queryVec = vectors[0];
  const rescored = results.map((r, i) => {
    const cos = cosine(queryVec, vectors[i + 1]);
    const multiplier = mapCosineToMultiplier(cos, min, max);
    return { ...r, relevance_score: r.relevance_score * multiplier };
  });

  rescored.sort((a, b) => b.relevance_score - a.relevance_score);
  return rescored;
}
