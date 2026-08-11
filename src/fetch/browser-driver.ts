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
let _testOverride: BrowserDriverModule | null | undefined;

/**
 * Test seam.
 * - `undefined` → use real resolution.
 * - `null` → force the "driver absent" path.
 * - a module → use it in place of the real package.
 */
export function _setBrowserDriverForTests(mod: BrowserDriverModule | null | undefined): void {
  _testOverride = mod;
  _cached = null;
  _resolved = false;
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
 * Try one resolution root. `createRequire` takes a plain absolute PATH here rather than a
 * `file:` URL: `new URL(...).pathname` yields `/C:/...` on win32, which is the Windows-only
 * failure this program has already shipped three times.
 */
function tryRoot(fromPath: string): BrowserDriverModule | null {
  try {
    const mod = createRequire(fromPath)(DRIVER_MODULE_ID) as unknown;
    return looksLikeDriver(mod) ? mod : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the browser driver, or `null` when it is not installed anywhere this process can see.
 * Never throws. Memoized in both directions, so an absent package costs one failed resolution
 * per process rather than one per fetch.
 */
export function loadBrowserDriver(): BrowserDriverModule | null {
  if (_testOverride !== undefined) return _testOverride;
  if (_resolved) return _cached;

  let mod = tryRoot(import.meta.filename);
  if (!mod) {
    // The acquired copy. `getConfig()` can throw on a half-configured process; a driver probe
    // must not be the thing that takes that process down.
    try {
      mod = tryRoot(join(driverInstallRoot(), 'package.json'));
    } catch {
      mod = null;
    }
  }

  if (!mod) log.debug('browser driver not installed; the browser rung is unavailable until acquired');
  _cached = mod;
  _resolved = true;
  return _cached;
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
  return loadBrowserDriver() !== null;
}

/**
 * The driver, or a thrown refusal that states the remedy. For call sites that genuinely cannot
 * proceed without one — a launch, an `executablePath()` — where returning `null` would only
 * move the crash one frame outward with a worse message.
 */
export function requireBrowserDriver(): BrowserDriverModule {
  const mod = loadBrowserDriver();
  if (!mod) throw new Error(BROWSER_DRIVER_MISSING_ERROR);
  return mod;
}
