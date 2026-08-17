import type Database from 'better-sqlite3';
import type {
  VectorStore,
  VectorRecord,
  VectorSearchResult,
  VectorMetadata,
} from '../providers/vector-store.js';
import { createLogger } from '../logger.js';

const log = createLogger('cache');

/**
 * VectorStore backed by the sqlite-vec extension loaded into the shared
 * better-sqlite3 cache database.
 *
 * Storage layout (see src/cache/migrations/001-sqlite-vec.sql):
 *   - vec_documents (virtual, vec0)   integer rowid -> float[384] embedding
 *   - vec_id_map                       integer rowid -> external string id
 *   - vec_metadata                     integer rowid -> full VectorMetadata
 *
 * vec0 only accepts integer rowid values, so external string ids (URLs in
 * the legacy world) are mapped to AUTOINCREMENT rowids via vec_id_map.
 *
 * vec0 rejects `INSERT OR REPLACE`, so upsert deletes any existing vector
 * row for an id before inserting the new one (within a single transaction).
 *
 * Search returns sqlite-vec's native L2 distance converted to a similarity
 * score as `1 / (1 + distance)`. Higher score = closer match.
 *
 * Filter semantics match VectorStore: when `filter` is provided we
 * over-fetch from the KNN side (oversample = limit * 5) then post-filter
 * against vec_metadata before truncating to `limit`. Filters never relax
 * — every populated filter field must match.
 */
export class SqliteVecStore implements VectorStore {
  private upsertSelectStmt: Database.Statement;
  private upsertInsertIdMapStmt: Database.Statement;
  private upsertDeleteDocStmt: Database.Statement;
  private upsertInsertDocStmt: Database.Statement;
  private upsertUpsertMetadataStmt: Database.Statement;
  private sizeStmt: Database.Statement;

