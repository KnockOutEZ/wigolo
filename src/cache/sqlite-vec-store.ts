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
 * over-fetch from the KNN side, then post-filter against vec_metadata. The
 * window widens until it holds `limit` matching rows or covers the whole
 * store. Filters never relax — every populated filter field must match.
 */
export class SqliteVecStore implements VectorStore {
  private upsertSelectStmt: Database.Statement;
  private upsertInsertIdMapStmt: Database.Statement;
  private upsertDeleteDocStmt: Database.Statement;
  private upsertInsertDocStmt: Database.Statement;
  private upsertUpsertMetadataStmt: Database.Statement;
  private deleteIdMapStmt: Database.Statement;
  private deleteDocStmt: Database.Statement;
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
    this.deleteIdMapStmt = db.prepare('DELETE FROM vec_id_map WHERE external_id = ?');
    this.deleteDocStmt = db.prepare('DELETE FROM vec_documents WHERE rowid = ?');
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
    // predicates inside a single WHERE clause. The window widens until it
    // holds `limit` matches or covers the whole store, so rows from another
    // model cannot hide current-model rows that rank further out.
    const candidateStmt = this.db.prepare(`
      SELECT rowid, distance
      FROM vec_documents
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `);

    let knnLimit = filter ? Math.max(limit * 5, 50) : limit;

    for (;;) {
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

      if (results.length >= limit) return results;
      // A window that returned fewer rows than it asked for already covers
      // every vector in the store, so a wider window cannot add matches.
      if (!filter || candidates.length < knnLimit) return results;
      knnLimit *= 4;
    }
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;

    const tx = this.db.transaction((items: string[]) => {
      for (const id of items) {
        const existing = this.upsertSelectStmt.get(id) as { rowid: number } | undefined;
        if (!existing) continue;
        this.deleteDocStmt.run(BigInt(existing.rowid));
        this.deleteIdMapStmt.run(id);
        // vec_metadata cascades via ON DELETE CASCADE on the id_map FK.
      }
    });

    try {
      tx(ids);
    } catch (err) {
      log.error('SqliteVecStore.delete failed', {
        count: ids.length,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async size(): Promise<number> {
    const row = this.sizeStmt.get() as { c: number };
    return row.c;
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
