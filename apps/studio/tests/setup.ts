import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
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
// Canonicalized on Windows: `os.tmpdir()` there is commonly an 8.3 short path
// (`C:\Users\RUNNER~1\...`), which embeds a literal `~` and is an ALIAS — so a
// string-prefix containment test compares two spellings of one tree and answers
// the wrong question. Resolve once, at creation, so later comparisons are on a
// single spelling. POSIX left alone (realpath there only adds a `/private`
// prefix on macOS, changing a shape that is already proven).
function resolveTestHome(): string {
  const raw = mkdtempSync(join(tmpdir(), 'wigolo-studio-test-'));
  if (process.platform !== 'win32') return raw;
  try {
    return realpathSync.native(raw);
  } catch {
    return raw;
  }
}

const TEST_HOME = resolveTestHome();
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
// Published for the isolation probe so it compares against this file's OWN
// canonical spelling instead of re-deriving one from `tmpdir()`, which differs
// on Windows. Deliberately not a `WIGOLO_*` name — harness state, not product
// config.
process.env.VITEST_WIGOLO_TEST_HOME = TEST_HOME;
process.env.WIGOLO_DATA_DIR = TEST_DATA_DIR;
