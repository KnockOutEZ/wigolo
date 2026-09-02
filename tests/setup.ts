import { beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installNetworkFence } from './net-fence.js';
import { RUN_DIR_ENV, TEST_HOME_ROOT } from './global-setup.js';
import { generateMintKeyPair, mintToken, grant, payload } from './unit/account/mint-entitlement.js';

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
// THE HOME IS NOT CANONICALIZED HERE, and that is the fix rather than an omission.
// Windows' `os.tmpdir()` answers with an 8.3 short path
// (`C:\Users\RUNNER~1\AppData\Local\Temp`) while `realpath` answers with the long
// one; canonicalising the LEAF while its parent kept the short spelling is precisely
// what made `dirname(home) !== runDir` on CI, for one directory under two names.
// `TEST_HOME_ROOT` is canonicalised once instead (see `global-setup.ts`), so every
// path minted inside it — the run directory, then this home — inherits that one
// spelling by construction. Containment is then structural, and no call site has to
// remember to normalise. Re-resolving here would reintroduce the asymmetry the
// moment `RUN_DIR_ENV` arrived spelled any other way.
//
// THE NAME IS MINTED, NOT DERIVED FROM THE PID.
// This used to be `join(tmpdir(), 'wigolo-test', String(process.pid))`. Pids are
// reused, and the reuse was not hypothetical: of 73,547 leftover homes measured on
// a developer machine, 2,054 held files written 76-118 HOURS after the directory
// was created — a later, unrelated process resolving $HOME onto a dead one's state.
// A suite whose result depends on which pid the OS happened to hand out is not
// deterministic, so the name now comes from `mkdtemp` and cannot alias.
//
// ONE HOME PER PROCESS, WHICH IS EXACTLY WHAT THE PID NAMING GAVE. Measured, because
// the obvious reading of the config is wrong: under `isolate: true` vitest's forks
// pool starts a FRESH PROCESS for every test file, including in the `spawn-serial`
// project — `singleFork` removes parallelism, not per-file isolation. Five
// integration files under that project produced five homes, not one. So the
// per-worker reuse the old comment claimed was never happening, and this change
// preserves the real behaviour rather than an imagined one.
//
// The memoisation is still here, and is a guard rather than an optimisation: it is
// what keeps `mkdtemp` from minting a home per FILE if a process ever does evaluate
// this file twice (`isolate: false`, or a future pool change). `process.env` is the
// one channel that survives vitest's module-registry reset, and the entry is
// validated against the LIVE pid so a value inherited by a spawned child can never
// be mistaken for our own. Note the pid is used here as an OWNERSHIP CHECK against a
// running process, never as a NAME recording history — that distinction is precisely
// what the reuse bug was.
// WHO DELETES IT. Homes are minted inside the per-invocation `run-*` directory that
// `global-setup.ts` publishes, and its teardown removes that one directory — which
// contains exactly this run's homes and, by containment, none of a concurrent run's.
//
// A per-worker `process.on('exit')` remover was written first and MEASURED not to
// fire: vitest's `forks` pool signals workers rather than letting them exit, so a
// 31-file suite still left all 31 directories behind with the hook installed. It was
// deleted rather than kept as decoration. `RUN_DIR_ENV` being absent is therefore a
// real fallback, not a theoretical one (a bare `vitest` invocation against a config
// without the global setup): mint under the root instead, where the staleness reap
// still reclaims it.
const HOME_OWNER_KEY = 'VITEST_WIGOLO_TEST_HOME_PID';

function homeParent(): string {
  const runDir = process.env[RUN_DIR_ENV];
  return runDir && existsSync(runDir) ? runDir : TEST_HOME_ROOT;
}

function claimTestHome(): string {
  const existing = process.env.VITEST_WIGOLO_TEST_HOME;
  if (existing && process.env[HOME_OWNER_KEY] === String(process.pid) && existsSync(existing)) {
    return existing;
  }

  const parent = homeParent();
  mkdirSync(parent, { recursive: true });
  const home = mkdtempSync(join(parent, 'home-'));
  mkdirSync(join(home, '.wigolo'), { recursive: true });

  process.env[HOME_OWNER_KEY] = String(process.pid);
  return home;
}

const TEST_HOME = claimTestHome();

// What the reaper in `global-setup.ts` actually measures the age of: a direct child
// of the root. Touching our own home would not update the run directory's mtime, so
// the heartbeat has to target the unit the reaper compares.
const REAP_UNIT = process.env[RUN_DIR_ENV] ?? TEST_HOME;

// Published so the choice of target is CHECKABLE. Asserting "the run directory looks
// fresh" cannot fail — a run directory is minted seconds before the assertions read
// it, so that probe passes whether the heartbeat lands on the right path, the wrong
// path, or nowhere at all. Naming the target is the only form of the claim a
// mis-wiring can falsify.
process.env.VITEST_WIGOLO_REAP_UNIT = REAP_UNIT;
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

