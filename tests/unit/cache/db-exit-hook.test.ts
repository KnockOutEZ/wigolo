import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDatabase, closeDatabase } from '../../../src/cache/db.js';

describe('db exit hook', () => {
  const dirs: string[] = [];

  afterEach(() => {
    closeDatabase();
    while (dirs.length) {
      try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it('registers a single process-exit listener even across many initDatabase calls', () => {
    const before = process.listenerCount('exit');

    for (let i = 0; i < 3; i++) {
      const dir = mkdtempSync(join(tmpdir(), 'wigolo-db-exit-'));
      dirs.push(dir);
      const db = initDatabase(join(dir, 'wigolo.db'));
      expect(db).toBeDefined();
      closeDatabase();
    }

    const after = process.listenerCount('exit');
    expect(after - before).toBeLessThanOrEqual(1);
  });

  it('closeDatabase is safe to call when no instance is open', () => {
    closeDatabase();
    expect(() => closeDatabase()).not.toThrow();
  });
});
