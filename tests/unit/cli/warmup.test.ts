import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
// shared browser-probe runs this smoke-test as the real health check.
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
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: null })),
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
import { rmSync } from 'node:fs';
import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup, installBrowser, installEmbeddings, wipeSearxngState, sanitizeBrowserInstallError } from '../../../src/cli/warmup.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../../../src/searxng/bootstrap.js';
import { checkVenvModule } from '../../../src/python-env.js';
import { getConfig } from '../../../src/config.js';

// D1: the searxng phase now only runs when the sidecar is opted into
// (--searxng, or --all with a searxng/hybrid backend or external URL). The
// core-backend default runs browser + models only. Tests that exercise the
// searxng-phase machinery therefore pass --searxng explicitly.

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const failWith = (msg: string) => ({ code: 1, stdout: '', stderr: msg, timedOut: false });

// The exact ASCII-box warning Playwright prints when its CLI is resolved from an
// npx cache path (`process.argv[1]` contains `_npx`). Under `npx wigolo` the
// bundled playwright cli.js lives at `~/.npm/_npx/<hash>/node_modules/...`, so
// this banner ALWAYS fires — it is a harmless warning, never the real failure.
const NPX_BANNER = [
  '╔═══════════════════════════════════════════════════════════════════════════════╗',
  "║ WARNING: It looks like you are running 'npx playwright install' without first  ║",
  "║ installing your project's dependencies.                                        ║",
  '║                                                                               ║',
  '║     npm install                                                                ║',
  '║     npx playwright install                                                     ║',
  '╚═══════════════════════════════════════════════════════════════════════════════╝',
].join('\n');

const argsOf = (call: unknown[]): string[] => (call[1] as string[]) ?? [];
const includesArg = (call: unknown[], needle: string): boolean =>
  argsOf(call).some((a) => String(a).includes(needle));

const coreConfig = { dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: null };

