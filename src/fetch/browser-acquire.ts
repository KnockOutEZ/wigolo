import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { PlainReporter } from '../cli/tui/reporter.js';
import { isProcessAlive } from '../searxng/process.js';

/**
 * Lazy browser-engine acquisition (design D3). When the browser tier is entered
 * on a machine where the browser executable is not installed, we join a MEMOIZED
 * install promise instead of hard-failing. The in-call wait is bounded; if the
 * install has not finished by the budget, the fetch falls back to lower-tier
 * content (when any exists) with an actionable note, while the install continues
 * in the background. A failed/timed-out install is memoized so offline machines
 * stall at most once per retry window.
 *
 * Everything here is instance state on a single {@link BrowserAcquirer}; the
 * router holds ONE acquirer, so memoization and the failure window are shared
 * across every browser-tier call site.
 */

/** Result of an acquisition attempt. */
export type AcquireOutcome = 'ready' | 'unavailable';

/** Actionable, capability-language note shown when the browser is still installing. */
export const BROWSER_INSTALLING_NOTE =
  'browser engine installing in background (~1-2 min); retry shortly, or run `wigolo warmup --browser`';

/** Actionable, capability-language error when a fetch cannot proceed without a browser. */
export const BROWSER_UNAVAILABLE_ERROR =
  'browser engine required for this page but not installed; installing in background (~1-2 min) — retry shortly, or run `wigolo warmup --browser`';

const DEFAULT_WAIT_MS = 20_000;
const DEFAULT_RETRY_MS = 10 * 60 * 1000;
// A held install lock older than this is treated as stale (crashed installer).
// Generous — a browser install can legitimately take a couple of minutes.
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Probe whether the browser executable is present on disk. Cheap — resolves the
 * bundled Playwright's `executablePath()` and `existsSync`, mirroring
 * browser-probe.ts's `onDisk` check (no launch smoke-test, which would cost 30s
 * on the hot fetch path). Never throws.
 */
export function browserInstalledOnDisk(): boolean {
  try {
    const exec = chromium.executablePath();
    return !!exec && existsSync(exec);
  } catch {
    return false;
  }
}

/**
 * Run the browser-only warmup phase (chromium install + linux deps + launch
 * smoke-test). Dynamically imports so the acquirer module never eagerly pulls
 * the CLI/warmup graph into the fetch hot path. Resolves true when the install
 * succeeded (browser launchable), false otherwise.
 */
async function runBrowserWarmup(): Promise<boolean> {
  const { runWarmup } = await import('../cli/warmup.js');
  const result = await runWarmup(['--browser'], new PlainReporter('warmup'));
  return result.playwright === 'ok';
}

export interface BrowserAcquirerDeps {
  /** Probe for the browser binary on disk. Defaults to {@link browserInstalledOnDisk}. */
  isInstalled?: () => boolean;
  /** Run the install; resolves true on success. Defaults to the warmup driver. */
  install?: () => Promise<boolean>;
  /** Clock, injectable for fake-timer tests. Defaults to Date.now. */
  now?: () => number;
  /** Directory for the cross-process install lockfile. Defaults to config dataDir. */
  dataDir?: string;
  /** In-call wait budget (ms). Defaults to env WIGOLO_BROWSER_INSTALL_WAIT_MS or 20000. */
  waitMs?: number;
  /** Failure-memoization window (ms). Defaults to env WIGOLO_BROWSER_INSTALL_RETRY_MS or 600000. */
  retryMs?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Coordinates lazy browser acquisition for a single router. Holds the memoized
 * install promise, the failure window, and the cross-process lockfile.
 */
export class BrowserAcquirer {
  private readonly log = createLogger('fetch');
  private readonly isInstalled: () => boolean;
  private readonly install: () => Promise<boolean>;
  private readonly now: () => number;
  private readonly deps: BrowserAcquirerDeps;

  /** In-flight (or completed-successfully) install promise, memoized. */
  private installPromise: Promise<boolean> | null = null;
  /** Timestamp of the last failed/timed-out install; drives the retry window. */
  private lastFailureAt: number | null = null;
  /** Latched true once a probe (or install) has confirmed the browser present. */
  private confirmedInstalled = false;

  constructor(deps: BrowserAcquirerDeps = {}) {
    this.deps = deps;
    this.isInstalled = deps.isInstalled ?? browserInstalledOnDisk;
    this.install = deps.install ?? runBrowserWarmup;
    this.now = deps.now ?? Date.now;
  }

  private get waitMs(): number {
    return this.deps.waitMs ?? envInt('WIGOLO_BROWSER_INSTALL_WAIT_MS', DEFAULT_WAIT_MS);
  }

  private get retryMs(): number {
    return this.deps.retryMs ?? envInt('WIGOLO_BROWSER_INSTALL_RETRY_MS', DEFAULT_RETRY_MS);
  }

  private get lockPath(): string {
    const dir = this.deps.dataDir ?? getConfig().dataDir;
    return join(dir, 'browser-install.lock');
  }

