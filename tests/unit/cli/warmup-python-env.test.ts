import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: () => true,
  getBootstrapState: () => ({ status: 'ready', searxngPath: '/tmp/wigolo/searxng' }),
  bootstrapNativeSearxng: vi.fn(),
}));

vi.mock('../../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn(),
  resetAvailabilityCache: vi.fn(),
}));

import { existsSync } from 'node:fs';
import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup } from '../../../src/cli/warmup.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const VENV_PYTHON = '/tmp/wigolo/searxng/venv/bin/python';

const pipCallFor = (needle: string) =>
  vi.mocked(runCommand).mock.calls.find((c) => (c[1] as string[]).some((a) => String(a).includes(needle)));

describe('warmup uses venv python', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
    vi.mocked(runCommand).mockResolvedValue(ok);
  });
  afterEach(() => {
    resetConfig();
    delete process.env.WIGOLO_DATA_DIR;
  });

  it('installs trafilatura via venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);

    await runWarmup(['--trafilatura']);

    const trafCall = pipCallFor('trafilatura');
    expect(trafCall).toBeDefined();
    expect(trafCall![0]).toBe(VENV_PYTHON);
    expect(trafCall![1]).toEqual(expect.arrayContaining(['-m', 'pip', 'install']));
  });

  it('installs flashrank via venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);

    await runWarmup(['--reranker']);

    const fr = pipCallFor('flashrank');
    expect(fr).toBeDefined();
    expect(fr![0]).toBe(VENV_PYTHON);
  });

  it('installs sentence-transformers via venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);

    await runWarmup(['--embeddings']);

    const st = pipCallFor('sentence-transformers');
    expect(st).toBeDefined();
    expect(st![0]).toBe(VENV_PYTHON);
  });

  it('falls back to system python3 when venv does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await runWarmup(['--trafilatura']);

    const trafCall = pipCallFor('trafilatura');
    expect(trafCall).toBeDefined();
    expect(trafCall![0]).toBe('python3');
    expect(trafCall![1]).toEqual(expect.arrayContaining(['-m', 'pip', 'install']));
  });
});

describe('warmup Lightpanda URL', () => {
  const realPlatform = process.platform;
  const realArch = process.arch;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
    vi.mocked(existsSync).mockReturnValue(false); // force "needs install" path
    vi.mocked(runCommand).mockResolvedValue(ok);
  });
  afterEach(() => {
    resetConfig();
    delete process.env.WIGOLO_DATA_DIR;
    Object.defineProperty(process, 'platform', { value: realPlatform });
    Object.defineProperty(process, 'arch', { value: realArch });
    globalThis.fetch = originalFetch;
  });

  it('uses lightpanda-io/browser nightly URL for darwin arm64', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '0' }),
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await runWarmup(['--lightpanda']);

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    const lp = urls.find((u) => u.includes('lightpanda'));
    expect(lp).toBeDefined();
    expect(lp).toContain('github.com/lightpanda-io/browser');
    expect(lp).toContain('nightly');
    expect(lp).toContain('lightpanda-aarch64-macos');
    expect(lp).not.toContain('nichochar');
  });

  it('uses lightpanda-io/browser nightly URL for linux x64', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '0' }),
      body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    await runWarmup(['--lightpanda']);

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    const lp = urls.find((u) => u.includes('lightpanda'));
    expect(lp).toBeDefined();
    expect(lp).toContain('lightpanda-x86_64-linux');
    expect(lp).toContain('nightly');
  });

  it('reports failure on unsupported platform/arch combination', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    Object.defineProperty(process, 'arch', { value: 'x64' });

    const result = await runWarmup(['--lightpanda']);

    expect(result.lightpanda).toBe('failed');
    expect(result.lightpandaError).toMatch(/not available/i);
  });
});