describe('runWarmup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(checkVenvModule).mockReturnValue({ available: true });
    // Restore the core-backend default; individual tests opt into searxng.
    vi.mocked(getConfig).mockReturnValue(coreConfig as never);
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

  it('reports searxng already ready (with --searxng)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup(['--searxng']);

    expect(result.searxng).toBe('ready');
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
  });

  it('bootstraps searxng when python available and not ready (with --searxng)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(bootstrapNativeSearxng).mockResolvedValue(undefined);

    const result = await runWarmup(['--searxng']);

    expect(bootstrapNativeSearxng).toHaveBeenCalledWith('/tmp/test-wigolo');
    expect(result.searxng).toBe('bootstrapped');
  });

  it('reports searxng bootstrap failure (with --searxng)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(bootstrapNativeSearxng).mockRejectedValue(new Error('pip failed'));

    const result = await runWarmup(['--searxng']);

    expect(result.searxng).toBe('failed');
    expect(result.searxngError).toBe('pip failed');
  });

  it('reports no python available (with --searxng)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(false);

    const result = await runWarmup(['--searxng']);

    expect(result.searxng).toBe('no_python');
  });

  it('falls back to core with an actionable apt hint when python3-venv is missing (with --searxng)', async () => {
    // WHY: Debian/Ubuntu ship python3 without the python3-venv package, so the
    // old behavior bootstrapped, failed with a cryptic ensurepip error, and
    // left search "failed". Warmup must instead recognize the missing module,
    // name the exact apt package, and keep search working on the core backend.
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);
    vi.mocked(checkVenvModule).mockReturnValue({ available: false, pythonVersion: '3.12' });

    const result = await runWarmup(['--searxng']);

    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(result.searxng).toBe('no_venv');
    expect(result.searxngError).toContain('sudo apt install python3.12-venv');
    expect(result.searxngError).toContain('core backend');
  });

  it('--searxng triggers the searxng phase explicitly even on a core backend', async () => {
    // WHY (D1): --searxng is the explicit opt-in trigger — a user who wants the
    // sidecar can install it without changing WIGOLO_SEARCH.
    vi.mocked(getConfig).mockReturnValue({ dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: null } as never);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup(['--searxng']);

    expect(result.searxng).toBe('ready');
  });

  it('default run on a core backend SKIPS the searxng phase (no probe, no bootstrap)', async () => {
    // WHY (D1): a zero-config user running `wigolo warmup` must get browser +
    // models only — never a Python sidecar bootstrap.
    vi.mocked(getConfig).mockReturnValue({ dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: null } as never);
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);

    const result = await runWarmup();

    expect(result.searxng).toBe('skipped');
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(getBootstrapState).not.toHaveBeenCalled();
    expect(checkPythonAvailable).not.toHaveBeenCalled();
    expect(result.playwright).toBe('ok');
  });

  it('--all on a core backend installs browser + models but SKIPS searxng', async () => {
    // WHY (D1): --all must not install the sidecar for a core user — it kills
    // the D1↔D8 hint contradiction (init/warmup no longer promise the sidecar).
    vi.mocked(getConfig).mockReturnValue({ dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: null } as never);
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);

    const result = await runWarmup(['--all']);

    expect(result.searxng).toBe('skipped');
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(result.reranker).toBe('ok');
    expect(result.embeddings).toBe('ok');
  });

  it('--all with a searxng backend DOES run the searxng phase', async () => {
    vi.mocked(getConfig).mockReturnValue({ dataDir: '/tmp/test-wigolo', searchBackend: 'searxng', searxngUrl: null } as never);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup(['--all']);

    expect(result.searxng).toBe('ready');
  });

  it('--all with an external searxngUrl DOES run the searxng phase', async () => {
    vi.mocked(getConfig).mockReturnValue({ dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: 'http://sx.local:8888' } as never);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup(['--all']);

    expect(result.searxng).toBe('ready');
  });

  it('--all --no-searxng with a searxng backend SKIPS searxng (active suppressor wins)', async () => {
    // WHY (D1): --no-searxng is an ACTIVE suppressor and must beat --all even
    // when the sidecar is configured — preserves today's skip combo.
    vi.mocked(getConfig).mockReturnValue({ dataDir: '/tmp/test-wigolo', searchBackend: 'searxng', searxngUrl: null } as never);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup(['--all', '--no-searxng']);

    expect(result.searxng).toBe('skipped');
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(getBootstrapState).not.toHaveBeenCalled();
  });

  it('--no-searxng skips the searxng phase entirely (real toggle teeth)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);

    const result = await runWarmup(['--searxng', '--no-searxng']);

    // Bootstrap must NOT run, and chromium (required) still installs.
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(result.searxng).toBe('skipped');
    expect(result.playwright).toBe('ok');
  });

  it('--no-searxng does not even probe getBootstrapState or python', async () => {
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);

    await runWarmup(['--searxng', '--no-searxng']);

    expect(getBootstrapState).not.toHaveBeenCalled();
    expect(checkPythonAvailable).not.toHaveBeenCalled();
  });

  it('--browser runs only the chromium phase (no searxng, no reranker, no embeddings)', async () => {
    // WHY (D3/D9): the browser-install error text names `wigolo warmup
    // --browser`, so the flag must actually exist and run the chromium phase in
    // isolation.
    vi.mocked(getConfig).mockReturnValue({ dataDir: '/tmp/test-wigolo', searchBackend: null, searxngUrl: null } as never);
    vi.mocked(getBootstrapState).mockReturnValue(null);
    vi.mocked(checkPythonAvailable).mockReturnValue(true);

    const result = await runWarmup(['--browser']);

    expect(result.playwright).toBe('ok');
    expect(result.searxng).toBe('skipped');
    expect(bootstrapNativeSearxng).not.toHaveBeenCalled();
    expect(result.reranker).toBeUndefined();
    expect(result.embeddings).toBeUndefined();
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
    vi.mocked(getConfig).mockReturnValue(coreConfig as never);
    mockFetchNoop();
  });

  it('accepts flags parameter without breaking existing behavior', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup([]);

    expect(result.playwright).toBe('ok');
    // Core-backend default (D1): the searxng phase is skipped.
    expect(result.searxng).toBe('skipped');
  });

  it('accepts no arguments (backward compatible)', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.playwright).toBe('ok');
  });

});

