import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runCommand } from '../cli/tui/run-command.js';
import { createLogger } from '../logger.js';
import {
  BROWSER_DRIVER_VERSION,
  driverInstallRoot,
  resetBrowserDriverCache,
  resolveDriverPackageJson,
} from './browser-driver.js';

/**
 * S10-e — acquiring the browser DRIVER PACKAGE, which used to arrive with every install.
 *
 * Taking the driver off the default install path is only half a change. The other half is that
 * anyone who needs the browser rung must still be able to get one, or the size win is paid for
 * in a capability the product still advertises. This is that half.
 *
 * ⚠ It deliberately does NOT download the browser BINARY. `installBrowser` already owns that,
 * it already picks which engine to fetch, and it already has the retry/timeout/smoke-test
 * behaviour that took several rounds to get right. Letting the package's own postinstall fetch
 * a binary here would download a second copy of something `installBrowser` is about to fetch
 * anyway — so the postinstall is suppressed and the existing step is left in charge.
 */

const log = createLogger('fetch');

export type DriverAcquireOutcome = 'acquired' | 'already_present' | 'failed';

export interface DriverAcquireResult {
  outcome: DriverAcquireOutcome;
  /** One-line human explanation. Never empty. Capability language — no package names. */
  detail: string;
  error?: string;
}

/** Install timeout. The package is ~18 MiB of JS, so this is a network bound, not a build one. */
const DRIVER_INSTALL_TIMEOUT_MS = 180_000;

/**
 * ⚠ WINDOWS, AND THE REASON THIS IS NOT JUST `spawn('npm')`.
 *
 * On Windows `npm` is `npm.cmd`, a batch script — and since the fix for CVE-2024-27980 Node
 * REFUSES to spawn `.cmd`/`.bat` without `shell: true`, throwing `spawn EINVAL`. Observed, not
 * theorised: this shipped green on ubuntu and macOS and red on BOTH Windows runners with
 * exactly that message.
 *
 * `shell: true` would fix it and introduce a worse bug — with a shell, arguments are joined
 * rather than passed as a vector, so the `--prefix` path breaks apart on the first space, and
 * this path is a user's home directory. So npm is run the way `installBrowser` already runs the
 * driver's CLI: as a JS entrypoint under `process.execPath`. No shell, no batch file, no
 * quoting.
 *
 * The two candidates cover the layouts that exist — `<dir>/node_modules/npm` is the Windows and
 * hosted-toolcache layout, `<dir>/../lib/node_modules/npm` is the POSIX prefix layout that nvm,
 * volta and Homebrew all follow.
 */
export function resolveNpmCli(): string | null {
  const dir = dirname(process.execPath);
  const candidates = [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // An unreadable candidate is simply not the one.
    }
  }
  return null;
}

/** Remedy when wigolo cannot drive a package manager itself. */
export const DRIVER_MANUAL_INSTALL_HINT =
  'could not locate a package manager to install the browser engine driver — install it alongside wigolo yourself, then re-run `wigolo warmup --browser`';

export interface DriverAcquireDeps {
  /** Defaults to the real two-root resolution. */
  resolvePackage?: () => string | null;
  /** Defaults to `runCommand`. */
  run?: typeof runCommand;
  /** Defaults to the real data-directory root. */
  root?: () => string;
  /** Defaults to {@link resolveNpmCli}. */
  npmCli?: () => string | null;
}

/**
 * Ensure a browser driver is resolvable, installing one into wigolo's data directory when it
 * is not. Never throws — a failed acquisition returns `failed` with a reason, because the
 * caller's job is to degrade with a stated cause rather than to die (D-S10-9).
 */
export async function acquireBrowserDriver(
  deps: DriverAcquireDeps = {},
): Promise<DriverAcquireResult> {
  const resolvePackage = deps.resolvePackage ?? resolveDriverPackageJson;
  const run = deps.run ?? runCommand;
  const root = (deps.root ?? driverInstallRoot)();

  if (resolvePackage()) {
    return { outcome: 'already_present', detail: 'browser engine driver already available' };
  }

  try {
    mkdirSync(root, { recursive: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { outcome: 'failed', detail: 'could not create the driver directory', error };
  }

  const npmCli = (deps.npmCli ?? resolveNpmCli)();
  if (!npmCli) {
    return { outcome: 'failed', detail: DRIVER_MANUAL_INSTALL_HINT, error: 'no npm entrypoint found' };
  }

  const spec = `playwright@${BROWSER_DRIVER_VERSION}`;
  let r;
  try {
    r = await run(process.execPath, [
      npmCli,
      'install', spec,
      '--prefix', root,
      '--no-save', '--no-audit', '--no-fund', '--omit=dev', '--omit=optional',
    ], {
      timeout: DRIVER_INSTALL_TIMEOUT_MS,
      // The binary is `installBrowser`'s job; suppressing the postinstall here is what keeps
      // this from fetching a second copy of it.
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' },
    });
  } catch (err) {
    // `runCommand` REJECTS on spawn errors (no npm on PATH is the realistic one), and an
    // unhandled rejection here would take warmup down over an optional rung.
    const error = err instanceof Error ? err.message : String(err);
    return { outcome: 'failed', detail: 'could not run the package manager', error };
  }

  if (r.code !== 0) {
    const error = (r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || `exit ${r.code}`;
    return {
      outcome: 'failed',
      detail: r.timedOut ? 'driver download timed out' : 'driver download failed',
      error,
    };
  }

  // The negative answer is memoized, and the install just falsified it.
  resetBrowserDriverCache();

  if (!resolvePackage()) {
    return {
      outcome: 'failed',
      detail: 'driver install reported success but nothing is resolvable',
      error: 'post-install resolution failed',
    };
  }

  log.info('browser engine driver acquired', { root });
  return { outcome: 'acquired', detail: 'browser engine driver installed' };
}
