import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { getCachedContent } from '../../../src/cache/store.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { resetConfig } from '../../../src/config.js';
import {
  buildContentHash,
  cacheIndexedDocument,
  resolveIndexExpiresAt,
} from '../../../src/cache/internal-store.js';

describe('resolveIndexExpiresAt', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  it('returns null for never-expire TTLs', () => {
    expect(resolveIndexExpiresAt(0, now)).toBeNull();
    expect(resolveIndexExpiresAt(null, now)).toBeNull();
  });

  it('adds ttl seconds', () => {
    const exp = resolveIndexExpiresAt(3600, now);
    expect(exp?.getTime()).toBe(now.getTime() + 3600_000);
  });
});

describe('cacheIndexedDocument', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-internal-store-'));
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

  it('inserts internal rows with namespace and tags', () => {
    const path = join(dir, 'note.md');
    writeFileSync(path, '# Note\n\nbody');
    const markdown = '# Note\n\nbody';
    const outcome = cacheIndexedDocument({
      url: 'internal://docs/note.md',
      title: 'Note',
      markdown,
      contentHash: buildContentHash(markdown),
      namespace: 'docs',
      tags: ['type:runbook'],
      expiresAt: null,
      extractorUsed: 'index:markdown',
      metadata: { mime: 'text/markdown' },
      sourcePath: path,
      sourceRoot: dir,
    });
    expect(outcome).toBe('insert');

    const cached = getCachedContent('internal://docs/note.md');
    expect(cached?.namespace).toBe('docs');
    expect(cached?.tags).toEqual(['type:runbook']);
    expect(cached?.fetchMethod).toBe('index');
    expect(cached?.extractorUsed).toBe('index:markdown');
  });

  it('skips when content hash is unchanged', () => {
    const path = join(dir, 'same.md');
    writeFileSync(path, 'same');
    const doc = {
      url: 'internal://docs/same.md',
      title: 'same',
      markdown: 'same',
      contentHash: buildContentHash('same'),
      namespace: 'docs',
      tags: [] as string[],
      expiresAt: null,
      extractorUsed: 'index:markdown',
      metadata: {},
      sourcePath: path,
      sourceRoot: dir,
    };
    expect(cacheIndexedDocument(doc)).toBe('insert');
    expect(cacheIndexedDocument(doc)).toBe('skip');
  });
});
