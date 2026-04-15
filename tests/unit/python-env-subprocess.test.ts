import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { resetConfig } from '../../src/config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFile: vi.fn(), spawn: vi.fn() };
});

vi.mock('../../src/logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { existsSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';

const VENV_PYTHON = '/tmp/wigolo/searxng/venv/bin/python';

function makeProc(opts: { stdout?: string; exitCode?: number } = {}): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  (proc as any).stdout = stdoutEmitter;
  (proc as any).stderr = stderrEmitter;
  (proc as any).stdin = {
    write: vi.fn(),
    end: () => {
      process.nextTick(() => {
        if (opts.stdout) stdoutEmitter.emit('data', Buffer.from(opts.stdout));
        proc.emit('close', opts.exitCode ?? 0);
      });
    },
  };
  (proc as any).kill = vi.fn();
  return proc;
}

describe('runPythonWithStdin uses getPythonBin', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
  });
  afterEach(() => {
    resetConfig();
    delete process.env.WIGOLO_DATA_DIR;
  });

  it('spawns venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);
    vi.mocked(spawn).mockReturnValue(makeProc({ stdout: '{}' }));

    const { runPythonWithStdin } = await import('../../src/extraction/trafilatura.js');
    await runPythonWithStdin('print("x")', 'input', 5000);

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe(VENV_PYTHON);
  });

  it('spawns python3 when venv missing', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(spawn).mockReturnValue(makeProc({ stdout: '{}' }));

    const { runPythonWithStdin } = await import('../../src/extraction/trafilatura.js');
    await runPythonWithStdin('print("x")', 'input', 5000);

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls[0][0]).toBe('python3');
  });
});

describe('availability checks use getPythonBin', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
  });
  afterEach(() => {
    resetConfig();
    delete process.env.WIGOLO_DATA_DIR;
  });

  it('isTrafilaturaAvailable calls venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);
    vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, cb: any) => {
      // promisify-compatible signature
      const callback = typeof opts === 'function' ? opts : cb;
      if (callback) callback(null, { stdout: '', stderr: '' });
      return {} as any;
    }) as any);

    const { isTrafilaturaAvailable, resetAvailabilityCache } = await import('../../src/extraction/trafilatura.js');
    resetAvailabilityCache();
    await isTrafilaturaAvailable();

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe(VENV_PYTHON);
  });

  it('isFlashRankAvailable calls venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);
    vi.mocked(execFile).mockImplementation(((cmd: any, args: any, opts: any, cb: any) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (callback) callback(null, { stdout: '', stderr: '' });
      return {} as any;
    }) as any);

    const { isFlashRankAvailable, resetAvailabilityCache } = await import('../../src/search/flashrank.js');
    resetAvailabilityCache();
    await isFlashRankAvailable();

    const calls = vi.mocked(execFile).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe(VENV_PYTHON);
  });
});

describe('EmbeddingSubprocess uses getPythonBin', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
  });
  afterEach(() => {
    resetConfig();
    delete process.env.WIGOLO_DATA_DIR;
  });

  it('spawns embedding server with venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);

    // Minimal mock proc for spawn — never emits READY, but we only care about spawn args.
    const proc = new EventEmitter() as ChildProcess;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    (proc as any).stdout = stdoutEmitter;
    (proc as any).stderr = stderrEmitter;
    (proc as any).stdin = { write: vi.fn(), end: vi.fn() };
    (proc as any).kill = vi.fn();
    vi.mocked(spawn).mockReturnValue(proc);

    const { EmbeddingSubprocess } = await import('../../src/embedding/subprocess.js');
    const sub = new EmbeddingSubprocess({ readyTimeoutMs: 50, requestTimeoutMs: 50 });

    // Fire embed to trigger spawn; we don't need it to resolve.
    sub.embed('id1', 'hello').catch(() => { /* expected timeout */ });

    // give spawn a chance to be invoked
    await new Promise((r) => setTimeout(r, 20));

    const calls = vi.mocked(spawn).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0][0]).toBe(VENV_PYTHON);

    sub.shutdown();
  });
});
