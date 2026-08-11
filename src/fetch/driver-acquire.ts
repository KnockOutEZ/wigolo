import { mkdirSync } from 'node:fs';
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

export interface DriverAcquireDeps {
  /** Defaults to the real two-root resolution. */
  resolvePackage?: () => string | null;
  /** Defaults to `runCommand`. */
  run?: typeof runCommand;
  /** Defaults to the real data-directory root. */
  root?: () => string;
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

  const spec = `playwright@${BROWSER_DRIVER_VERSION}`;
  let r;
  try {
    r = await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
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
