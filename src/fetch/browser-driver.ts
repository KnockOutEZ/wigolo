import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { BrowserType } from 'playwright';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

/**
 * S10-e — the ONE place the browser driver package is resolved.
 *
 * The driver left the default install path: it is an OPTIONAL PEER dependency, which npm does
 * not install, rather than a hard `dependencies` entry that every install pays for. That is the
 * whole size lever, and it only works if no module in `src/` holds a VALUE import of the
 * package — a single top-level `import { chromium } from 'playwright'` makes the module graph
 * unloadable the moment the package is absent, which turns a missing optional rung into a
 * crashed process.
 *
 * So the five value imports (`browser-pool`, `playwright-tier`, `browser-probe`,
 * `browser-acquire`, `studio/session-browser`) all route through here. TYPE imports stay
 * literal everywhere, including this file: they are erased at compile time and cost nothing at
 * runtime, and keeping them is what lets the rest of the code stay fully typed against a
 * package that may not be on disk. Only the value edge is lazy.
 *
 * This mirrors a pattern the repo has already paid for twice — `stealth.ts`'s `patchright` and
 * `cdp-direct.ts`'s `chrome-remote-interface` — with one difference that matters: those degrade
 * to a weaker rung, this one degrades to NO browser rung, so it carries an acquisition path
 * (`browser-acquire.ts`) rather than a silent `null`.
 *
 * ⚠ RESOLUTION HAS TWO ROOTS, and both are needed. A driver can arrive either alongside wigolo
 * (a user who installed it themselves, or a global sibling) or in wigolo's own data directory
 * (acquired by `warmup --browser`). Probing only the first would make everything the acquirer
 * installs invisible to the thing that asked for it.
 */

/** The subset of the driver package wigolo consumes: the three engine handles. */
export interface BrowserDriverModule {
  chromium: BrowserType;
  firefox: BrowserType;
  webkit: BrowserType;
}

/**
 * Held as a non-literal `string` so the compiler skips module resolution — the package is an
 * optional peer and may legitimately be absent. Same reason as `PATCHRIGHT_MODULE_ID`.
 */
const DRIVER_MODULE_ID: string = 'playwright';

/*
 * ⚠ The `import()` below spells the specifier INLINE rather than reusing the constant above,
 * and the two are not interchangeable. Interception and bundling both work off a statically
 * analysable specifier, and a `const`-bound string is not one — routing the dynamic import
 * through a variable resolved the REAL package straight past a mock, and would likewise be
 * dropped by a bundler. The `string`-typed constant remains for the `createRequire` path, where
 * its whole job is the opposite: to stop `tsc` resolving a package that may be absent.
 */

/** Directory under `dataDir` that `warmup --browser` installs the driver into. */
export const DRIVER_INSTALL_DIRNAME = 'browser-driver';

/**
 * The driver revision wigolo acquires when it has to acquire one.
 *
 * ⚠ A duplicated version is a version that drifts. This constant is the acquirer's, the
 * manifest's `peerDependencies` range is the resolver's, and a test asserts the constant
 * satisfies the range — so the pair cannot silently disagree about which revision "the browser
 * rung" means. Matching revisions matter here beyond tidiness: the driver and its browser
 * binary are versioned together, and a mismatch shows up as `executablePath()` pointing at a
 * revision directory that does not exist.
 */
export const BROWSER_DRIVER_VERSION = '1.60.0';

/**
 * Capability-language refusal for a rung that needs the driver and has none. Names the remedy,
 * because a rung that vanishes without one is indistinguishable from a broken install (D-S10-9).
 */
export const BROWSER_DRIVER_MISSING_ERROR =
  'browser engine not installed on this machine — run `wigolo warmup --browser` to acquire it';

const log = createLogger('fetch');

