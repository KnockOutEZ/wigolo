import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upsertSpy = vi.fn(async () => undefined);
const embedSpy = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.1)));

vi.mock('../../../src/providers/embed-provider.js', () => ({
  getEmbedProvider: vi.fn(async () => ({
    embed: embedSpy,
    dim: 384,
    modelId: 'test-embed',
  })),
  _resetEmbedProviderForTest: vi.fn(),
}));

vi.mock('../../../src/providers/vector-store.js', () => ({
  getVectorStore: vi.fn(async () => ({
    upsert: upsertSpy,
    search: vi.fn(async () => []),
    delete: vi.fn(async () => undefined),
    size: vi.fn(async () => 0),
  })),
  _resetVectorStoreForTest: vi.fn(),
}));

import { backfillEmbeddings } from '../../../src/cache/backfill-embeddings.js';
import { getEmbedProvider } from '../../../src/providers/embed-provider.js';
import { initDatabase, closeDatabase, isVecExtensionLoaded } from '../../../src/cache/db.js';

function seed(db: ReturnType<typeof initDatabase>, rows: Array<{ url: string; title: string | null; markdown: string | null; content_hash?: string }>) {
  const stmt = db.prepare(
    'INSERT INTO url_cache (url, normalized_url, title, markdown, content_hash, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const r of rows) {
    stmt.run(r.url, r.url, r.title, r.markdown, r.content_hash ?? null, new Date().toISOString());
  }
}

describe('backfillEmbeddings', () => {
  let dir: string;

  beforeEach(() => {
    embedSpy.mockClear();
    upsertSpy.mockClear();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-backfill-'));
  });

  afterEach(() => {
    closeDatabase();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('scans rows missing a vec_id_map entry and upserts via the vector store', async () => {
    const db = initDatabase(join(dir, 'wigolo.db'));
    if (!isVecExtensionLoaded()) {
      // Platform (alpine/musl) doesn't ship sqlite-vec. The reason short
      // circuit is asserted instead.
      closeDatabase();
      const r = await backfillEmbeddings({ dataDir: dir });
      expect(r.reason).toMatch(/sqlite-vec/);
      return;
    }
    seed(db, [
      { url: 'https://a.example/1', title: 'A', markdown: 'a body' },
      { url: 'https://b.example/2', title: 'B', markdown: 'b body' },
    ]);
    closeDatabase();

    const r = await backfillEmbeddings({ dataDir: dir, batchSize: 2 });
    expect(r.scanned).toBe(2);
    expect(r.embedded).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.errors).toBe(0);
    expect(r.modelId).toBe('test-embed');

    expect(embedSpy).toHaveBeenCalledTimes(1);
    expect(upsertSpy).toHaveBeenCalledTimes(1);

    const upsertedIds = upsertSpy.mock.calls[0][0].map((rec: { id: string }) => rec.id).sort();
    expect(upsertedIds).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('skips rows with no title or markdown', async () => {
    const db = initDatabase(join(dir, 'wigolo.db'));
    if (!isVecExtensionLoaded()) {
      closeDatabase();
      return;
    }
    seed(db, [
      { url: 'https://a.example/1', title: '', markdown: '' },
      { url: 'https://b.example/2', title: 'B', markdown: 'body' },
    ]);
    closeDatabase();

    const r = await backfillEmbeddings({ dataDir: dir });
    expect(r.skipped).toBe(1);
    expect(r.embedded).toBe(1);
  });

  it('honors --dry-run by skipping the upsert', async () => {
    const db = initDatabase(join(dir, 'wigolo.db'));
    if (!isVecExtensionLoaded()) {
      closeDatabase();
      return;
    }
    seed(db, [{ url: 'https://a.example/1', title: 'A', markdown: 'a body' }]);
    closeDatabase();

    const r = await backfillEmbeddings({ dataDir: dir, dryRun: true });
    expect(r.embedded).toBe(1);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('honors --limit', async () => {    const db = initDatabase(join(dir, 'wigolo.db'));
    if (!isVecExtensionLoaded()) {
      closeDatabase();
      return;
    }
    seed(db, [
      { url: 'https://a.example/1', title: 'A', markdown: 'a' },
      { url: 'https://b.example/2', title: 'B', markdown: 'b' },
      { url: 'https://c.example/3', title: 'C', markdown: 'c' },
    ]);
    closeDatabase();

    const r = await backfillEmbeddings({ dataDir: dir, limit: 2 });
    expect(r.scanned).toBe(2);
    expect(r.embedded).toBe(2);
  });

  it('reacquires the embed provider for each batch', async () => {
    const db = initDatabase(join(dir, 'wigolo.db'));
    if (!isVecExtensionLoaded()) {
      closeDatabase();
      return;
    }
    seed(db, [
      { url: 'https://a.example/1', title: 'A', markdown: 'a body' },
      { url: 'https://b.example/2', title: 'B', markdown: 'b body' },
    ]);
    closeDatabase();

    // The idle timer can release the model between batches, so each batch
    // asks the factory for the current provider.
    vi.mocked(getEmbedProvider).mockClear();
    const r = await backfillEmbeddings({ dataDir: dir, batchSize: 1 });

    expect(r.embedded).toBe(2);
    expect(embedSpy).toHaveBeenCalledTimes(2);
    // One resolution before the scan, then one per batch.
    expect(vi.mocked(getEmbedProvider)).toHaveBeenCalledTimes(3);
  });
});
