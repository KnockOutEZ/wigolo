import type {
  VectorStore,
  VectorRecord,
  VectorSearchResult,
  VectorMetadata,
} from '../providers/vector-store.js';
import { VectorIndex } from '../embedding/vector-index.js';

/**
 * Legacy vector-store adapter — wraps the existing in-memory VectorIndex.
 *
 * Translation notes:
 * - The legacy index is keyed by URL alone (single Map<string, Float32Array>).
 *   We treat `record.id` as the URL key.
 * - The legacy index stores no metadata. To preserve the new interface's
 *   metadata round-trip + filter behavior, we keep a parallel Map on this
 *   adapter. This is purely structural — the underlying vector math (cosine
 *   similarity, topK selection) still happens in VectorIndex.
 * - SQLite persistence is owned by `EmbeddingService.embedAndStore` today,
 *   not the index. The adapter therefore does NOT persist; callers that
 *   need persistence keep using `EmbeddingService` until Phase 6 unifies
 *   the surface.
 */
export class LegacyVectorStore implements VectorStore {
  private index = new VectorIndex();
  private metadata = new Map<string, VectorMetadata>();

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      this.index.add(record.id, record.vector);
      this.metadata.set(record.id, record.metadata);
    }
  }

  async search(
    queryVector: Float32Array,
    limit: number,
    filter?: Partial<VectorMetadata>,
  ): Promise<VectorSearchResult[]> {
    // Pull more than `limit` from the index when filtering, so post-filter
    // results can still hit the requested count. The legacy index has no
    // native filter support, so we filter after scoring.
    const raw = this.index.findSimilar(queryVector, filter ? this.index.size() : limit);
    const results: VectorSearchResult[] = [];
    for (const hit of raw) {
      const meta = this.metadata.get(hit.url) ?? { url: hit.url };
      if (filter && !matchesFilter(meta, filter)) continue;
      results.push({ id: hit.url, score: hit.score, metadata: meta });
      if (results.length >= limit) break;
    }
    return results;
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.index.remove(id);
      this.metadata.delete(id);
    }
  }

  async size(): Promise<number> {
    return this.index.size();
  }
}

function matchesFilter(meta: VectorMetadata, filter: Partial<VectorMetadata>): boolean {
  if (filter.url !== undefined && meta.url !== filter.url) return false;
  if (filter.contentHash !== undefined && meta.contentHash !== filter.contentHash) return false;
  if (filter.modelId !== undefined && meta.modelId !== filter.modelId) return false;
  if (filter.extra !== undefined) {
    const have = meta.extra ?? {};
    for (const [k, v] of Object.entries(filter.extra)) {
      if (have[k] !== v) return false;
    }
  }
  return true;
}