let _cached: BrowserDriverModule | null = null;
let _resolved = false;
/**
 * The in-flight resolution, so concurrent first callers join one import instead of each
 * starting their own.
 *
 * ⚠ Memoizing the VALUE is not enough and the difference is observable. `doctor` probes
 * chromium, firefox and webkit through `Promise.all`, so three callers reach this function
 * before any of them has finished awaiting — with only a value memo, all three resolve the
 * module independently. The same shape is what `stealth.ts` and `cdp-direct.ts` already do for
 * their optional packages; omitting it here made a concurrent probe resolve a DIFFERENT module
 * instance than its siblings.
 */
let _inFlight: Promise<BrowserDriverModule | null> | null = null;
/**
 * The synchronous path memoizes SEPARATELY, and the separation is load-bearing rather than an
 * oversight. The two mechanisms agree in production by construction — `import()` and
 * `createRequire` from this same file resolve the same package from the same two roots — so a
 * shared memo bought nothing there. What it did buy was an ordering hazard: whichever path ran
 * first decided the answer for both, and only the async one is visible to the module graph. A
 * single early on-disk probe could therefore pin the driver for the whole process to something
 * the async path was never given a chance to resolve.
 */
let _syncCached: BrowserDriverModule | null = null;
let _syncResolved = false;
let _testOverride: BrowserDriverModule | null | undefined;

/**
 * Test seam.
 * - `undefined` → use real resolution.
 * - `null` → force the "driver absent" path.
 * - a module → use it in place of the real package.
 */
export function _setBrowserDriverForTests(mod: BrowserDriverModule | null | undefined): void {
  _testOverride = mod;
  resetBrowserDriverCache();
}

/**
 * Drop the memoized answer.
 *
 * ⚠ NOT decoration, and not test-only. The negative result is memoized, so without this an
 * acquisition that succeeds MID-PROCESS stays invisible to the caller that triggered it: the
 * acquirer installs the driver, the next probe returns the cached `null`, and the rung reports
 * itself unavailable while sitting on disk. `browser-acquire.ts` calls this after a successful
 * install for exactly that reason.
 */
export function resetBrowserDriverCache(): void {
  _cached = null;
  _resolved = false;
  _inFlight = null;
  _syncCached = null;
  _syncResolved = false;
}

/** The data-directory root the acquirer installs into. Separated so tests can assert the path. */
export function driverInstallRoot(): string {
  return join(getConfig().dataDir, DRIVER_INSTALL_DIRNAME);
}

function looksLikeDriver(mod: unknown): mod is BrowserDriverModule {
  if (!mod || typeof mod !== 'object') return false;
  const m = mod as Record<string, unknown>;
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const api = m[engine];
    if (!api || typeof api !== 'object') return false;
    if (typeof (api as Record<string, unknown>)['launch'] !== 'function') return false;
  }
  return true;
}

/**
 * A CJS package reached through `import()` arrives as a namespace object whose named exports
 * may hang off `default` instead of the namespace, depending on what the CJS lexer detected.
 * Both shapes are accepted rather than assumed.
 */
function unwrap(mod: unknown): BrowserDriverModule | null {
  if (looksLikeDriver(mod)) return mod;
  const inner = (mod as { default?: unknown } | null)?.default;
  return looksLikeDriver(inner) ? inner : null;
}

/**
 * Try one resolution root. `createRequire` takes a plain absolute PATH here rather than a
 * `file:` URL: `new URL(...).pathname` yields `/C:/...` on win32, which is the Windows-only
 * failure this program has already shipped three times.
 */
function tryRoot(fromPath: string): BrowserDriverModule | null {
  try {
    return unwrap(createRequire(fromPath)(DRIVER_MODULE_ID) as unknown);
  } catch {
    return null;
  }
}

/** The acquired copy under the data directory. Isolated because `getConfig()` can throw. */
function tryAcquiredRoot(): BrowserDriverModule | null {
  try {
    return tryRoot(join(driverInstallRoot(), 'package.json'));
  } catch {
    return null;
  }
}

