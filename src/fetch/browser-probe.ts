import { existsSync } from 'node:fs';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';

export type BrowserName = 'chromium' | 'firefox' | 'webkit';

const BROWSER_API: Record<BrowserName, BrowserType> = {
  chromium,
  firefox,
  webkit,
};

export interface BrowserProbeResult {
  /** Browser binary resolves to a path that exists on disk. */
  onDisk: boolean;
  /** Browser actually launched (and closed) headless — the real health check. */
  launchable: boolean;
  /** Resolved executable path (empty when executablePath() throws). */
  execPath: string;
  /** Failure detail when onDisk is false or launch threw. */
  error?: string;
}

const DEFAULT_LAUNCH_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`launch timed out after ${ms}ms`));
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Single source of truth for browser health, shared by `wigolo warmup` and
 * `wigolo doctor` so they can never disagree (GH #116). Resolves the bundled
 * Playwright's `executablePath()`, checks it exists on disk, then performs a
 * real `launch({ headless: true })` + `close()` smoke-test under a timeout.
 *
 * A browser is only healthy when it actually launches: on bare Linux the
 * binary can be on disk yet fail at launch because OS shared libs (libnss3,
 * libgbm, ...) are missing. existsSync alone would lie; the launch smoke-test
 * is the honest "does it work" result.
 */
export async function probeBrowser(
  name: BrowserName,
  opts: { launchTimeoutMs?: number } = {},
): Promise<BrowserProbeResult> {
  const api = BROWSER_API[name];

  let execPath = '';
  let onDisk = false;
  try {
    execPath = api.executablePath();
    onDisk = !!execPath && existsSync(execPath);
  } catch (err) {
    return {
      onDisk: false,
      launchable: false,
      execPath: '',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!onDisk) {
    return {
      onDisk: false,
      launchable: false,
      execPath,
      error: 'browser binary missing on disk',
    };
  }

  const timeout = opts.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS;
  try {
    const browser = await withTimeout(api.launch({ headless: true }), timeout);
    try {
      await browser.close();
    } catch {
      // Close failures don't change the result — it launched.
    }
    return { onDisk: true, launchable: true, execPath };
  } catch (err) {
    return {
      onDisk: true,
      launchable: false,
      execPath,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
