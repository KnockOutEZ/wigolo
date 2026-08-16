import { beforeEach, afterEach } from 'vitest';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { installNetworkFence } from './net-fence.js';

// A test's result must not depend on whether the runner can reach the internet. See
// `net-fence.ts` for the defect this closes and for what it deliberately does not cover.
//
// Imported statically, and safely so: `net-fence.ts` pulls in `node:net` and `vitest` and
// NOTHING from `src/`. That distinction is the whole reason the stealth-driver pin below is an
// env var instead of an import — a static `src/` import here hoists above the assignments in
// this file and populates the config cache with the wrong values. A leaf module with no src
// edges cannot do that, so it does not need the env-var workaround.
installNetworkFence();

// Isolate the data dir so the suite NEVER writes to a developer's real
// ~/.wigolo (a vitest worker otherwise opens the live wigolo.db). One home per
// worker process, reused across the files that worker runs. The data dir sits
// at `<TEST_HOME>/.wigolo`, so its path still contains `.wigolo` and config's
// default-path assertions hold. Tests that need a specific dir set
// WIGOLO_DATA_DIR themselves — the guard respects it.
//
// WHY HOME IS REPOINTED, not just WIGOLO_DATA_DIR.
// Setting the env var alone is a suggestion, not a default, and it failed twice:
//
//   1. ~25 test files `delete process.env.WIGOLO_DATA_DIR` in cleanup to restore
//      the "unset" state. Re-asserting it in beforeEach only protects the NEXT
//      test — anything the deleting test (or the rest of its own afterEach) does
//      afterwards still resolves through the fallback.
//   2. More decisively, most `~/.wigolo` paths in src/ never consult the env var
//      at all: `defaultConfigPath()` (src/persisted-config.ts), and six inline
//      copies of `join(homedir(), '.wigolo', 'config.json')` across
//      src/cli/config.ts and src/cli/doctor.ts, read `homedir()` directly. So
//      does `shellHistoryPath` (src/config.ts). `WIGOLO_DATA_DIR` is
//      STRUCTURALLY INCAPABLE of isolating those. That is how
//      tests/unit/cli/plugin.test.ts — which mocks `readFileSync` to return a
//      plugin package.json but leaves `writeFileSync` real — overwrote a
//      developer's actual ~/.wigolo/config.json with `{"version":1,"settings":
//      {"name":"plugin-a","main":"index.mjs"}}` while the env-var guard was
//      fully in force.
//
// Both holes share one cause: the FALLBACK is the developer's real home. Repoint
// HOME and the fallback lands in the throwaway tree instead, so no delete and no
// env-var-blind call site can escape. `os.homedir()` reads $HOME/%USERPROFILE%,
// and individual assignment (never `process.env = {...}`) re-`setenv`s it so the
// C layer sees it too.
//
// KNOWN AND ACCEPTED SIDE EFFECT — the macOS login keychain also resolves through
// $HOME, so this suite no longer sees it. Measured:
//
//     $ security list-keychains                 -> login.keychain-db + System.keychain
//     $ HOME=/tmp/fake security list-keychains  -> System.keychain only
//
// `getConfig()` reads provider credentials from the keychain (see
// `resolveCredentialUrl` / `resolveKeychainSecret` in src/config.ts), and
// `keychainAvailable()` only constructs an `Entry` without performing I/O — so it
// still returns true and the degradation surfaces as a silent "credential not
// found" rather than a clean "keychain unavailable".
//
// This is DELIBERATE, not an oversight. Reading the developer's real credentials
// is the same contamination class as writing their real config: it is what made
// two agents disagree about whether an LLM key was configured. Tests must not
// depend on the machine they run on. The cost is that the local keyed-LLM
// failure profile changes — those failures already swing 0-23 locally and are
// classified by CAUSE, never by count. A test that genuinely needs a credential
// must inject it, not harvest one from the developer's login keychain.
//
// The home is CANONICALIZED on Windows. `os.tmpdir()` there commonly returns an
// 8.3 short path (`C:\Users\RUNNER~1\AppData\Local\Temp`), which breaks two
// separate things. It embeds a literal `~`, so any assertion using "contains no
// tilde" as a proxy for "the leading tilde was expanded" fails on a correctly
// expanded path. And it is an ALIAS: a string-prefix containment test then
// compares two different spellings of the same tree and confidently answers the
// wrong question — which is how a probe written specifically to prevent vacuous
// passes can itself pass vacuously. Resolve to the long form once, at creation,
// so every later comparison is on one spelling. POSIX is deliberately left
// alone: realpath there only rewrites `/var/folders/...` to `/private/var/...`,
// which buys nothing and perturbs a path shape that is already proven green.
function resolveTestHome(): string {
  const raw = join(tmpdir(), 'wigolo-test', String(process.pid));
  mkdirSync(join(raw, '.wigolo'), { recursive: true });
  if (process.platform !== 'win32') return raw;
  try {
    return realpathSync.native(raw);
  } catch {
    return raw;
  }
}

const TEST_HOME = resolveTestHome();
const TEST_DATA_DIR = join(TEST_HOME, '.wigolo');

// Capture the browser engine's real download registry BEFORE HOME moves — it
// defaults to a path under the developer's actual home, and a repointed HOME
// would otherwise make every already-installed browser look missing.
function realBrowsersPath(): string {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}

function ensureTestDataDir(): void {
  mkdirSync(TEST_DATA_DIR, { recursive: true });
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = realBrowsersPath();
  }
  // Unconditional: HOME is always set, so a "only when unset" guard would never
  // fire. A test that needs the real home, or its own, assigns HOME in its own
  // beforeEach — which runs after this one (setup-file hooks register first).
  process.env.HOME = TEST_HOME;
  process.env.USERPROFILE = TEST_HOME;
  // Published for the isolation probe so it compares against the harness's OWN
  // canonical spelling rather than re-deriving one from `tmpdir()` — on Windows
  // those two differ (short vs long form) and a prefix test between them is
  // meaningless. Not a `WIGOLO_*` name: this is harness state, and must never
  // be mistaken for product config or inherited as such by a spawned child.
  process.env.VITEST_WIGOLO_TEST_HOME = TEST_HOME;
  if (!process.env.WIGOLO_DATA_DIR) {
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
