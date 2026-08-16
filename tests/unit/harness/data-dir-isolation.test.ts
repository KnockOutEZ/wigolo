import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { getConfig, resetConfig } from '../../../src/config.js';
import {
  defaultConfigPath,
  writePersistedConfig,
  resetPersistedConfig,
} from '../../../src/persisted-config.js';

/**
 * Falsifiability probe for the harness's data-dir isolation.
 *
 * The claim under test is NOT "tests/setup.ts assigns WIGOLO_DATA_DIR" — an
 * assertion on the guard's presence cannot fail when the behaviour regresses,
 * because the guard is only half the resolution. Every `~/.wigolo` default in
 * `src/` is `process.env.WIGOLO_DATA_DIR ?? join(homedir(), '.wigolo')`, and
 * several (`defaultConfigPath`, `src/cli/config.ts`, `src/cli/doctor.ts`) skip
 * the env var entirely and read `homedir()` directly. So the guard alone is
 * defeated two ways: a test that deletes the var, and any call site that never
 * consulted it. Both land on the developer's real profile.
 *
 * The claim asserted here is the outcome: AFTER a test deletes the env var, a
 * real write through the production path must land inside the harness tree and
 * must not reach the real home.
 *
 * `os.userInfo().homedir` is the outside signal — it reads the password
 * database, not `$HOME`, so it still names the developer's true profile after
 * the harness has repointed HOME. Nothing under test can move it.
 *
 * SAFETY: the path fence is asserted BEFORE any write. On a regression the
 * expectation throws and the probe returns without touching the real profile —
 * a probe that can corrupt the thing it protects is worse than the bug.
 */

const TEST_ROOT = join(tmpdir(), 'wigolo-test');
const REAL_HOME = userInfo().homedir;

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Restore a path to exactly the bytes it held before the probe wrote to it. */
function restore(path: string, before: string | null): void {
  if (before === null) rmSync(path, { force: true });
  else writeFileSync(path, before);
}

describe('test harness -- data dir isolation', () => {
  afterEach(() => {
    resetConfig();
    resetPersistedConfig();
  });

  it('the real home is a different tree from the harness root (probe sanity)', () => {
    // If these ever overlapped, every assertion below would pass vacuously.
    expect(isInside(TEST_ROOT, REAL_HOME)).toBe(false);
    expect(isInside(REAL_HOME, TEST_ROOT)).toBe(false);
  });

  it('a test that deletes WIGOLO_DATA_DIR cannot write outside the harness tree', () => {
    const saved = process.env.WIGOLO_DATA_DIR;
    try {
      // The documented hole: ~25 test files do exactly this in cleanup.
      delete process.env.WIGOLO_DATA_DIR;
      resetConfig();
      resetPersistedConfig();

      const path = defaultConfigPath();

      // FENCE — asserted before the write. A regression stops the probe here.
      expect(isInside(path, join(REAL_HOME, '.wigolo'))).toBe(false);
      expect(isInside(path, TEST_ROOT)).toBe(true);

      const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
      try {
        // A REAL write through the production writer, not a path computation.
        writePersistedConfig(path, { settings: { __isolationProbe: 'sentinel' } });

        expect(existsSync(path)).toBe(true);
        const written = JSON.parse(readFileSync(path, 'utf8')) as {
          settings: Record<string, unknown>;
        };
        expect(written.settings.__isolationProbe).toBe('sentinel');
      } finally {
        restore(path, before);
        resetPersistedConfig();
      }
    } finally {
      if (saved === undefined) delete process.env.WIGOLO_DATA_DIR;
      else process.env.WIGOLO_DATA_DIR = saved;
      resetConfig();
      resetPersistedConfig();
    }
  });

  it('every data-dir-derived config path stays inside the harness tree after the delete', () => {
    const saved = process.env.WIGOLO_DATA_DIR;
    try {
      delete process.env.WIGOLO_DATA_DIR;
      resetConfig();

      const cfg = getConfig();
      // dataDir, and everything derived from it, must fall back into the
      // harness tree — not `join(homedir(), '.wigolo')` on the real profile.
      for (const p of [cfg.dataDir, cfg.pluginsDir, cfg.shellHistoryPath]) {
        expect(isInside(p, REAL_HOME)).toBe(false);
        expect(isInside(p, TEST_ROOT)).toBe(true);
      }
    } finally {
      if (saved === undefined) delete process.env.WIGOLO_DATA_DIR;
      else process.env.WIGOLO_DATA_DIR = saved;
      resetConfig();
    }
  });

  it('homedir() itself is repointed, so a call site that never reads WIGOLO_DATA_DIR is still contained', () => {
    // `defaultConfigPath` and the six inline copies of
    // `join(homedir(), '.wigolo', 'config.json')` in src/cli never consult the
    // env var. Containing them requires the FALLBACK to be safe, not the guard.
    expect(isInside(homedir(), TEST_ROOT)).toBe(true);
    expect(isInside(homedir(), REAL_HOME)).toBe(false);
  });
});
