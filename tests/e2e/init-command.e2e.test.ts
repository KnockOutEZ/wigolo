// E2E test for `wigolo init`. Requires Python 3 on the host.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

describe('wigolo init (E2E)', () => {
  it('prints the banner and exits 0 when prerequisites are met', () => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'init'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
    });

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Local-first');
    expect(r.stdout).toMatch(/Node\.js \d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/Python \d+\.\d+\.\d+/);
    expect(r.stdout).toMatch(/warmup/);
  }, 35000);

  it('writes banner to stdout, not stderr', () => {
    const r = spawnSync('npx', ['tsx', 'src/index.ts', 'init'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
    });
    expect(r.stdout.toLowerCase()).toContain('local-first');
    expect(r.stderr.toLowerCase()).not.toContain('local-first');
  }, 35000);
});
