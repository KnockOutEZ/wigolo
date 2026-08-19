import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { resetConfig } from '../../../src/config.js';
import { handleFetch } from '../../../src/tools/fetch.js';
import { handleIndex } from '../../../src/tools/index.js';

vi.mock('../../../src/embedding/background-queue.js', () => ({
  getBackgroundIndexQueue: () => ({
    enqueue: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  }),
}));

function mockRouter() {
  return { fetch: vi.fn(), getDomainStats: vi.fn() };
}

describe('fetch internal:// URLs', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-fetch-int-'));
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

  it('returns cache_miss when document was never indexed', async () => {
    const out = await handleFetch(
      { url: 'internal://docs/missing.md' },
      mockRouter() as never,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toBe('cache_miss');
      expect(out.error_reason).toMatch(/missing\.md/);
    }
  });

  it('serves indexed internal documents without HTTP fetch', async () => {
    const file = join(dir, 'guide.md');
    writeFileSync(file, '# Guide\n\ninternal fetch path');
    await handleIndex({ source: file, namespace: 'docs' });

    const router = mockRouter();
    const out = await handleFetch(
      { url: 'internal://docs/guide.md' },
      router as never,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.fetch_method).toBe('cache');
      expect(out.data.cached).toBe(true);
      expect(out.data.markdown).toMatch(/internal fetch path/);
    }
    expect(router.fetch).not.toHaveBeenCalled();
  });
});