describe('warmup --json (S9)', () => {
  // WHY (D8): warmup already returns a structured WarmupResult; --json
  // serializes it to stdout so a CI/agent can machine-read the outcome while
  // the progress lines stay on stderr.
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutBuf = '';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(getConfig).mockReturnValue(coreConfig as never);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    vi.mocked(existsSync).mockReturnValue(true);
    stdoutBuf = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutBuf += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('emits the WarmupResult as a single JSON object on stdout with capability-named keys', async () => {
    const result = await runWarmup(['--json']);
    const parsed = JSON.parse(stdoutBuf);
    // Machine contract uses capability names, not library names (A1).
    expect(parsed.browserEngine).toBe(result.playwright);
    expect(parsed.searchSidecar).toBe(result.searxng);
    expect(parsed).toHaveProperty('browserEngine');
    expect(parsed).toHaveProperty('searchSidecar');
    expect(parsed).not.toHaveProperty('playwright');
    expect(parsed).not.toHaveProperty('searxng');
  });

  it('still returns the structured WarmupResult from the function', async () => {
    const result = await runWarmup(['--json']);
    expect(result.playwright).toBe('ok');
    expect(result.searxng).toBe('skipped');
  });
});

describe('exported repair functions (S9 — reused by doctor --fix)', () => {
  // WHY (D9): doctor --fix invokes the same repair primitives warmup uses, but
  // it must be able to call them WITHOUT wiring a full WarmupReporter. The three
  // functions are exported and decoupled from the reporter via a no-op default,
  // so a caller that only wants the effect (not the progress lines) can invoke
  // them bare. runWarmup keeps passing its real reporter — behavior unchanged.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(getConfig).mockReturnValue(coreConfig as never);
  });

  it('installBrowser is exported and runs without a reporter', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    const r = await installBrowser('chromium');
    expect(r.ok).toBe(true);
    const [cmd, args] = vi.mocked(runCommand).mock.calls[0] as [string, string[], unknown];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('install');
    expect(args).toContain('chromium');
  });

  it('installEmbeddings is exported and runs without a reporter', async () => {
    const r = await installEmbeddings();
    expect(r.embeddings).toBe('ok');
  });

  it('wipeSearxngState is exported and runs without a reporter', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    // No throw, and it deletes the state/install/lock paths.
    expect(() => wipeSearxngState('/tmp/test-wigolo')).not.toThrow();
    const removed = vi.mocked(rmSync).mock.calls.map((c) => String(c[0]));
    expect(removed.some((p) => p.endsWith('state.json'))).toBe(true);
    expect(removed.some((p) => p.endsWith('searxng.lock'))).toBe(true);
    expect(removed.some((p) => p.endsWith('searxng.port'))).toBe(true);
  });
});

