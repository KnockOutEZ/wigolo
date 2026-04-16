// E2E test for `wigolo init`. Covers non-destructive help + flag error paths
// so we don't run a real warmup (which would install Playwright / Python deps).
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

describe('wigolo init (E2E)', () => {
  it('prints usage and exits 0 on --help', () => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'init', '--help'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain('Usage: wigolo init');
    expect(r.stderr).toContain('--non-interactive');
    expect(r.stderr).toContain('--agents');
    expect(r.stderr).toContain('--skip-verify');
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

  it('exits 2 when --non-interactive is supplied without --agents', () => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'init', '--non-interactive', '--skip-verify'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 60000,
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--non-interactive');
  }, 65000);
});