  constructor(private db: Database.Database) {
    this.upsertSelectStmt = db.prepare(
      'SELECT rowid FROM vec_id_map WHERE external_id = ?',
    );
    this.upsertInsertIdMapStmt = db.prepare(
      'INSERT INTO vec_id_map (external_id) VALUES (?)',
    );
    this.upsertDeleteDocStmt = db.prepare(
      'DELETE FROM vec_documents WHERE rowid = ?',
    );
    this.upsertInsertDocStmt = db.prepare(
      'INSERT INTO vec_documents (rowid, embedding) VALUES (?, ?)',
    );
    this.upsertUpsertMetadataStmt = db.prepare(`
      INSERT INTO vec_metadata (rowid, url, content_hash, model_id, created_at, extra_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(rowid) DO UPDATE SET
        url = excluded.url,
        content_hash = excluded.content_hash,
        model_id = excluded.model_id,
        created_at = excluded.created_at,
        extra_json = excluded.extra_json
    `);
    this.sizeStmt = db.prepare('SELECT COUNT(*) AS c FROM vec_id_map');
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;

    const tx = this.db.transaction((items: VectorRecord[]) => {
      for (const record of items) {
        const existing = this.upsertSelectStmt.get(record.id) as { rowid: number } | undefined;
        let rowid: number;
        if (existing) {
          rowid = existing.rowid;
          this.upsertDeleteDocStmt.run(BigInt(rowid));
        } else {
          const info = this.upsertInsertIdMapStmt.run(record.id);
          rowid = Number(info.lastInsertRowid);
        }

        const vec = record.vector;
        const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
        this.upsertInsertDocStmt.run(BigInt(rowid), buf);

        const extra = record.metadata.extra
          ? JSON.stringify(record.metadata.extra)
          : null;
        this.upsertUpsertMetadataStmt.run(
          rowid,
          record.metadata.url,
          record.metadata.contentHash,
          record.metadata.modelId,
          Date.now(),
          extra,
        );
      }
    });

    try {
      tx(records);
    } catch (err) {
      log.error('SqliteVecStore.upsert failed', {
        count: records.length,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async search(
    queryVector: Float32Array,
    limit: number,
    filter?: Partial<VectorMetadata>,
  ): Promise<VectorSearchResult[]> {
    if (limit <= 0) return [];

    const queryBuf = Buffer.from(
      queryVector.buffer,
      queryVector.byteOffset,
      queryVector.byteLength,
    );

    // When a filter is present we over-fetch from the KNN side and apply
    // the filter post-hoc, since vec0 MATCH cannot be combined with JOIN
    // predicates inside a single WHERE clause.
    const knnLimit = filter ? Math.max(limit * 5, 50) : limit;

    const candidateStmt = this.db.prepare(`
      SELECT rowid, distance
      FROM vec_documents
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `);

    let candidates: Array<{ rowid: number; distance: number }>;
    try {
      candidates = candidateStmt.all(queryBuf, knnLimit) as Array<{
        rowid: number;
        distance: number;
      }>;
    } catch (err) {
      log.error('SqliteVecStore.search KNN failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    if (candidates.length === 0) return [];

    const rowids = candidates.map(c => c.rowid);
    const placeholders = rowids.map(() => '?').join(',');
    const metaRows = this.db
      .prepare(`
        SELECT m.rowid AS rowid, m.external_id AS external_id,
               meta.url AS url, meta.content_hash AS content_hash,
               meta.model_id AS model_id, meta.extra_json AS extra_json
        FROM vec_id_map m
        JOIN vec_metadata meta ON m.rowid = meta.rowid
        WHERE m.rowid IN (${placeholders})
      `)
      .all(...rowids) as Array<{
        rowid: number;
        external_id: string;
        url: string;
        content_hash: string;
        model_id: string;
        extra_json: string | null;
      }>;

    const metaByRowid = new Map<number, typeof metaRows[number]>();
    for (const r of metaRows) metaByRowid.set(r.rowid, r);

    const results: VectorSearchResult[] = [];
    for (const cand of candidates) {
      const meta = metaByRowid.get(cand.rowid);
      if (!meta) continue;

      const extra = meta.extra_json
        ? (JSON.parse(meta.extra_json) as Record<string, unknown>)
        : undefined;

      const metadata: VectorMetadata = {
        url: meta.url,
        contentHash: meta.content_hash,
        modelId: meta.model_id,
        ...(extra ? { extra } : {}),
      };

      if (filter && !matchesFilter(metadata, filter)) continue;

      results.push({
        id: meta.external_id,
        score: 1 / (1 + cand.distance),
        metadata,
      });

      if (results.length >= limit) break;
    }

    return results;
  }

  async delete(ids: string[]): Promise<void> {
    deleteVectorsByExternalId(this.db, ids);
  }

  async size(): Promise<number> {
    const row = this.sizeStmt.get() as { c: number };
    return row.c;
  }
}

/**
 * Evict vector rows by external id against a caller-supplied handle.
 *
 * Synchronous and free-standing so a caller that already holds the shared
 * cache database — the cache-clear path — can evict without awaiting the
 * async provider factory. That factory dynamic-imports `cache/db.js`, so
 * reaching it from a synchronous seam is not just awkward, it risks binding a
 * different module instance than the one holding the rows being deleted.
 *
 * Returns the number of ids that actually had a vector row. Returns 0 when the
 * vec tables are absent: migration 001 is skipped on platforms without the
 * native vector extension, and a cache clear must still succeed there.
 */
export function deleteVectorsByExternalId(
  db: Database.Database,
  ids: string[],
): number {
  if (ids.length === 0) return 0;
  if (!hasVectorTables(db)) return 0;

  const selectStmt = db.prepare('SELECT rowid FROM vec_id_map WHERE external_id = ?');
  const deleteDocStmt = db.prepare('DELETE FROM vec_documents WHERE rowid = ?');
  const deleteMetaStmt = db.prepare('DELETE FROM vec_metadata WHERE rowid = ?');
  const deleteIdMapStmt = db.prepare('DELETE FROM vec_id_map WHERE external_id = ?');

  let removed = 0;
  const tx = db.transaction((items: string[]) => {
    for (const id of items) {
      const existing = selectStmt.get(id) as { rowid: number } | undefined;
      if (!existing) continue;
      deleteDocStmt.run(BigInt(existing.rowid));
      // vec_metadata has ON DELETE CASCADE on the id_map FK, but that only
      // fires when `foreign_keys` is ON. Deleting it explicitly means the row
      // cannot outlive its vector because of a pragma set somewhere else.
      deleteMetaStmt.run(existing.rowid);
      deleteIdMapStmt.run(id);
      removed++;
    }
  });

  try {
    tx(ids);
  } catch (err) {
    log.error('vector eviction failed', {
      count: ids.length,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  return removed;
}

function hasVectorTables(db: Database.Database): boolean {
  try {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('vec_documents','vec_id_map')",
      )
      .get() as { n: number };
    return row.n === 2;
  } catch {
    return false;
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