/**
 * Resolve the browser driver, or `null` when it is not installed anywhere this process can see.
 * Never throws. Memoized in both directions, so an absent package costs one failed resolution
 * per process rather than one per fetch.
 *
 * ⚠ THE FIRST ATTEMPT USES A LITERAL `import()` SPECIFIER, and that is deliberate on two counts.
 * A literal is the only form a bundler can see — a variable specifier is silently dropped by
 * esbuild, which makes the feature vanish in the packaged binary and nowhere else. And it is the
 * form the module graph can intercept, which is what lets thirty existing suites keep driving
 * this rung through the seam they already mock instead of re-mocking a private resolver.
 *
 * The `createRequire` fallback is not redundant: `import()` resolves relative to THIS file, so
 * it can never see a driver acquired into the data directory. One of the two roots covers the
 * user who installed a driver themselves, the other covers the one `warmup` installed.
 */
export async function loadBrowserDriver(): Promise<BrowserDriverModule | null> {
  if (_testOverride !== undefined) return _testOverride;
  if (_resolved) return _cached;
  if (_inFlight) return _inFlight;

  _inFlight = (async () => {
    let mod: BrowserDriverModule | null = null;
    try {
      mod = unwrap(await import('playwright'));
    } catch {
      mod = null;
    }
    if (!mod) mod = tryAcquiredRoot();

    if (!mod) log.debug('browser driver not installed; the browser rung is unavailable until acquired');
    _cached = mod;
    _resolved = true;
    _inFlight = null;
    return _cached;
  })();
  return _inFlight;
}

/**
 * The synchronous resolution, for the two probes that genuinely cannot await: the on-disk check
 * on the fetch hot path and the setup TUI's `ProbeDeps`, both of which answer a plain boolean
 * inside a synchronous interface.
 *
 * It agrees with {@link loadBrowserDriver} by CONSTRUCTION rather than by a shared memo: both
 * consult the same two roots in the same order, and `import()` and `createRequire` resolve the
 * same package from the same place. The memo is deliberately separate — see `_syncCached`.
 */
export function loadBrowserDriverSync(): BrowserDriverModule | null {
  if (_testOverride !== undefined) return _testOverride;
  if (_syncResolved) return _syncCached;

  _syncCached = tryRoot(import.meta.filename) ?? tryAcquiredRoot();
  _syncResolved = true;
  return _syncCached;
}

/**
 * Absolute path to the resolved driver's `package.json`, or `null` when there is none.
 *
 * `warmup` needs the package DIRECTORY, not its exports, because it drives the driver's own CLI
 * to fetch the browser binary — and it must drive the SAME copy the runtime resolves, or the
 * install lands next to a revision nothing will load. Both roots are tried in the same order as
 * {@link loadBrowserDriver}, so the two can never disagree about which copy is in play.
 */
export function resolveDriverPackageJson(): string | null {
  const spec = `${DRIVER_MODULE_ID}/package.json`;
  try {
    return createRequire(import.meta.filename).resolve(spec);
  } catch {
    // fall through to the acquired copy
  }
  try {
    return createRequire(join(driverInstallRoot(), 'package.json')).resolve(spec);
  } catch {
    return null;
  }
}

/** Whether a driver is resolvable. The cheap predicate for `doctor`, `status` and warmup. */
export function browserDriverInstalled(): boolean {
  return loadBrowserDriverSync() !== null;
}

/**
 * The driver, or a thrown refusal that states the remedy. For call sites that genuinely cannot
 * proceed without one — a launch, an `executablePath()` — where returning `null` would only
 * move the crash one frame outward with a worse message.
 */
export async function requireBrowserDriver(): Promise<BrowserDriverModule> {
  const mod = await loadBrowserDriver();
  if (!mod) throw new Error(BROWSER_DRIVER_MISSING_ERROR);
  return mod;
}
