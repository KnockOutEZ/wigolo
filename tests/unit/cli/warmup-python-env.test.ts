import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execSync: vi.fn() };
});

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
import { execSync } from 'node:child_process';
import { runWarmup } from '../../../src/cli/warmup.js';

const VENV_PYTHON = '/tmp/wigolo/searxng/venv/bin/python';

describe('warmup uses venv python', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });
  afterEach(() => {
    resetConfig();
    delete process.env.WIGOLO_DATA_DIR;
  });

  it('installs trafilatura via venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);

    await runWarmup(['--trafilatura']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    const trafCall = calls.find((c) => c.includes('trafilatura'));
    expect(trafCall).toBeDefined();
    expect(trafCall).toContain(VENV_PYTHON);
    expect(trafCall).toContain('-m pip install');
  });

  it('installs flashrank via venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);

    await runWarmup(['--reranker']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    const fr = calls.find((c) => c.includes('flashrank'));
    expect(fr).toBeDefined();
    expect(fr).toContain(VENV_PYTHON);
  });

  it('installs sentence-transformers via venv python when venv exists', async () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p) === VENV_PYTHON);

    await runWarmup(['--embeddings']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    const st = calls.find((c) => c.includes('sentence-transformers'));
    expect(st).toBeDefined();
    expect(st).toContain(VENV_PYTHON);
  });

  it('falls back to system python3 when venv does not exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    await runWarmup(['--trafilatura']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    const trafCall = calls.find((c) => c.includes('trafilatura'));
    expect(trafCall).toBeDefined();
    expect(trafCall).toMatch(/^python3\s+-m pip install/);
    expect(trafCall).not.toContain(VENV_PYTHON);
  });
});

describe('warmup Lightpanda URL', () => {
  const realPlatform = process.platform;
  const realArch = process.arch;

  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
    process.env.WIGOLO_DATA_DIR = '/tmp/wigolo';
    vi.mocked(existsSync).mockReturnValue(false); // force "needs install" path
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });
  afterEach(() => {
    resetConfig();
    delete process.env.WIGOLO_DATA_DIR;
    Object.defineProperty(process, 'platform', { value: realPlatform });
    Object.defineProperty(process, 'arch', { value: realArch });
  });

  it('uses lightpanda-io/browser nightly URL for darwin arm64', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });

    await runWarmup(['--lightpanda']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    const lp = calls.find((c) => c.includes('lightpanda'));
    expect(lp).toBeDefined();
    expect(lp).toContain('github.com/lightpanda-io/browser');
    expect(lp).toContain('nightly');
    expect(lp).toContain('lightpanda-aarch64-macos');
    expect(lp).not.toContain('nichochar');
  });

  it('uses lightpanda-io/browser nightly URL for linux x64', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });

    await runWarmup(['--lightpanda']);

    const calls = vi.mocked(execSync).mock.calls.map((c) => String(c[0]));
    const lp = calls.find((c) => c.includes('lightpanda'));
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
