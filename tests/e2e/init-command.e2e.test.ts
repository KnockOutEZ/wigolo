// E2E test for `wigolo init`. Covers non-destructive help + flag error paths.
// Headless-first (D8): the DEFAULT init path no longer runs any warmup —
// components download lazily on first use — so no browser/Python download is
// triggered here. Warmup only runs under the explicit --warmup flag (not
// exercised in this suite, which stays fast + non-destructive).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

// Spawn `node node_modules/tsx/dist/cli.mjs`, never bare `npx`. On Windows `npx`
// resolves to `npx.cmd`, which Node refuses to spawn without `shell: true` (the
// CVE-2024-27980 hardening) — the child never starts, `status` comes back `null`,
// and the assertion below reads as a wrong exit code rather than as no exit at all.
// Going straight to the tsx entry also skips npm's resolution, which is the slowest
// part of this test on a cold runner. Mirrors doctor-clean-exit.e2e's process.execPath
// spawn, the e2e that already passes cross-OS.
const TSX_CLI = join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

function runInit(args: string[]): ReturnType<typeof spawnSync> {
  const r = spawnSync(process.execPath, [TSX_CLI, join('src', 'index.ts'), 'init', ...args], {
    cwd: projectRoot,
    encoding: 'utf-8',
    timeout: 60000,
    env: { ...process.env, NO_COLOR: '1' },
  });
  // Name the failure. `status: null` means the process never ran or was killed, which
  // is a different defect from a wrong exit code and must not be read as one.
  expect(r.error, `init did not run: ${r.error?.message ?? ''}`).toBeUndefined();
  expect(r.signal, `init was killed by ${r.signal} (timeout/crash), it did not exit`).toBeNull();
  return r;
}

describe('wigolo init (E2E)', () => {
  it('prints usage and exits 0 on --help; documents headless-first + --wizard', () => {
    const r = runInit(['--help']);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Usage: wigolo init');
    // The retired --non-interactive alias still parses but is no longer
    // advertised — unattended IS the default, so the help must not resurrect it.
    expect(r.stderr).not.toContain('--non-interactive');
    expect(r.stderr).toContain('--agents');
    expect(r.stderr).toContain('--skip-verify');
    // Headless-first surface: --wizard opts into Ink, --warmup opts into pre-cache.
    expect(r.stderr).toContain('--wizard');
    expect(r.stderr).toContain('--warmup');
    expect(r.stderr).toMatch(/first use|pre-download|download/i);
  }, 70000);

  it('exits 2 on unknown flag', () => {
    const r = runInit(['--not-a-real-flag']);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--not-a-real-flag');
  }, 70000);

  it('exits 2 on an unknown agent id (fast parser reject, no warmup)', () => {
    // --agents is now OPTIONAL for --non-interactive (engine-only installs are
    // allowed), but a supplied id is still validated: an unknown one is rejected
    // by the flag parser BEFORE any warmup runs. This keeps a fast, non-destructive
    // error-path case in this suite. The engine-only accept path (no --agents) runs
    // a real warmup, so it is covered by the mocked unit tests instead.
    const r = runInit(['--non-interactive', '--agents=not-a-real-agent']);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not-a-real-agent');
  }, 70000);
});
