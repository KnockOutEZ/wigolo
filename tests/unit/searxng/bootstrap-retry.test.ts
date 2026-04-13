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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { getBootstrapState, backoffSchedule, type BootstrapState } from '../../../src/searxng/bootstrap.js';

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

import { execSync, spawnSync } from 'node:child_process';
import { BootstrapError, runStep, resolveSearchBackend, bootstrapNativeSearxng } from '../../../src/searxng/bootstrap.js';

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
    try {
      runStep('pip', [], { timeout: 1000 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BootstrapError);
      const e = err as BootstrapError;
      expect(e.detail.stderr).toContain('ENOENT');
      expect(e.detail.exitCode).toBeNull();
      expect(e.detail.command).toContain('pip');
    }
  });
});

describe('resolveSearchBackend — retry-aware failed state', () => {
  beforeEach(() => {
    process.env = { ...process.env };
    delete process.env.SEARXNG_URL;
    resetConfig();
    vi.clearAllMocks();
  });

  it('returns native when retry window is open, attempts < MAX, python present', async () => {
    const pastIso = new Date(Date.now() - 60_000).toISOString();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      status: 'failed', attempts: 1, nextRetryAt: pastIso,
    }));
    vi.mocked(execSync).mockReturnValue(Buffer.from('Python 3.12.0')); // python available
    const r = await resolveSearchBackend();
    expect(r.type).toBe('native');
  });

  it('returns scraping when retry window is in the future', async () => {
    const futureIso = new Date(Date.now() + 3_600_000).toISOString();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      status: 'failed', attempts: 1, nextRetryAt: futureIso,
    }));
    vi.mocked(execSync).mockImplementation(() => { throw new Error('no docker'); });
    const r = await resolveSearchBackend();
    expect(r.type).toBe('scraping');
  });

  it('returns scraping when attempts >= MAX_AUTO_ATTEMPTS even if window open', async () => {
    const pastIso = new Date(0).toISOString();
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      status: 'failed', attempts: 3, nextRetryAt: pastIso,
    }));
    vi.mocked(execSync).mockImplementation(() => { throw new Error('no docker'); });
    const r = await resolveSearchBackend();
    expect(r.type).toBe('scraping');
  });

  it('retries immediately for legacy state (no attempts/nextRetryAt)', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'failed', error: 'legacy' }));
    vi.mocked(execSync).mockReturnValue(Buffer.from('Python 3.12.0'));
    const r = await resolveSearchBackend();
    expect(r.type).toBe('native');
  });
});

describe('bootstrapNativeSearxng — failure path', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });

  it('writes failed state with attempts=1 and lastError from BootstrapError', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1, stdout: '', stderr: 'pip install failure',
      signal: null, pid: 1, output: [], error: undefined,
    } as ReturnType<typeof spawnSync>);

    let stateOnDisk = JSON.stringify({ status: 'downloading' });
    vi.mocked(existsSync).mockImplementation((p) => !String(p).includes('bootstrap.lock'));
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).includes('state.json')) return stateOnDisk;
      return '';
    });
    vi.mocked(writeFileSync).mockImplementation((p, data) => {
      if (String(p).includes('state.json')) stateOnDisk = String(data);
    });

    await expect(bootstrapNativeSearxng('/tmp/.wigolo')).rejects.toBeInstanceOf(Error);

    const final = JSON.parse(stateOnDisk) as BootstrapState;
    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(1);
    expect(final.nextRetryAt).toBeDefined();
    expect(final.lastError?.stderr).toBe('pip install failure');
  });

  it('preserves attempts counter in the downloading state write', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1, stdout: '', stderr: 'pip install failure',
      signal: null, pid: 1, output: [], error: undefined,
    } as ReturnType<typeof spawnSync>);

    const writes: string[] = [];
    let stateOnDisk = JSON.stringify({ status: 'failed', attempts: 2 });
    vi.mocked(existsSync).mockImplementation((p) => !String(p).includes('bootstrap.lock'));
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).includes('state.json')) return stateOnDisk;
      return '';
    });
    vi.mocked(writeFileSync).mockImplementation((p, data) => {
      if (String(p).includes('state.json')) {
        stateOnDisk = String(data);
        writes.push(stateOnDisk);
      }
    });

    await expect(bootstrapNativeSearxng('/tmp/.wigolo')).rejects.toBeInstanceOf(Error);

    const downloading = JSON.parse(writes[0]) as BootstrapState;
    expect(downloading.status).toBe('downloading');
    expect(downloading.attempts).toBe(2);
  });

  it('increments attempts on successive failures', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1, stdout: '', stderr: 'pip install failure',
      signal: null, pid: 1, output: [], error: undefined,
    } as ReturnType<typeof spawnSync>);

    let stateOnDisk = JSON.stringify({ status: 'failed', attempts: 2 });
    vi.mocked(existsSync).mockImplementation((p) => !String(p).includes('bootstrap.lock'));
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p).includes('state.json')) return stateOnDisk;
      return '';
    });
    vi.mocked(writeFileSync).mockImplementation((p, data) => {
      if (String(p).includes('state.json')) stateOnDisk = String(data);
    });

    await expect(bootstrapNativeSearxng('/tmp/.wigolo')).rejects.toBeInstanceOf(Error);

    const final = JSON.parse(stateOnDisk) as BootstrapState;
    expect(final.status).toBe('failed');
    expect(final.attempts).toBe(3);
  });
});
