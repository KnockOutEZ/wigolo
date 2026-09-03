import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sv from 'sqlite-vec';
import { SqliteVecStore } from '../../../src/cache/sqlite-vec-store.js';
import type { VectorRecord } from '../../../src/providers/vector-store.js';

function bootstrap(db: Database.Database): void {
  sv.load(db);
  db.exec(`
    CREATE VIRTUAL TABLE vec_documents USING vec0(embedding float[4]);
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
}

describe('SqliteVecStore', () => {
  let db: Database.Database;
  let store: SqliteVecStore;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    bootstrap(db);
    store = new SqliteVecStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('partitions (SD7 A-18-5)', () => {
    /**
     * The partition is enforced HERE rather than at each caller because
     * `getVectorStore()` hands this one class to every reader of the shared
     * index. These arms pin the default-deny direction specifically: a filter
     * that names the scope is ordinary equality and `matchesFilter` already had
     * it, but "a caller that asked for nothing sees nothing partitioned" is the
     * new rule and the one a future reader depends on without knowing it.
     */
    const scoped: VectorRecord = {
      id: 'partitioned',
      vector: new Float32Array([1, 0, 0, 0]),
      metadata: { url: 'private', contentHash: 'hp', modelId: 'test', extra: { scope: 'visit' } },
    };
    const shared: VectorRecord = {
      id: 'https://shared',
      vector: new Float32Array([0.99, 0.01, 0, 0]),
      metadata: { url: 'https://shared', contentHash: 'hs', modelId: 'test' },
    };

    it('hides a scoped record from a search that names no scope', async () => {
      await store.upsert([scoped, shared]);
      const hits = await store.search(new Float32Array([1, 0, 0, 0]), 10);
      // The scoped row is the NEARER of the two, so its absence is exclusion and
      // not a ranking accident.
      expect(hits.map(h => h.id)).toEqual(['https://shared']);
    });

    it('returns a scoped record only to a search that names its scope', async () => {
      await store.upsert([scoped, shared]);
      const hits = await store.search(new Float32Array([1, 0, 0, 0]), 10, {
        extra: { scope: 'visit' },
      });
      expect(hits.map(h => h.id)).toEqual(['partitioned']);
    });

    it('does not leak one scope into another', async () => {
      await store.upsert([
        scoped,
        {
          id: 'other-partition',
          vector: new Float32Array([1, 0, 0, 0]),
          metadata: { url: 'other', contentHash: 'ho', modelId: 'test', extra: { scope: 'notes' } },
        },
      ]);
      const hits = await store.search(new Float32Array([1, 0, 0, 0]), 10, {
        extra: { scope: 'notes' },
      });
      expect(hits.map(h => h.id)).toEqual(['other-partition']);
    });

    it('treats an empty or non-string scope as unscoped rather than as a partition of its own', async () => {
      // A record whose scope key is present but meaningless must stay in the
      // shared corpus: silently partitioning it would make a row vanish from
      // every agent read for a typo, which is the failure this default-deny is
      // most likely to cause and the one nobody would look for.
      await store.upsert([
        {
          id: 'blank-scope',
          vector: new Float32Array([1, 0, 0, 0]),
          metadata: { url: 'https://blank', contentHash: 'hb', modelId: 'test', extra: { scope: '' } },
        },
      ]);
      const hits = await store.search(new Float32Array([1, 0, 0, 0]), 10);
      expect(hits.map(h => h.id)).toEqual(['blank-scope']);
    });
  });

  it('upsert + size + search round-trips', async () => {
    const records: VectorRecord[] = [
      { id: 'a', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'https://a', contentHash: 'ha', modelId: 'test' } },
      { id: 'b', vector: new Float32Array([0, 1, 0, 0]), metadata: { url: 'https://b', contentHash: 'hb', modelId: 'test' } },
      { id: 'c', vector: new Float32Array([0.9, 0.1, 0, 0]), metadata: { url: 'https://c', contentHash: 'hc', modelId: 'test' } },
    ];
    await store.upsert(records);

    expect(await store.size()).toBe(3);

    const results = await store.search(new Float32Array([1, 0, 0, 0]), 2);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('a');
    expect(results[1].id).toBe('c');
    expect(results[0].score).toBeGreaterThan(results[1].score);
    expect(results[0].metadata.url).toBe('https://a');
  });

  it('upsert is idempotent for the same id', async () => {
    await store.upsert([
      { id: 'a', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'u1', contentHash: 'h1', modelId: 'm' } },
    ]);
    await store.upsert([
      { id: 'a', vector: new Float32Array([0, 0, 1, 0]), metadata: { url: 'u1b', contentHash: 'h2', modelId: 'm' } },
    ]);

    expect(await store.size()).toBe(1);

    const results = await store.search(new Float32Array([0, 0, 1, 0]), 1);
    expect(results[0].id).toBe('a');
    expect(results[0].metadata.url).toBe('u1b');
    expect(results[0].metadata.contentHash).toBe('h2');
  });

  it('filters by modelId', async () => {
    await store.upsert([
      { id: 'a', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'x', contentHash: 'h', modelId: 'm1' } },
      { id: 'b', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'y', contentHash: 'h', modelId: 'm2' } },
    ]);
    const r = await store.search(new Float32Array([1, 0, 0, 0]), 10, { modelId: 'm1' });
    expect(r.map(x => x.id)).toEqual(['a']);
  });

  it('filters by url and contentHash', async () => {
    await store.upsert([
      { id: 'a', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'https://a', contentHash: 'h1', modelId: 'm' } },
      { id: 'b', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'https://b', contentHash: 'h2', modelId: 'm' } },
    ]);

    const byUrl = await store.search(new Float32Array([1, 0, 0, 0]), 10, { url: 'https://b' });
    expect(byUrl.map(x => x.id)).toEqual(['b']);

    const byHash = await store.search(new Float32Array([1, 0, 0, 0]), 10, { contentHash: 'h1' });
    expect(byHash.map(x => x.id)).toEqual(['a']);
  });

  it('round-trips extra metadata', async () => {
    await store.upsert([
      {
        id: 'a',
        vector: new Float32Array([1, 0, 0, 0]),
        metadata: {
          url: 'u',
          contentHash: 'h',
          modelId: 'm',
          extra: { lang: 'en', tier: 2 },
        },
      },
    ]);
    const [hit] = await store.search(new Float32Array([1, 0, 0, 0]), 1);
    expect(hit.metadata.extra).toEqual({ lang: 'en', tier: 2 });
  });

  it('delete removes vector and metadata', async () => {
    await store.upsert([
      { id: 'a', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'x', contentHash: 'h', modelId: 'm' } },
      { id: 'b', vector: new Float32Array([0, 1, 0, 0]), metadata: { url: 'y', contentHash: 'h', modelId: 'm' } },
    ]);
    expect(await store.size()).toBe(2);

    await store.delete(['a']);
    expect(await store.size()).toBe(1);

    const r = await store.search(new Float32Array([1, 0, 0, 0]), 5);
    expect(r.map(x => x.id)).toEqual(['b']);
  });

  it('search returns empty array when store is empty', async () => {
    expect(await store.search(new Float32Array([1, 0, 0, 0]), 5)).toEqual([]);
  });

  it('search returns empty for non-positive limit', async () => {
    await store.upsert([
      { id: 'a', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'x', contentHash: 'h', modelId: 'm' } },
    ]);
    expect(await store.search(new Float32Array([1, 0, 0, 0]), 0)).toEqual([]);
  });

  it('upsert([]) is a no-op', async () => {
    await store.upsert([]);
    expect(await store.size()).toBe(0);
  });

  it('delete([]) is a no-op', async () => {
    await store.delete([]);
    expect(await store.size()).toBe(0);
  });

  it('delete ignores unknown ids', async () => {
    await store.upsert([
      { id: 'a', vector: new Float32Array([1, 0, 0, 0]), metadata: { url: 'x', contentHash: 'h', modelId: 'm' } },
    ]);
    await store.delete(['does-not-exist']);
    expect(await store.size()).toBe(1);
  });
});