// ── The suite runs as an ACTIVATED install (PX2 #222) ────────────────────────
//
// 0.3.0 refuses every tool call until `wigolo register` has run: the gate sits
// atop MCP `tools/call`, the daemon's `/v1` + compat routes, `serve` start, the
// one-shot CLI and the REPL. The throwaway HOME above has no account state, so
// without this every one of those surfaces would refuse — and roughly a thousand
// tests that are about fetching, ranking, fencing or routing would go red for a
// reason that has nothing to do with what they assert.
//
// So the suite's default install is activated, exactly the way a user's is:
// a real Ed25519 keypair, a real signed entitlement token carrying a perpetual
// `core` grant, written to the real `state.json` path, with the public half
// pinned through the same `WIGOLO_ACCOUNTS_PUBKEY` override that dev and RC runs
// use. NOTHING IS BYPASSED — no test-mode branch exists in `src/`, and the gate
// evaluates all six of its steps here just as it does in production. A test that
// wants an UN-activated install gets one by pointing `WIGOLO_DATA_DIR` at an
// empty directory; the gate's own arms do precisely that, which is what keeps
// them a real signal rather than a restatement of this seeding.
//
// The mint helper is imported statically and safely: like `net-fence.ts` it
// pulls in `node:crypto` and NOTHING from `src/`, so it cannot hoist above the
// env assignments in this file the way a `src/` import would.
//
// A test that has already pinned its own key is left alone — that is the signal
// "this file is running its own account fixture".
function activateTestInstall(): void {
  if (process.env.WIGOLO_ACCOUNTS_PUBKEY) return;
  const keys = generateMintKeyPair();
  const { token } = mintToken(
    keys,
    payload({
      account_id: 'acct_test_suite',
      valid_until: '2099-01-01T00:00:00.000Z',
      grants: [grant({ product: 'core', type: 'perpetual' })],
    }),
  );
  const dir = join(TEST_DATA_DIR, 'account');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify(
      {
        account_id: 'acct_test_suite',
        email: 'suite@example.invalid',
        entitlement_token: token,
        last_refresh_at: new Date().toISOString(),
        last_refresh_attempt_at: new Date().toISOString(),
        refresh_expires_at: '2099-01-01T00:00:00.000Z',
        needs_relogin: false,
        disclosure_version: 'test',
        marketing_consent: false,
      },
      null,
      2,
    ),
    { encoding: 'utf8', mode: 0o600 },
  );
  process.env.WIGOLO_ACCOUNTS_PUBKEY = keys.publicKeyB64Url;
}
activateTestInstall();

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

// Liveness signal for the reap in `global-setup.ts`. A concurrent suite's home must
// never be deleted, and there were three concurrent runs on this machine the day
// this landed. `process.kill(pid, 0)` is the obvious probe and is unusable for the
// same reason the pid NAMING was; `flock` is authoritative but Node only exposes it
// as `O_EXLOCK` on macOS/BSD and this suite gates on three OSes.
//
// So "alive" is defined as "made test progress recently", refreshed from the hook
// that every single test runs. That needs no timer and does not depend on the event
// loop being free — it is driven by the thing whose liveness is in question.
// Throttled because 10k+ tests do not need 10k+ utimes calls.
//
// THE CLOCK STARTS AT MODULE LOAD, NOT AT ZERO, and that is load-bearing rather than
// cosmetic. Under `isolate: true` every test FILE is a fresh process, so module state
// resets per file: seeding this at 0 made the throttle vacuous and fired one utimes
// per file — ~790 metadata WRITES aimed at a single shared directory from a dozen
// concurrent workers. On APFS that is 0.011ms and invisible, which is precisely why a
// green local run is no evidence here; on NTFS a directory metadata write serialises
// against the concurrent `CreateDirectory` calls every other worker is making in that
// same directory to mint its own home.
//
// Dropping those writes costs nothing, because the filesystem already performs the
// refresh: creating a child directory advances its PARENT's mtime, and `claimTestHome`
// mints a home directly inside the reaped unit as every file starts. Measured, both
// halves — the parent's mtime advances on a child mkdir, and does NOT advance on a
// GRANDCHILD mkdir, which is why the reaped unit has to be the run directory and not
// the home nested inside it.
//
// So a file finishing inside the window writes nothing and is still fresh, while a
// file that genuinely outruns the window heartbeats on a later hook. The one case
// neither mechanism reaches — a SINGLE test running longer than the window, with no
// further hook to fire from — is unchanged by this, since the old code's one write
// landed milliseconds after the mkdir it duplicated. A 20s testTimeout puts that case
// out of reach anyway.
const HEARTBEAT_INTERVAL_MS = 30_000;
let lastHeartbeatMs = Date.now();

function heartbeat(): void {
  const now = Date.now();
  if (now - lastHeartbeatMs < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeatMs = now;
  try {
    const stamp = new Date(now);
    utimesSync(REAP_UNIT, stamp, stamp);
  } catch {
    // Only degrades how soon this home looks abandoned. Never fails a test.
  }
}

beforeEach(() => {
  ensureTestDataDir();
  heartbeat();
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