  /**
   * Ensure the browser engine is available for the caller's fetch.
   *  - Already installed → 'ready' immediately (no installer touched).
   *  - Missing, within the failure window → 'unavailable' immediately (no
   *    second install; offline machines stall at most once per window).
   *  - Missing → join the memoized install and wait up to the budget. If it
   *    finishes 'ok' in time → 'ready'; otherwise 'unavailable' (install keeps
   *    running in the background so a later call joins the same promise).
   */
  async ensureBrowser(): Promise<AcquireOutcome> {
    if (this.confirmedInstalled) return 'ready';
    if (this.isInstalled()) {
      this.confirmedInstalled = true;
      return 'ready';
    }

    // Failure memoization: skip the installer entirely inside the retry window.
    if (this.lastFailureAt !== null && this.now() - this.lastFailureAt < this.retryMs) {
      this.log.debug('browser install memoized as failed, skipping installer', {
        sinceMs: this.now() - this.lastFailureAt,
        retryMs: this.retryMs,
      });
      return 'unavailable';
    }
    // Window elapsed — clear so a fresh attempt can start.
    this.lastFailureAt = null;

    const promise = this.startOrJoinInstall();

    // Race the memoized install against the in-call wait budget.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.waitMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        promise.then((ok) => (ok ? ('ready' as const) : ('failed' as const))),
        budget,
      ]);
      if (outcome === 'ready') {
        this.confirmedInstalled = true;
        return 'ready';
      }
      // 'failed' (install resolved false) or 'timeout' (budget elapsed first).
      // Either way the fetch cannot use the browser right now.
      return 'unavailable';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Return the memoized install promise, starting it (once) if idle. On
   * resolution the promise is cleared on failure (so a later call after the
   * retry window can retry) and the failure timestamp is stamped; on success it
   * is left resolved so subsequent joins short-circuit.
   */
  private startOrJoinInstall(): Promise<boolean> {
    if (this.installPromise) return this.installPromise;

    this.log.info('installing browser engine (first use, ~100-150MB)…');

    this.installPromise = (async () => {
      // Cross-process guard: if another process holds the lock, join it by
      // polling for the binary to appear rather than double-installing.
      const locked = this.acquireLock();
      try {
        if (!locked) {
          this.log.debug('another process is installing the browser engine; waiting');
          return await this.waitForForeignInstall();
        }
        const ok = await this.install();
        return ok;
      } catch (err) {
        this.log.warn('browser engine install failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      } finally {
        if (locked) this.releaseLock();
      }
    })();

    // Attach a settlement handler that memoizes failures and clears the promise
    // so a post-window retry is possible. Success leaves the resolved promise in
    // place so it short-circuits future joins.
    void this.installPromise.then(
      (ok) => {
        if (ok) {
          this.confirmedInstalled = true;
        } else {
          this.lastFailureAt = this.now();
          this.installPromise = null;
        }
      },
      () => {
        this.lastFailureAt = this.now();
        this.installPromise = null;
      },
    );

    return this.installPromise;
  }

  /**
   * Poll for the browser binary to appear (another process is installing it).
   * Bounded by the lock staleness so a crashed foreign installer can't hang us
   * forever — the in-call wait budget in ensureBrowser() is the real ceiling.
   */
  private async waitForForeignInstall(): Promise<boolean> {
    const deadline = this.now() + LOCK_STALE_MS;
    while (this.now() < deadline) {
      if (this.isInstalled()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return this.isInstalled();
  }

  /**
   * Acquire the cross-process install lockfile (mirrors the searxng.lock
   * pattern). Returns true when this process now holds the lock, false when a
   * live foreign process holds it. Stale locks (dead pid or age past
   * LOCK_STALE_MS) are reclaimed.
   */
  private acquireLock(): boolean {
    const lockFile = this.lockPath;
    try {
      if (existsSync(lockFile)) {
        try {
          const data = JSON.parse(readFileSync(lockFile, 'utf-8')) as { pid?: number; startedAt?: string };
          const startedAtMs = data.startedAt ? Date.parse(data.startedAt) : NaN;
          const fresh = Number.isFinite(startedAtMs) && this.now() - startedAtMs < LOCK_STALE_MS;
          if (data.pid && isProcessAlive(data.pid) && fresh) {
            return false;
          }
          // Stale (dead pid or too old) — reclaim it.
          this.tryUnlink(lockFile);
        } catch {
          this.tryUnlink(lockFile);
        }
      }
      const dir = this.deps.dataDir ?? getConfig().dataDir;
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        lockFile,
        JSON.stringify({ pid: process.pid, startedAt: new Date(this.now()).toISOString() }),
      );
      return true;
    } catch (err) {
      // A filesystem error acquiring the lock must not block the install — treat
      // it as "we hold it" so the install proceeds (worst case a double-install,
      // which Playwright's installer is idempotent about).
      this.log.debug('browser install lock unavailable, proceeding without it', {
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  private releaseLock(): void {
    this.tryUnlink(this.lockPath);
  }

  private tryUnlink(path: string): void {
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.log.debug('unable to remove browser install lock', { path, code: code ?? 'unknown' });
      }
    }
  }
}
