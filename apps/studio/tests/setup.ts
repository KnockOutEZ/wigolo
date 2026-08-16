import { mkdirSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Point every app unit test at a throwaway home, and a data dir inside it.
 *
 * Found while wiring S9's authenticated-origin ledger: the host resolves its data dir from
 * `WIGOLO_DATA_DIR` (falling back to `~/.wigolo`), so an app unit test that exercised a host path was
 * READING and WRITING the developer's real profile — and a stale entry in the real ledger then changed the
 * verdict of an unrelated test. Tests that depend on, or mutate, the machine they run on are not tests.
 *
 * Setting `WIGOLO_DATA_DIR` alone was not enough, and the same class of escape then reappeared in the
 * core suite. Most `~/.wigolo` paths never consult that variable: `defaultConfigPath()` in
 * src/persisted-config.ts, the inline `join(homedir(), '.wigolo', 'config.json')` copies in
 * src/cli/config.ts and src/cli/doctor.ts, and `studio-host.ts`'s own config read at line 391 all go
 * straight to `homedir()`. Repointing HOME closes the fallback itself, so a call site that never read
 * the env var — or a test that deletes it — still cannot reach the real profile.
 *
 * Assigned as env vars rather than via a module import so they are in place before any module that
 * resolves config at import time — a static import here would hoist above the assignment.
 */
const TEST_HOME = mkdtempSync(join(tmpdir(), 'wigolo-studio-test-'));
const TEST_DATA_DIR = join(TEST_HOME, '.wigolo');
mkdirSync(TEST_DATA_DIR, { recursive: true });

// Capture the browser engine's real download registry BEFORE HOME moves — it defaults to a path under
// the developer's actual home, and a repointed HOME would make every installed browser look missing.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const home = homedir();
  process.env.PLAYWRIGHT_BROWSERS_PATH =
    process.platform === 'darwin'
      ? join(home, 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(home, 'AppData', 'Local', 'ms-playwright')
        : join(home, '.cache', 'ms-playwright');
}

process.env.HOME = TEST_HOME;
process.env.USERPROFILE = TEST_HOME;
process.env.WIGOLO_DATA_DIR = TEST_DATA_DIR;
