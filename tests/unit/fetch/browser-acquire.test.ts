import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BrowserAcquirer,
  BROWSER_INSTALLING_NOTE,
} from '../../../src/fetch/browser-acquire.js';

/**
 * WHY these tests matter: the acquirer is the lazy-browser contract (D3). Its
 * value is entirely in the timing/memoization behaviour — a naive "install then
 * fetch" would block a tool call for minutes on a cold machine and re-install on
 * every request. Each test pins one load-bearing guarantee: exactly-one install
 * under concurrency, a bounded in-call wait, failure memoization with a retry
 * window, and env-tunable budgets. If any of these silently regressed the
 * assertion below would fail.
 */

let tmpDir: string;

function makeAcquirer(overrides: { isInstalled?: () => boolean; install?: () => Promise<boolean> } = {}): {
  acquirer: BrowserAcquirer;
  install: ReturnType<typeof vi.fn>;
} {
  const install = vi.fn(overrides.install ?? (async () => true));
  const acquirer = new BrowserAcquirer({
    dataDir: tmpDir,
    isInstalled: overrides.isInstalled ?? (() => false),
    install: install as unknown as () => Promise<boolean>,
  });
  return { acquirer, install };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-browser-acquire-'));
  delete process.env.WIGOLO_BROWSER_INSTALL_WAIT_MS;
  delete process.env.WIGOLO_BROWSER_INSTALL_RETRY_MS;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BrowserAcquirer.ensureBrowser', () => {
  it('returns ready immediately without touching the installer when the browser is already on disk', async () => {
    const { acquirer, install } = makeAcquirer({ isInstalled: () => true });
    const outcome = await acquirer.ensureBrowser();
    expect(outcome).toBe('ready');
    expect(install).not.toHaveBeenCalled();
  });

  it('invokes the installer exactly once for two concurrent acquisitions (memoization)', async () => {
    let resolveInstall!: (ok: boolean) => void;
    const install = vi.fn(
      () => new Promise<boolean>((res) => { resolveInstall = res; }),
    );
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled: () => false,
      install,
      waitMs: 5000,
    });

    const a = acquirer.ensureBrowser();
    const b = acquirer.ensureBrowser();
    resolveInstall(true);
    const [ra, rb] = await Promise.all([a, b]);

    expect(ra).toBe('ready');
    expect(rb).toBe('ready');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('after a successful install, subsequent calls short-circuit to ready without re-probing or re-installing', async () => {
    let installed = false;
    const install = vi.fn(async () => { installed = true; return true; });
    const isInstalled = vi.fn(() => installed);
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled,
      install,
      waitMs: 5000,
    });

    expect(await acquirer.ensureBrowser()).toBe('ready');
    const probeCallsAfterFirst = isInstalled.mock.calls.length;
    expect(await acquirer.ensureBrowser()).toBe('ready');

    expect(install).toHaveBeenCalledTimes(1);
    // Second call latches on confirmedInstalled — it must not re-probe disk.
    expect(isInstalled.mock.calls.length).toBe(probeCallsAfterFirst);
  });

  it('returns unavailable when the install does not finish within the wait budget, and the install still resolves later', async () => {
    vi.useFakeTimers();
    let resolveInstall!: (ok: boolean) => void;
    const install = vi.fn(
      () => new Promise<boolean>((res) => { resolveInstall = res; }),
    );
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled: () => false,
      install,
      waitMs: 20_000,
    });

    const p = acquirer.ensureBrowser();
    // Advance past the budget without the install resolving.
    await vi.advanceTimersByTimeAsync(20_001);
    const outcome = await p;
    expect(outcome).toBe('unavailable');
    expect(install).toHaveBeenCalledTimes(1);

    // The background install is still live; complete it now.
    resolveInstall(true);
    await vi.advanceTimersByTimeAsync(0);

    // A subsequent acquisition sees the completed install → ready, no re-install.
    const second = await acquirer.ensureBrowser();
    expect(second).toBe('ready');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('memoizes a failed install: within the retry window the installer is not called again', async () => {
    let t = 0;
    const now = () => t;
    const install = vi.fn(async () => false);
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled: () => false,
      install,
      now,
      waitMs: 20_000,
      retryMs: 600_000,
    });

    expect(await acquirer.ensureBrowser()).toBe('unavailable');
    expect(install).toHaveBeenCalledTimes(1);

    // Still inside the retry window.
    t = 599_000;
    expect(await acquirer.ensureBrowser()).toBe('unavailable');
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('retries the install after the retry window elapses', async () => {
    let t = 0;
    const now = () => t;
    const install = vi.fn(async () => false);
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled: () => false,
      install,
      now,
      waitMs: 20_000,
      retryMs: 600_000,
    });

    expect(await acquirer.ensureBrowser()).toBe('unavailable');
    expect(install).toHaveBeenCalledTimes(1);

    // Past the retry window → eligible to retry.
    t = 600_001;
    expect(await acquirer.ensureBrowser()).toBe('unavailable');
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('respects the WIGOLO_BROWSER_INSTALL_WAIT_MS env override', async () => {
    vi.useFakeTimers();
    process.env.WIGOLO_BROWSER_INSTALL_WAIT_MS = '100';
    const install = vi.fn(() => new Promise<boolean>(() => {})); // never resolves
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled: () => false,
      install,
    });

    const p = acquirer.ensureBrowser();
    await vi.advanceTimersByTimeAsync(101);
    expect(await p).toBe('unavailable');
  });

  it('respects the WIGOLO_BROWSER_INSTALL_RETRY_MS env override', async () => {
    let t = 0;
    const now = () => t;
    process.env.WIGOLO_BROWSER_INSTALL_RETRY_MS = '1000';
    const install = vi.fn(async () => false);
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled: () => false,
      install,
      now,
      waitMs: 20_000,
    });

    expect(await acquirer.ensureBrowser()).toBe('unavailable');
    expect(install).toHaveBeenCalledTimes(1);
    // Just past the 1s override window.
    t = 1001;
    expect(await acquirer.ensureBrowser()).toBe('unavailable');
    expect(install).toHaveBeenCalledTimes(2);
  });

  it('does not double-install when a live foreign lock is held; joins by polling for the binary', async () => {
    // Simulate another process holding a fresh lock for THIS process's own pid
    // (isProcessAlive(process.pid) is true), so acquireLock sees it live.
    const lockPath = join(tmpDir, 'browser-install.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

    let appeared = false;
    const isInstalled = vi.fn(() => appeared);
    const install = vi.fn(async () => true);
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled,
      install,
      waitMs: 5000,
    });

    const p = acquirer.ensureBrowser();
    // Foreign install "finishes" — the binary appears on disk.
    setTimeout(() => { appeared = true; }, 50);
    const outcome = await p;

    expect(outcome).toBe('ready');
    // We must NOT have run our own install while a live foreign lock was held.
    expect(install).not.toHaveBeenCalled();
  });

  it('reclaims a stale foreign lock (dead pid) and installs', async () => {
    const lockPath = join(tmpDir, 'browser-install.lock');
    // pid 1 exists but a clearly-old startedAt makes it stale by age; use an
    // unlikely-live pid plus an old timestamp to be safe across platforms.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 2_147_483_600, startedAt: new Date(0).toISOString() }),
    );

    const install = vi.fn(async () => true);
    const acquirer = new BrowserAcquirer({
      dataDir: tmpDir,
      isInstalled: () => false,
      install,
      waitMs: 5000,
    });

    expect(await acquirer.ensureBrowser()).toBe('ready');
    expect(install).toHaveBeenCalledTimes(1);
    // Lock released after a successful install.
    expect(existsSync(lockPath)).toBe(false);
  });

  it('exposes a stable, actionable installing note in capability language (no library names)', () => {
    expect(BROWSER_INSTALLING_NOTE).toMatch(/browser engine/);
    expect(BROWSER_INSTALLING_NOTE).toMatch(/wigolo warmup --browser/);
    // Capability language — never leak the browser library name.
    expect(BROWSER_INSTALLING_NOTE.toLowerCase()).not.toMatch(/playwright|chromium/);
  });
});
