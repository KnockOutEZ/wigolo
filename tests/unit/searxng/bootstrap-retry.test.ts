import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}));

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

import { existsSync, readFileSync } from 'node:fs';
import { getBootstrapState, backoffSchedule } from '../../../src/searxng/bootstrap.js';

describe('BootstrapState back-compat read', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); });

  it('reads the new schema unchanged', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      status: 'failed',
      attempts: 2,
      lastAttemptAt: '2026-04-13T00:00:00Z',
      nextRetryAt: '2026-04-13T01:00:00Z',
      lastError: { message: 'boom', stderr: 'err', exitCode: 1, command: 'pip', timestamp: '2026-04-13T00:00:00Z' },
    }));
    const s = getBootstrapState('/tmp/.wigolo');
    expect(s?.status).toBe('failed');
    expect(s?.attempts).toBe(2);
    expect(s?.lastError?.message).toBe('boom');
  });

  it('reads the legacy schema with { status, error } only', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'failed', error: 'old' }));
    const s = getBootstrapState('/tmp/.wigolo');
    expect(s?.status).toBe('failed');
    expect(s?.error).toBe('old');
    expect(s?.attempts).toBeUndefined(); // missing fields stay undefined; callers default them
  });

  it('returns null for an unparseable state file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('{ not json');
    expect(getBootstrapState('/tmp/.wigolo')).toBeNull();
  });
});

describe('backoffSchedule', () => {
  const originalEnv = process.env;

  beforeEach(() => { process.env = { ...originalEnv }; resetConfig(); });
  afterEach(() => { process.env = originalEnv; resetConfig(); });

  it('returns 30s / 1h / 24h for attempts 1, 2, 3', () => {
    expect(backoffSchedule(1)).toBe(30);
    expect(backoffSchedule(2)).toBe(3600);
    expect(backoffSchedule(3)).toBe(86400);
  });

  it('returns null once attempts exceed MAX_AUTO_ATTEMPTS', () => {
    expect(backoffSchedule(0)).toBeNull();
    expect(backoffSchedule(4)).toBeNull();
    expect(backoffSchedule(99)).toBeNull();
  });

  it('respects WIGOLO_BOOTSTRAP_BACKOFF_SECONDS env override', () => {
    process.env.WIGOLO_BOOTSTRAP_BACKOFF_SECONDS = '1,2,3';
    resetConfig();
    expect(backoffSchedule(1)).toBe(1);
    expect(backoffSchedule(3)).toBe(3);
  });
});

import { spawnSync } from 'node:child_process';
import { BootstrapError, runStep } from '../../../src/searxng/bootstrap.js';

describe('runStep', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns silently on exit 0', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0, stdout: '', stderr: '', signal: null, pid: 1, output: [], error: undefined,
    } as ReturnType<typeof spawnSync>);
    expect(() => runStep('echo', ['hi'], { timeout: 1000 })).not.toThrow();
  });

  it('throws BootstrapError on non-zero exit, capturing stderr and command', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'ERROR: could not satisfy requirement',
      signal: null, pid: 1, output: [], error: undefined,
    } as ReturnType<typeof spawnSync>);
    try {
      runStep('pip', ['install', '-r', 'reqs.txt'], { timeout: 1000 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BootstrapError);
      const e = err as BootstrapError;
      expect(e.detail.stderr).toBe('ERROR: could not satisfy requirement');
      expect(e.detail.exitCode).toBe(1);
      expect(e.detail.command).toBe('pip install -r reqs.txt');
    }
  });

  it('throws BootstrapError when spawnSync returns an error (e.g. ENOENT)', () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: null,
      stdout: '',
      stderr: '',
      signal: null, pid: 0, output: [],
      error: new Error('spawn pip ENOENT'),
    } as ReturnType<typeof spawnSync>);
    expect(() => runStep('pip', [], { timeout: 1000 })).toThrow(BootstrapError);
  });
});
