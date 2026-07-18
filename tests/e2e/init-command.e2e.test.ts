// E2E test for `wigolo init`. Covers non-destructive help + flag error paths.
// Headless-first (D8): the DEFAULT init path no longer runs any warmup —
// components download lazily on first use — so no browser/Python download is
// triggered here. Warmup only runs under the explicit --warmup flag (not
// exercised in this suite, which stays fast + non-destructive).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

describe('wigolo init (E2E)', () => {
  it('prints usage and exits 0 on --help; documents headless-first + --wizard', () => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'init', '--help'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
    });

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
  }, 35000);

  it('exits 2 on unknown flag', () => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'init', '--not-a-real-flag'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--not-a-real-flag');
  }, 35000);

  it('exits 2 on an unknown agent id (fast parser reject, no warmup)', () => {
    // --agents is now OPTIONAL for --non-interactive (engine-only installs are
    // allowed), but a supplied id is still validated: an unknown one is rejected
    // by the flag parser BEFORE any warmup runs. This keeps a fast, non-destructive
    // error-path case in this suite. The engine-only accept path (no --agents) runs
    // a real warmup, so it is covered by the mocked unit tests instead.
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'init', '--non-interactive', '--agents=not-a-real-agent'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('not-a-real-agent');
  }, 35000);
});