describe('warmup --reranker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
    vi.mocked(getConfig).mockReturnValue(coreConfig as never);
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

describe('sanitizeBrowserInstallError (A1: surface real browser errors, not the npx banner)', () => {
  it('drops the npx-global ASCII banner and surfaces the real stderr error', () => {
    const stderr = `${NPX_BANNER}\nError: Download failure, code 403`;
    expect(sanitizeBrowserInstallError('', stderr, 1)).toBe('Error: Download failure, code 403');
  });

  it('surfaces a real error that landed on STDOUT even when stderr holds only the banner', () => {
    // WHY (field bug): the old `(r.stderr || r.stdout)` dropped stdout entirely,
    // so a download error printed to stdout was masked by the harmless banner.
    expect(
      sanitizeBrowserInstallError('Error: connect ETIMEDOUT cdn.playwright.dev', NPX_BANNER, 1),
    ).toBe('Error: connect ETIMEDOUT cdn.playwright.dev');
  });

  it('never returns a box-drawing border or banner text as the message', () => {
    const out = sanitizeBrowserInstallError('', `${NPX_BANNER}\nreal boom`, 1);
    expect(out).toBe('real boom');
    expect(out.includes('╔')).toBe(false);
    expect(out.includes('║')).toBe(false);
    expect(out.includes('npx playwright install')).toBe(false);
  });

  it('falls back to the exit code when only the banner was printed', () => {
    expect(sanitizeBrowserInstallError('', NPX_BANNER, 7)).toBe('exit 7');
  });

  it('passes a plain error through unchanged when no banner is present', () => {
    expect(sanitizeBrowserInstallError('', 'install failed', 1)).toBe('install failed');
  });
});

describe('installBrowser hardening (3a: slow/flaky network resilience)', () => {
  const installCallsOf = (browser: string) =>
    vi.mocked(runCommand).mock.calls.filter((c) => {
      const a = (c[1] as string[]) ?? [];
      return a.includes('install') && a.includes(browser);
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue(coreConfig as never);
    vi.mocked(existsSync).mockReturnValue(true);
  });

  it('retries the install once when the first attempt fails, then succeeds', async () => {
    // WHY: browser downloads over a slow/flaky link fail transiently (resets,
    // timeouts); a single attempt turns a blip into a hard failure.
    vi.mocked(runCommand)
      .mockResolvedValueOnce(failWith('ECONNRESET'))
      .mockResolvedValue(ok);

    const r = await installBrowser('chromium');

    expect(r.ok).toBe(true);
    expect(installCallsOf('chromium').length).toBe(2);
  });

  it('gives a slow download more than the old 180s budget', async () => {
    vi.mocked(runCommand).mockResolvedValue(ok);

    await installBrowser('chromium');

    const opts = (installCallsOf('chromium')[0]?.[2] ?? {}) as { timeout?: number };
    expect(opts.timeout).toBeGreaterThanOrEqual(300_000);
  });

  it('reports a clear timeout + mirror hint on a timed-out download (not a progress fragment)', () => {
    const msg = sanitizeBrowserInstallError('|■■■ 40% of 92 MiB', '', -1, true);
    expect(msg).toMatch(/timed out/i);
    expect(msg).toMatch(/PLAYWRIGHT_DOWNLOAD_HOST|mirror/i);
    expect(msg).not.toContain('■');
  });

  it('does NOT retry a timed-out install (a timeout already spent the full budget)', async () => {
    // WHY (review): retrying a timeout re-downloads from zero and almost always
    // times out again, doubling the wait. Fail fast with the mirror hint instead.
    vi.mocked(runCommand).mockResolvedValue({ code: -1, stdout: '', stderr: '', timedOut: true });

    const r = await installBrowser('chromium');

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
    expect(installCallsOf('chromium').length).toBe(1);
  });

  it('gives up after both attempts fail and surfaces the real error', async () => {
    vi.mocked(runCommand).mockResolvedValue(failWith('boom'));

    const r = await installBrowser('chromium');

    expect(r.ok).toBe(false);
    expect(r.error).toBe('boom');
    expect(installCallsOf('chromium').length).toBe(2);
  });
});

describe('runWarmup browser-failure surfacing (A1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockReturnValue(coreConfig as never);
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
  });

  it('surfaces the real download error, not the npx-global banner, when install fails', async () => {
    // WHY: field installs on macOS/Linux reported `Browser: failed (╔═══╗)` — the
    // banner border, not the actual cause. The real error must reach the user.
    vi.mocked(runCommand).mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: `${NPX_BANNER}\nError: self signed certificate in certificate chain`,
      timedOut: false,
    });

    const result = await runWarmup();

    expect(result.playwright).toBe('failed');
    expect(result.playwrightError).toBe('Error: self signed certificate in certificate chain');
    expect(result.playwrightError).not.toContain('╔');
    expect(result.playwrightError).not.toContain('npx playwright install');
  });
});
