import { describe, it, expect } from 'vitest';
import { homedir, userInfo } from 'node:os';
import { resolve, sep } from 'node:path';

/**
 * Regression fence for this suite's harness isolation (tests/setup.ts).
 *
 * The previous fix set `WIGOLO_DATA_DIR` only. That is not enough: the host's own
 * config read (`apps/studio/src/main/studio-host.ts:391`) is
 * `process.env.WIGOLO_CONFIG_PATH ?? join(homedir(), '.wigolo', 'config.json')` —
 * it never consults the data-dir variable, so no value of that variable can
 * contain it. Isolation therefore has to move HOME, not just the data dir.
 *
 * `os.userInfo().homedir` reads the password database rather than `$HOME`, so it
 * still names the developer's true profile after the harness repoints HOME —
 * an outside signal this suite cannot move.
 */

const REAL_HOME = userInfo().homedir;

function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

describe('studio test harness -- data dir isolation', () => {
  it('HOME is repointed away from the real profile, so an env-var-blind call site is still contained', () => {
    expect(isInside(homedir(), REAL_HOME)).toBe(false);
  });

  it('the data dir sits inside the repointed home, so both resolutions agree', () => {
    const dataDir = process.env.WIGOLO_DATA_DIR;
    expect(dataDir).toBeDefined();
    expect(isInside(dataDir as string, homedir())).toBe(true);
    expect(isInside(dataDir as string, REAL_HOME)).toBe(false);
  });
});
