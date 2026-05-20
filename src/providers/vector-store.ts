/**
 * Vector store interface — Phase 1 Task 1.3 of v1 engine overhaul.
 *
 * Wraps the existing in-memory VectorIndex (URL-keyed, cosine similarity,
 * loaded from SQLite on init) behind a stable interface. The factory always
 * returns the legacy adapter today; Phase 6 swaps in a richer v1 store.
 */
export interface VectorMetadata {
  /** Source URL (used as primary identity by the legacy index). */
  url: string;
  contentHash: string;
  modelId: string;
  extra?: Record<string, unknown>;
}

export interface VectorRecord {
  /** Stable identifier; the legacy adapter treats this as the URL key. */
  id: string;
  vector: Float32Array;
  metadata: VectorMetadata;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  metadata: VectorMetadata;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  search(
    queryVector: Float32Array,
    limit: number,
    filter?: Partial<VectorMetadata>,
  ): Promise<VectorSearchResult[]>;
  delete(ids: string[]): Promise<void>;
  size(): Promise<number>;
}

let cached: Promise<VectorStore> | null = null;

export function getVectorStore(): Promise<VectorStore> {
  if (cached) return cached;
  cached = import('../cache/legacy-vector-store.js').then(
    m => new m.LegacyVectorStore(),
    err => { cached = null; throw err; },
  );
  return cached;
}

export function _resetVectorStoreForTest(): void {
  cached = null;
}
