import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';
import { getCachedContent } from '../../../src/cache/store.js';
import { _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { resetConfig } from '../../../src/config.js';
import { ingestFile } from '../../../src/indexing/ingester.js';
import { startIndexWatcher } from '../../../src/indexing/watcher.js';

vi.mock('../../../src/embedding/background-queue.js', () => ({
  getBackgroundIndexQueue: () => ({
    enqueue: vi.fn().mockResolvedValue(undefined),
  }),
}));

describe('startIndexWatcher', () => {
  let dir: string;

  beforeEach(() => {
    _resetMigrationGuard();
    dir = mkdtempSync(join(tmpdir(), 'wigolo-watch-'));
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

  it('re-indexes when a watched file changes', async () => {
    const path = join(dir, 'live.md');
    writeFileSync(path, '# Live\n\nversion one');
    const opts = { namespace: 'docs', tags: [], ttlSeconds: 0, embed: false };
    await ingestFile({ absolutePath: path, relativePath: 'live.md' }, opts, dir);

    const watcher = startIndexWatcher({
      root: dir,
      namespace: 'docs',
      glob: '*.md',
      recursive: true,
      ingestOpts: opts,
    });

    // Let the watcher attach before mutating (parallel suites can delay fs.watch).
    await new Promise((r) => setTimeout(r, 50));
    writeFileSync(path, '# Live\n\nversion two updated');

    const deadline = Date.now() + 3000;
    let cached = getCachedContent('internal://docs/live.md');
    while (Date.now() < deadline && !cached?.markdown.includes('version two updated')) {
      await new Promise((r) => setTimeout(r, 50));
      cached = getCachedContent('internal://docs/live.md');
    }

    watcher.stop();

    expect(cached?.markdown).toMatch(/version two updated/);
  });
});
