import { describe, it, expect } from 'vitest';
import { homedir, userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Regression fence for this suite's harness isolation (tests/setup.ts).
 *
 * The previous fix set `WIGOLO_DATA_DIR` only. That is not enough: the host's own
 * config read (`apps/studio/src/main/studio-host.ts:391`) is
 * `process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json')` —
 * it never consults the data-dir variable, so no value of that variable can
 * contain it. Isolation therefore has to move HOME, not just the data dir.
 *
 * Asserted against the real DATA DIR, never against the profile directory. On
 * Windows `os.tmpdir()` lives under `C:\Users\<user>\AppData\Local\Temp`, so the
 * harness home is physically inside the profile and "outside the profile" is an
 * unsatisfiable proxy — it only appeared to hold because the harness reported an
 * 8.3 alias that a string-prefix test could not match. `<TEST_HOME>/.wigolo` is
 * a different directory from `<REAL_HOME>/.wigolo` on every platform, which is
 * the invariant that actually matters.
 *
 * `os.userInfo().homedir` reads the password database rather than `$HOME`, so it
 * still names the developer's true profile after the harness repoints HOME —
 * an outside signal this suite cannot move.
 */

const TEST_HOME = process.env.VITEST_WIGOLO_TEST_HOME;
const REAL_DATA_DIR = join(userInfo().homedir, '.wigolo');

function isInside(child: string, parent: string): boolean {
  let c = resolve(child);
  let p = resolve(parent);
  if (process.platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

describe('studio test harness -- data dir isolation', () => {
  it('the harness publishes a home, and the real data dir is not inside it (probe sanity)', () => {
    expect(TEST_HOME).toBeTruthy();
    expect(isInside(REAL_DATA_DIR, TEST_HOME as string)).toBe(false);
  });

  it('HOME is repointed, so an env-var-blind call site cannot reach the real data dir', () => {
    expect(isInside(join(homedir(), '.wigolo'), REAL_DATA_DIR)).toBe(false);
    expect(isInside(homedir(), TEST_HOME as string)).toBe(true);
  });

  it('the data dir sits inside the repointed home, so both resolutions agree', () => {
    const dataDir = process.env.WIGOLO_DATA_DIR;
    expect(dataDir).toBeDefined();
    expect(isInside(dataDir as string, homedir())).toBe(true);
    expect(isInside(dataDir as string, REAL_DATA_DIR)).toBe(false);
  });
});
