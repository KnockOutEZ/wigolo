import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn(), spawnSync: vi.fn() };
});

// Stub out the heavy work — we only care about the wipe.
vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: () => false,
  getBootstrapState: () => null,
  bootstrapNativeSearxng: vi.fn(),
}));

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { runWarmup } from '../../../src/cli/warmup.js';

describe('runWarmup --force', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); });

  it('wipes state.json, searxng/, bootstrap.lock, searxng.lock, searxng.port when --force passed', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // no bootstrap.lock → no live process
    await runWarmup(['--force']);

    const removed = vi.mocked(rmSync).mock.calls.map(c => String(c[0]));
    expect(removed.some(p => p.endsWith('state.json'))).toBe(true);
    expect(removed.some(p => p.endsWith('searxng'))).toBe(true);
    expect(removed.some(p => p.endsWith('bootstrap.lock'))).toBe(true);
    expect(removed.some(p => p.endsWith('searxng.lock'))).toBe(true);
    expect(removed.some(p => p.endsWith('searxng.port'))).toBe(true);
  });

  it('does NOT wipe when --force not passed', async () => {
    await runWarmup([]);
    const removed = vi.mocked(rmSync).mock.calls.map(c => String(c[0]));
    expect(removed.some(p => p.endsWith('state.json'))).toBe(false);
  });

  it('aborts if bootstrap.lock belongs to a live process', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('bootstrap.lock'));
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ pid: process.pid, startedAt: '2026-04-13T00:00:00Z' }));
    await expect(runWarmup(['--force'])).rejects.toThrow(/bootstrap is in progress/i);
  });

  it('treats malformed lock as stale and proceeds', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('bootstrap.lock'));
    vi.mocked(readFileSync).mockReturnValue('{ not json');
    await expect(runWarmup(['--force'])).resolves.toBeDefined();
  });
});
