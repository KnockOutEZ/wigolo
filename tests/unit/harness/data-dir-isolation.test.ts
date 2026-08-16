import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
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
 * real write through the production path must land inside the harness home and
 * must not reach the developer's real `~/.wigolo`.
 *
 * WHAT THE INVARIANT IS, AND WHAT IT IS NOT.
 * An earlier revision asserted "the harness tree is not inside the real HOME".
 * That is a PROXY, and on Windows it is unsatisfiable: `os.tmpdir()` lives under
 * `C:\Users\<user>\AppData\Local\Temp`, so the harness home is *physically*
 * inside the profile — while `userInfo().homedir` reports the long form and the
 * harness reported an 8.3 alias, so a string-prefix test could not see it and
 * the proxy passed for the wrong reason. Same failure shape as the
 * `not.toContain('~')` assertion this branch also had to fix: a proxy that held
 * only by accident of the strings involved.
 *
 * The invariant that actually matters is narrower and platform-neutral: nothing
 * may resolve to the developer's real `~/.wigolo`. `<TEST_HOME>/.wigolo` is a
 * different directory from `<REAL_HOME>/.wigolo` on every platform, including
 * when TEST_HOME sits inside the profile. So every assertion below is made
 * against the real DATA DIR, never against the profile directory.
 *
 * `os.userInfo().homedir` is the outside signal — it reads the password
 * database, not `$HOME`, so it still names the developer's true profile after
 * the harness has repointed HOME. Nothing under test can move it.
 *
 * SAFETY: the path fence is asserted BEFORE any write. On a regression the
 * expectation throws and the probe returns without touching the real profile —
 * a probe that can corrupt the thing it protects is worse than the bug.
 */

/**
 * The harness's OWN canonical spelling of its home, published by tests/setup.ts.
 * Re-deriving it from `tmpdir()` here would reintroduce the short-vs-long-path
 * mismatch on Windows. Absent → the guard has been removed wholesale, which is
 * itself the regression, so the probe fails loudly rather than skipping.
 */
const TEST_HOME = process.env.VITEST_WIGOLO_TEST_HOME;
const REAL_HOME = userInfo().homedir;
const REAL_DATA_DIR = join(REAL_HOME, '.wigolo');

function isInside(child: string, parent: string): boolean {
  let c = resolve(child);
  let p = resolve(parent);
  // Windows paths are case-insensitive; `userInfo()` and the environment do not
  // always agree on casing, and a case-sensitive compare would answer "outside"
  // for a path that is actually inside.
  if (process.platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
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

  it('the harness publishes a home, and the real data dir is not inside it (probe sanity)', () => {
    // Preconditions for everything below. If the harness stopped publishing a
    // home, or the real ~/.wigolo somehow sat inside the harness tree, every
    // other assertion in this file would pass vacuously.
    expect(TEST_HOME).toBeTruthy();
    expect(isInside(REAL_DATA_DIR, TEST_HOME as string)).toBe(false);
  });

  it('a test that deletes WIGOLO_DATA_DIR cannot write outside the harness home', () => {
    const saved = process.env.WIGOLO_DATA_DIR;
    try {
      // The documented hole: ~25 test files do exactly this in cleanup.
      delete process.env.WIGOLO_DATA_DIR;
      resetConfig();
      resetPersistedConfig();

      const path = defaultConfigPath();

      // FENCE — asserted before the write. A regression stops the probe here.
      expect(isInside(path, REAL_DATA_DIR)).toBe(false);
      expect(isInside(path, TEST_HOME as string)).toBe(true);

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

  it('every data-dir-derived config path stays inside the harness home after the delete', () => {
    const saved = process.env.WIGOLO_DATA_DIR;
    try {
      delete process.env.WIGOLO_DATA_DIR;
      resetConfig();

      const cfg = getConfig();
      // dataDir, and everything derived from it, must fall back into the
      // harness home — not `join(homedir(), '.wigolo')` on the real profile.
      for (const p of [cfg.dataDir, cfg.pluginsDir, cfg.shellHistoryPath]) {
        expect(isInside(p, REAL_DATA_DIR)).toBe(false);
        expect(isInside(p, TEST_HOME as string)).toBe(true);
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
    // Asserted as directory IDENTITY of the resolved data dir, not as
    // "homedir() is outside the profile" — see the docblock.
    expect(isInside(join(homedir(), '.wigolo'), REAL_DATA_DIR)).toBe(false);
    expect(isInside(homedir(), TEST_HOME as string)).toBe(true);
  });
});
