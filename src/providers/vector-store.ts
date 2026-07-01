/**
 * Vector store interface.
 *
 * The default implementation switched from the in-memory
 * VectorIndex adapter to the sqlite-vec backed store. The interface is
 * unchanged so callers do not need to change.
 */
import { createLogger } from '../logger.js';

const log = createLogger('providers');
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
  cached = (async () => {
    const [{ SqliteVecStore }, { getDatabase }] = await Promise.all([
      import('../cache/sqlite-vec-store.js'),
      import('../cache/db.js'),
    ]);
    const db = getDatabase();
    log.info('vector store ready', { provider: 'vector-store', impl: 'sqlite-vec' });
    return new SqliteVecStore(db);
  })().catch(err => {
    cached = null;
    throw err;
  });
  return cached;
}

export function _resetVectorStoreForTest(): void {
  cached = null;
}
