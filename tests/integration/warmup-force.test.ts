import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetConfig } from '../../src/config.js';

// Prevent the warmup from actually installing anything heavy
vi.mock('../../src/searxng/bootstrap.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/searxng/bootstrap.js')>('../../src/searxng/bootstrap.js');
  return {
    ...actual,
    bootstrapNativeSearxng: vi.fn().mockResolvedValue(undefined),
  };
});

// importOriginal form required: extraction/trafilatura.ts and search/flashrank.ts call
// promisify(execFile) at module load, so the literal { execSync, spawnSync } form breaks at import.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(), // playwright + trafilatura + flashrank no-op
    spawnSync: vi.fn(),
  };
});

import { runWarmup } from '../../src/cli/warmup.js';

describe('warmup --force (integration)', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-warmupforce-'));
    process.env.WIGOLO_DATA_DIR = dataDir;
    resetConfig();
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
  });

  it('wipes a pre-existing failed state and re-bootstraps', async () => {
    mkdirSync(join(dataDir, 'searxng'), { recursive: true });
    writeFileSync(join(dataDir, 'state.json'), JSON.stringify({ status: 'failed', attempts: 3 }));
    writeFileSync(join(dataDir, 'bootstrap.lock'), JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString() }));
    writeFileSync(join(dataDir, 'searxng.lock'), JSON.stringify({ pid: 999999999, port: 8888 }));
    writeFileSync(join(dataDir, 'searxng.port'), '8888');

    await runWarmup(['--force']);

    expect(existsSync(join(dataDir, 'state.json'))).toBe(false);
    expect(existsSync(join(dataDir, 'searxng'))).toBe(false);
    expect(existsSync(join(dataDir, 'searxng.lock'))).toBe(false);
    expect(existsSync(join(dataDir, 'searxng.port'))).toBe(false);
    expect(existsSync(join(dataDir, 'bootstrap.lock'))).toBe(false);
  });
});
