import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { getCachedContent, searchCacheFiltered } from '../../../src/cache/store.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { resetConfig } from '../../../src/config.js';
import { hashMarkdown } from '../../../src/indexing/embed.js';
import { ingestFile, ingestFiles } from '../../../src/indexing/ingester.js';

vi.mock('../../../src/embedding/background-queue.js', () => ({
  getBackgroundIndexQueue: () => ({
    enqueue: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('hashMarkdown', () => {
  it('is a stable sha256 digest', () => {
    expect(hashMarkdown('abc')).toBe(hashMarkdown('abc'));
    expect(hashMarkdown('abc')).not.toBe(hashMarkdown('abd'));
  });
});

describe('ingestFile', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-ingest-'));
    dbPath = join(dir, 'wigolo.db');
    process.env.WIGOLO_DATA_DIR = dir;
    resetConfig();
    initDatabase(dbPath);
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes never-expiring internal:// rows with namespace/tags', async () => {
    const path = join(dir, 'runbook.md');
    writeFileSync(path, '# Deploy\n\nrestart the service');
    const r = await ingestFile(
      { absolutePath: path, relativePath: 'runbook.md' },
      { namespace: 'docs', tags: ['team:ops'], ttlSeconds: 0, embed: false },
      dir,
    );
    expect(r.status).toBe('indexed');
    expect(r.url).toBe('internal://docs/runbook.md');

    const cached = getCachedContent(r.url);
    expect(cached).not.toBeNull();
    expect(cached!.expiresAt).toBeNull();
    expect(cached!.namespace).toBe('docs');
    expect(cached!.tags).toContain('team:ops');
    expect(cached!.title).toBe('Deploy');
    expect(cached!.fetchMethod).toBe('index');
  });

  it('skips unchanged content on re-ingest', async () => {
    const path = join(dir, 'same.md');
    writeFileSync(path, '# Same\n\nbody');
    const opts = { namespace: 'docs', tags: [], ttlSeconds: 0, embed: false };
    const file = { absolutePath: path, relativePath: 'same.md' };
    expect((await ingestFile(file, opts, dir)).status).toBe('indexed');
    expect((await ingestFile(file, opts, dir)).status).toBe('skipped');
  });

  it('batch ingest reports counts and rows are FTS-visible', async () => {
    writeFileSync(join(dir, 'a.md'), '# A');
    writeFileSync(join(dir, 'b.md'), '# B');
    const batch = await ingestFiles(
      [
        { absolutePath: join(dir, 'a.md'), relativePath: 'a.md' },
        { absolutePath: join(dir, 'b.md'), relativePath: 'b.md' },
      ],
      { namespace: 'wiki', tags: [], ttlSeconds: 0, embed: false },
      dir,
    );
    expect(batch.indexed).toBe(2);
    expect(batch.skipped).toBe(0);
    expect(batch.failed).toBe(0);

    const internal = searchCacheFiltered({ urlPattern: 'internal://wiki/*' });
    expect(internal.length).toBe(2);
  });
});
