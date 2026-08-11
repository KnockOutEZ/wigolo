import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBrowserDriver } from '../../../src/fetch/driver-acquire.js';
import { BROWSER_DRIVER_VERSION } from '../../../src/fetch/browser-driver.js';

/**
 * S10-e. Taking the driver off the default install path is only half a change; without this
 * half the size win is paid for in a capability the product still advertises. So these tests
 * are about the promise "anyone who needs a browser can still get one", and about the rule that
 * a failure to keep it degrades with a stated reason rather than taking warmup down.
 */

type RunFn = typeof import('../../../src/cli/tui/run-command.js').runCommand;

/**
 * A typed stand-in for the package-manager call. Typed against the real signature rather than
 * `vi.fn(async () => …)`, which infers a zero-argument function and makes every later
 * `mock.calls[0][1]` an error the root typecheck cannot see (it excludes `tests/`).
 */
function makeRun(
  overrides: Partial<Awaited<ReturnType<RunFn>>> = {},
  onCall?: () => void,
): ReturnType<typeof vi.fn<RunFn>> {
  return vi.fn<RunFn>(async () => {
    onCall?.();
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...overrides };
  });
}

function okRun(overrides: Partial<Awaited<ReturnType<RunFn>>> = {}) {
  return makeRun(overrides);
}

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'wigolo-driver-acq-'));
}

describe('acquireBrowserDriver', () => {
  it('does nothing when a driver already resolves', async () => {
    const run = okRun();
    const r = await acquireBrowserDriver({
      resolvePackage: () => '/somewhere/playwright/package.json',
      run,
      root: tmpRoot,
    });
    expect(r.outcome).toBe('already_present');
    // WHY the call count and not just the outcome: this is the overwhelmingly common path, and
    // it runs on every `warmup`. Shelling out to a package manager to discover what one
    // `require.resolve` already knows would put a network round-trip on it.
    expect(run).not.toHaveBeenCalled();
  });

  it('installs when nothing resolves, and reports it acquired', async () => {
    let resolved = false;
    const r = await acquireBrowserDriver({
      resolvePackage: () => (resolved ? '/root/playwright/package.json' : null),
      run: makeRun({}, () => {
        resolved = true;
      }),
      root: tmpRoot,
    });
    expect(r.outcome).toBe('acquired');
  });

  it('installs the revision the runtime resolves, not a floating latest', async () => {
    // A skew between the driver and its browser binary surfaces as an executable path pointing
    // at a revision directory that does not exist, which reads as a corrupt install.
    let resolved = false;
    const run = makeRun({}, () => {
      resolved = true;
    });
    await acquireBrowserDriver({
      resolvePackage: () => (resolved ? '/root/pw/package.json' : null),
      run,
      root: tmpRoot,
    });
    expect(run.mock.calls[0][1]).toContain(`playwright@${BROWSER_DRIVER_VERSION}`);
  });

  it('suppresses the driver package’s own binary download', async () => {
    // ⚠ Without this the acquisition fetches a browser binary that `installBrowser` is about to
    // fetch again with the right engine, retry policy and smoke-test — paying twice for one
    // download and picking the engine behind that step's back.
    let resolved = false;
    const run = makeRun({}, () => {
      resolved = true;
    });
    await acquireBrowserDriver({
      resolvePackage: () => (resolved ? '/root/pw/package.json' : null),
      run,
      root: tmpRoot,
    });
    expect(run.mock.calls[0][2]?.env?.['PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD']).toBe('1');
  });

  it('installs into the directory it is given, not the working directory', async () => {
    const root = tmpRoot();
    let resolved = false;
    const run = makeRun({}, () => {
      resolved = true;
    });
    await acquireBrowserDriver({
      resolvePackage: () => (resolved ? '/root/pw/package.json' : null),
      run,
      root: () => root,
    });
    const args = run.mock.calls[0][1];
    expect(args[args.indexOf('--prefix') + 1]).toBe(root);
  });

  it('reports a failed install with the reason, rather than throwing', async () => {
    const r = await acquireBrowserDriver({
      resolvePackage: () => null,
      run: okRun({ code: 1, stderr: 'npm ERR! 404 Not Found' }),
      root: tmpRoot,
    });
    expect(r.outcome).toBe('failed');
    expect(r.error).toContain('404');
  });

  it('names a timeout as a timeout', async () => {
    // A slow link and a broken registry need different remedies, so they must not collapse into
    // one message.
    const r = await acquireBrowserDriver({
      resolvePackage: () => null,
      run: okRun({ code: 1, timedOut: true }),
      root: tmpRoot,
    });
    expect(r.detail).toContain('timed out');
  });

  it('survives a package manager that is not on PATH', async () => {
    // ⚠ `runCommand` REJECTS on spawn errors rather than resolving non-zero — the same
    // asynchronous-ENOENT shape that let a background service crash its host once already. An
    // unhandled rejection here would take `warmup` down over an optional rung.
    const r = await acquireBrowserDriver({
      resolvePackage: () => null,
      run: vi.fn<RunFn>(async () => {
        throw new Error('spawn npm ENOENT');
      }),
      root: tmpRoot,
    });
    expect(r.outcome).toBe('failed');
    expect(r.error).toContain('ENOENT');
  });

  it('does not claim success when the install exits 0 but nothing resolves', async () => {
    // ⚠ A SELF-SATISFACTION GUARD. Trusting the exit code alone would report `acquired` for a
    // run that installed into the wrong prefix, or installed nothing at all — and the caller
    // would then resolve the CLI from a path that does not exist, one frame further out.
    const r = await acquireBrowserDriver({
      resolvePackage: () => null,
      run: okRun(),
      root: tmpRoot,
    });
    expect(r.outcome).toBe('failed');
  });

  it('always states a reason, whatever the outcome', async () => {
    // D-S10-9: no decision about this rung is silent.
    const outcomes = await Promise.all([
      acquireBrowserDriver({ resolvePackage: () => '/x/package.json', run: okRun(), root: tmpRoot }),
      acquireBrowserDriver({ resolvePackage: () => null, run: okRun({ code: 1 }), root: tmpRoot }),
    ]);
    for (const r of outcomes) expect(r.detail.length).toBeGreaterThan(0);
  });
});
