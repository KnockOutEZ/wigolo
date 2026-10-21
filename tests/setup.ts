import { beforeEach, afterEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate the data dir so the suite NEVER writes to a developer's real
// ~/.wigolo (a vitest worker otherwise opens the live wigolo.db). One dir per
// worker process, reused across the files that worker runs. The path contains
// `.wigolo` so config's default-path assertion still holds. Tests that need a
// specific dir set WIGOLO_DATA_DIR themselves — the guard respects it. Several
// tests `delete process.env.WIGOLO_DATA_DIR` in cleanup to restore the
// "unset" state; re-asserting in beforeEach (only when unset) stops the next
// test in that worker from falling back to the real home dir. Invisible on CI
// (throwaway HOME), decisive locally.
const TEST_DATA_DIR = join(tmpdir(), 'wigolo-test', String(process.pid), '.wigolo');
function ensureTestDataDir(): void {
  if (!process.env.WIGOLO_DATA_DIR) {
    mkdirSync(TEST_DATA_DIR, { recursive: true });
    process.env.WIGOLO_DATA_DIR = TEST_DATA_DIR;
  }
}
ensureTestDataDir();

// Default reranker to 'none' in tests so the cross-encoder model isn't lazily
// downloaded. Tests that exercise the reranker explicitly set
// WIGOLO_RERANKER='onnx' and mock the rerank provider in their own scope.
if (!process.env.WIGOLO_RERANKER) {
  process.env.WIGOLO_RERANKER = 'none';
}

// Phase 0: production default flipped from `searxng` to `core`. Most existing
// tests were authored against the legacy SearXNG path (they pass a mock engines
// array to handleSearch). Pin the test-suite default back to `searxng` so
// pre-Phase-0 tests keep their semantics. Tests that exercise the new default
// or any other backend override this per-test with process.env.WIGOLO_SEARCH.
if (!process.env.WIGOLO_SEARCH) {
  process.env.WIGOLO_SEARCH = 'searxng';
}

// The driver-hardened stealth launcher (`patchright`) ships as an INSTALLED
// optionalDependency, and `stealthDriver` defaults to 'auto' — so the dedicated
// stealth path prefers it over the standard launcher. That silently escapes
// every `vi.mock('playwright')` in the suite: the pool launches a REAL browser,
// navigates to a fake host, and the test fails on ERR_NAME_NOT_RESOLVED rather
// than exercising its mock. It cost 22 failures that read as environmental
// flake. Pin the suite to the standard driver — `resolveStealthLauncher`
// short-circuits on this mode and never probes the optional package.
//
// Env, deliberately: a static `import` of the stealth module here would be
// hoisted above the assignments in this file (populating the config cache with
// the wrong search backend), and a dynamic import inside a hook would execute
// the src graph inside each test file's own mocked-fs/os context. A test that
// genuinely exercises the hardened driver overrides this var in its own scope.
if (!process.env.WIGOLO_STEALTH_DRIVER) {
  process.env.WIGOLO_STEALTH_DRIVER = 'playwright';
}

// Isolate CI-detection env vars from the host. Production code in
// `src/cli/config.ts` and `src/cli/tui/theme/motion-guard.ts` (correctly)
// disables Ink mount and TUI motion when CI/GITHUB_ACTIONS are set. Under
// GitHub Actions runners those vars are always present, which would otherwise
// silently flip TUI tests into reduced-motion mode and skip Ink-mount paths.
// Per-test cases that need to assert CI-on behavior set the var inside their
// own `it(...)` block; this save/restore guarantees each test starts with a
// clean slate and the host's CI vars never leak into assertions.
const CI_ENV_KEYS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_RUN_ID',
  'CONTINUOUS_INTEGRATION',
] as const;

const savedCIEnv: Partial<Record<(typeof CI_ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  ensureTestDataDir();
  for (const key of CI_ENV_KEYS) {
    savedCIEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of CI_ENV_KEYS) {
    const orig = savedCIEnv[key];
    if (orig === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = orig;
    }
  }
});
