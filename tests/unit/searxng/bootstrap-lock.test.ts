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
    unlinkSync: vi.fn(),
  };
});

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { acquireBootstrapLock, waitForBootstrap } from '../../../src/searxng/bootstrap.js';

describe('acquireBootstrapLock', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); });

  it('writes a lock file and returns a release function', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const release = acquireBootstrapLock('/tmp/.wigolo');
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('bootstrap.lock'),
      expect.stringContaining(`"pid":${process.pid}`),
    );
    release();
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining('bootstrap.lock'));
  });

  it('throws if another live process holds the lock', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // process.pid is obviously alive
    expect(() => acquireBootstrapLock('/tmp/.wigolo')).toThrow(/bootstrap already in progress/i);
  });

  it('wipes a stale lock (dead PID) and acquires', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ pid: 999999999, startedAt: '2026-04-13T00:00:00Z' }));
    // pid 999999999 is dead; acquireBootstrapLock wipes it
    const release = acquireBootstrapLock('/tmp/.wigolo');
    expect(unlinkSync).toHaveBeenCalledWith(expect.stringContaining('bootstrap.lock'));
    expect(writeFileSync).toHaveBeenCalled();
    release();
  });

  it('treats a malformed lock file as stale', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{ not json');
    const release = acquireBootstrapLock('/tmp/.wigolo');
    expect(writeFileSync).toHaveBeenCalled();
    release();
  });
});

describe('waitForBootstrap', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); vi.useRealTimers(); });

  it('resolves when state becomes ready', async () => {
    let call = 0;
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      call++;
      return JSON.stringify({ status: call < 2 ? 'downloading' : 'ready' });
    });
    await expect(waitForBootstrap('/tmp/.wigolo', { timeoutMs: 5000, intervalMs: 10 })).resolves.toBe('ready');
  });

  it('resolves when state becomes failed', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'failed' }));
    await expect(waitForBootstrap('/tmp/.wigolo', { timeoutMs: 5000, intervalMs: 10 })).resolves.toBe('failed');
  });

  it('rejects after timeout', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'downloading' }));
    await expect(waitForBootstrap('/tmp/.wigolo', { timeoutMs: 50, intervalMs: 10 }))
      .rejects.toThrow(/timed out/i);
  });

  it('resolves as failed when status is no_runtime', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'no_runtime' }));
    await expect(waitForBootstrap('/tmp/.wigolo', { timeoutMs: 5000, intervalMs: 10 })).resolves.toBe('failed');
  });
});
