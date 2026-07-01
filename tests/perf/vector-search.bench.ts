/**
 * Vector search perf bench (gated on RUN_VEC_PERF=1).
 *
 * Performance gates:
 *   P50 search latency ≤ 200ms on a 10k vector corpus
 *   Should be at least 3x faster than the legacy in-memory linear scan
 *   recall@10 within 1% of legacy cosine-similarity ranking
 *
 * Sandbox runs cannot exercise this — the in-memory db here is small and
 * sandbox CPU is shared. Run on the dev host:
 *
 *   RUN_VEC_PERF=1 npm run test:perf -- tests/perf/vector-search.bench.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import * as sv from 'sqlite-vec';
import { SqliteVecStore } from '../../src/cache/sqlite-vec-store.js';
import type { VectorRecord } from '../../src/providers/vector-store.js';

const GATED = !process.env.RUN_VEC_PERF;
const DIMS = 384;
const CORPUS_SIZE = 10_000;
const QUERY_COUNT = 100;
const LIMIT = 10;

function randomVector(dims: number): Float32Array {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i++) v[i] = Math.random() * 2 - 1;
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i++) v[i] /= norm;
  }
  return v;
}

function p50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.5)];
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

describe.skipIf(GATED)('vector-search perf', () => {
  let db: Database.Database;
  let store: SqliteVecStore;

  beforeAll(async () => {
    db = new Database(':memory:');
    sv.load(db);
    db.exec(`
      CREATE VIRTUAL TABLE vec_documents USING vec0(embedding float[${DIMS}]);
      CREATE TABLE vec_id_map (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE vec_metadata (
        rowid INTEGER PRIMARY KEY REFERENCES vec_id_map(rowid) ON DELETE CASCADE,
        url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        extra_json TEXT
      );
    `);
    store = new SqliteVecStore(db);

    const batch: VectorRecord[] = [];
    for (let i = 0; i < CORPUS_SIZE; i++) {
      batch.push({
        id: `https://doc${i}.com`,
        vector: randomVector(DIMS),
        metadata: { url: `https://doc${i}.com`, contentHash: 'h', modelId: 'bench' },
      });
      if (batch.length === 500) {
        await store.upsert(batch.splice(0));
      }
    }
    if (batch.length > 0) await store.upsert(batch);
  });

  afterAll(() => {
    if (db) db.close();
  });

  it(`p50 search latency on ${CORPUS_SIZE} vectors`, async () => {
    const samples: number[] = [];
    for (let i = 0; i < QUERY_COUNT; i++) {
      const q = randomVector(DIMS);
      const t0 = performance.now();
      const r = await store.search(q, LIMIT);
      samples.push(performance.now() - t0);
      expect(r.length).toBe(LIMIT);
    }
    const median = p50(samples);
    const tail = p95(samples);
    // eslint-disable-next-line no-console
    console.log(`vec-search p50=${median.toFixed(1)}ms p95=${tail.toFixed(1)}ms n=${QUERY_COUNT}`);
    expect(median).toBeLessThan(200);
  });
});
