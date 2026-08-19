import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { searchCacheFiltered } from '../../../src/cache/store.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { resetConfig } from '../../../src/config.js';
import { handleIndex } from '../../../src/tools/index.js';
import { handleCache } from '../../../src/tools/cache.js';

vi.mock('../../../src/embedding/background-queue.js', () => ({
  getBackgroundIndexQueue: () => ({
    enqueue: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('handleIndex', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-index-'));
    process.env.WIGOLO_DATA_DIR = dir;
    resetConfig();
    initDatabase(join(dir, 'wigolo.db'));
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects missing source', async () => {
    const out = await handleIndex({ source: '' });
    expect(out.error).toMatch(/source/i);
  });

  it('rejects remote URLs', async () => {
    const out = await handleIndex({ source: 'https://example.com/docs' });
    expect(out.error).toMatch(/scheme|local/i);
  });

  it('indexes a directory and is searchable via cache source=internal', async () => {
    const docs = join(dir, 'docs');
    mkdirSync(docs);
    writeFileSync(join(docs, 'architecture.md'), '# Architecture\n\nuse the index tool');

    const out = await handleIndex({
      source: docs,
      namespace: 'docs',
      tags: ['type:adr'],
    });
    expect(out.error).toBeUndefined();
    expect(out.indexed).toBe(1);
    expect(out.files[0].url).toBe('internal://docs/architecture.md');

    const cache = await handleCache({
      query: 'architecture',
      source: 'internal',
    });
    expect(cache.error).toBeUndefined();
    expect(cache.results?.length).toBeGreaterThan(0);
    expect(cache.results?.[0].url).toMatch(/^internal:\/\//);

    const webOnly = searchCacheFiltered({ source: 'web', query: 'architecture' });
    expect(webOnly.every((r) => !r.url.startsWith('internal://'))).toBe(true);
  });

  it('skips unchanged files on second run', async () => {
    const file = join(dir, 'once.md');
    writeFileSync(file, '# Once\n\nstable');
    const first = await handleIndex({ source: file });
    const second = await handleIndex({ source: file });
    expect(first.indexed).toBe(1);
    expect(second.skipped).toBe(1);
    expect(second.indexed).toBe(0);
  });

  it('dry_run scans without writing to cache', async () => {
    const docs = join(dir, 'dry');
    mkdirSync(docs);
    writeFileSync(join(docs, 'preview.md'), '# Preview\n\nnot persisted');

    const out = await handleIndex({ source: docs, dry_run: true });
    expect(out.error).toBeUndefined();
    expect(out.scanned).toBe(1);
    expect(out.indexed).toBe(0);
    expect(out.sample_urls).toEqual(['internal://docs/preview.md']);

    const cache = await handleCache({ query: 'Preview', source: 'internal' });
    expect(cache.results?.length ?? 0).toBe(0);
  });

  it('rejects batches exceeding max_files', async () => {
    const docs = join(dir, 'many');
    mkdirSync(docs);
    writeFileSync(join(docs, 'a.md'), '# A');
    writeFileSync(join(docs, 'b.md'), '# B');
    writeFileSync(join(docs, 'c.md'), '# C');

    const out = await handleIndex({ source: docs, max_files: 2 });
    expect(out.error).toMatch(/batch limit exceeded/i);
  });
});
