import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// Mock the bundled Playwright module the same way doctor.test.ts does, so the
// post-install probe can be driven via executablePath() + existsSync + launch.
// launch() defaults to a successful headless browser that closes cleanly; the
// shared browser-probe runs this smoke-test as the real health verdict.
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn(),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn(),
}));

vi.mock('../../../src/python-env.js', () => ({
  checkVenvModule: vi.fn(() => ({ available: true })),
  venvInstallHint: (v?: string) =>
    `python3 venv module not available. On Debian/Ubuntu, run: sudo apt install ${v ? `python${v}-venv (or python3-venv)` : 'python3-venv'}. Search will use the built-in core backend until this is fixed.`,
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo' })),
}));

const rerankMock = vi.fn().mockResolvedValue([{ id: '0', score: 0.5 }]);
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: rerankMock,
  })),
}));

vi.mock('../../../src/embedding/fastembed-provider.js', () => {
  const FastembedEmbedProvider = vi.fn(function (this: Record<string, unknown>) {
    this.modelId = 'BGE-small-en-v1.5';
    this.dim = 384;
    this.warmup = vi.fn().mockResolvedValue(undefined);
    this.embed = vi.fn().mockResolvedValue([new Float32Array(384).fill(0.1)]);
  });
  return { FastembedEmbedProvider };
});

import { existsSync } from 'node:fs';
import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup } from '../../../src/cli/warmup.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../../../src/searxng/bootstrap.js';
import { checkVenvModule } from '../../../src/python-env.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const failWith = (msg: string) => ({ code: 1, stdout: '', stderr: msg, timedOut: false });

const argsOf = (call: unknown[]): string[] => (call[1] as string[]) ?? [];
const includesArg = (call: unknown[], needle: string): boolean =>
  argsOf(call).some((a) => String(a).includes(needle));

describe('runWarmup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(checkVenvModule).mockReturnValue({ available: true });
  });

  it('installs chromium via the bundled Playwright CLI, not bare npx', async () => {
    // WHY (GH #116): `npx playwright install` resolves a *separate* Playwright
    // version, so the install revision can differ from the bundled
    // playwright-core revision doctor/runtime resolve. Warmup must spawn node
    // against the bundled cli.js so the install revision == the checked one.
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    const [cmd, args] = vi.mocked(runCommand).mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('install');
    expect(args).toContain('chromium');
    // The CLI argument must point at the project's node_modules playwright,
    // never a bare `npx playwright` invocation.
    expect(args[0]).toMatch(/node_modules[\\/]playwright[\\/]cli\.js$/);
    expect(args[0]).not.toBe('npx');
    expect(result.playwright).toBe('ok');
  });

  it('reports playwright failure without throwing', async () => {
    vi.mocked(runCommand).mockResolvedValue(failWith('install failed'));
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.playwright).toBe('failed');
    expect(result.playwrightError).toBe('install failed');
  });

  it('reports chromium FAILED when install exits 0 but binary is missing on disk', async () => {
    // WHY (GH #116): warmup historically trusted only the install command's
    // exit code and reported "ok" while doctor found the binary absent. The
    // post-install disk verify must catch this and report failure instead.
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    vi.mocked(runCommand).mockResolvedValue(ok); // install "succeeds"
    vi.mocked(existsSync).mockReturnValue(false); // ...but binary is not on disk

    const result = await runWarmup();

    expect(result.playwright).toBe('failed');
    expect(result.playwrightError).toContain('missing on disk');
  });

  it('reports chromium ok when install exits 0 and the binary is present on disk', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(existsSync).mockReturnValue(true);

    const result = await runWarmup();

    expect(result.playwright).toBe('ok');
  });

  it('reports searxng already ready', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.searxng).toBe('ready');
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
  });

  it('bootstraps searxng when python available and not ready', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(bootstrapNativeSearxng).mockResolvedValue(undefined);

    const result = await runWarmup();

    expect(bootstrapNativeSearxng).toHaveBeenCalledWith('/tmp/test-wigolo');
    expect(result.searxng).toBe('bootstrapped');
  });

  it('reports searxng bootstrap failure', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(bootstrapNativeSearxng).mockRejectedValue(new Error('pip failed'));

    const result = await runWarmup();

    expect(result.searxng).toBe('failed');
    expect(result.searxngError).toBe('pip failed');
  });

  it('reports no python available', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(false);

    const result = await runWarmup();

    expect(result.searxng).toBe('no_python');
  });

  it('falls back to core with an actionable apt hint when python3-venv is missing', async () => {
    // WHY: Debian/Ubuntu ship python3 without the python3-venv package, so the
    // old behavior bootstrapped, failed with a cryptic ensurepip error, and
    // left search "failed". Warmup must instead recognize the missing module,
    // name the exact apt package, and keep search working on the core backend.
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(checkVenvModule).mockReturnValue({ available: false, pythonVersion: '3.12' });

    const result = await runWarmup();

    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(result.searxng).toBe('no_venv');
    expect(result.searxngError).toContain('sudo apt install python3.12-venv');
    expect(result.searxngError).toContain('core backend');
  });

  it('--no-searxng skips the searxng phase entirely (real toggle teeth)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);

    const result = await runWarmup(['--no-searxng']);

    // Bootstrap must NOT run, and chromium (required) still installs.
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(result.searxng).toBe('skipped');
    expect(result.playwright).toBe('ok');
  });

  it('--no-searxng does not even probe getBootstrapState or python', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);

    await runWarmup(['--no-searxng']);

    expect(getBootstrapState).not.toHaveBeenCalled();
    expect(checkPythonAvailable).not.toHaveBeenCalled();
  });
});

const mockFetchNoop = () => {
  const headers = new Headers({ 'content-length': '0' });
  const resp = {
    ok: true,
    status: 200,
    headers,
    body: { getReader: () => ({ read: async () => ({ done: true, value: undefined }) }) },
  };
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp as unknown as Response);
};

describe('runWarmup with flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    mockFetchNoop();
  });

  it('accepts flags parameter without breaking existing behavior', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup([]);

    expect(result.playwright).toBe('ok');
    expect(result.searxng).toBe('ready');
  });

  it('accepts no arguments (backward compatible)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.playwright).toBe('ok');
  });

});

describe('warmup --reranker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    rerankMock.mockResolvedValue([{ id: '0', score: 0.5 }]);
  });

  it('runs the rerank provider warmup when --reranker passed', async () => {
    const result = await runWarmup(['--reranker']);

    expect(rerankMock).toHaveBeenCalled();
    expect(result.reranker).toBe('ok');
  });

  it('--all flag includes reranker warmup', async () => {
    const result = await runWarmup(['--all']);

    expect(rerankMock).toHaveBeenCalled();
    expect(result.reranker).toBe('ok');
  });

  it('--all does not pip-install any Python rerank packages', async () => {
    await runWarmup(['--all']);

    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls.find((c) => includesArg(c, 'sentence-transformers'))).toBeUndefined();
    expect(calls.find((c) => includesArg(c, 'tokenizers'))).toBeUndefined();
    expect(calls.find((c) => includesArg(c, 'onnxruntime'))).toBeUndefined();
    expect(calls.find((c) => includesArg(c, 'flashrank'))).toBeUndefined();
  });

  it('does not install reranker when flag not passed', async () => {
    const result = await runWarmup([]);

    expect(rerankMock).not.toHaveBeenCalled();
    expect(result.reranker).toBeUndefined();
  });

  it('reports failure when rerank provider warmup throws', async () => {
    rerankMock.mockRejectedValueOnce(new Error('model load failed'));

    const result = await runWarmup(['--reranker']);

    expect(result.reranker).toBe('failed');
    expect(result.rerankerError).toContain('model load failed');
  });
});
