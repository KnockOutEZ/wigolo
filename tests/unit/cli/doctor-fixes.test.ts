import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('node:child_process', () => ({ execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});
// doctor probes browser health via a real headless launch (shared with
// warmup, GH #116). Mock playwright so the probe never launches a real browser
// — without this the probe would try to spawn Chromium and hit the test timeout.
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});
vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.9 }]),
  })),
}));

// The repair functions are the SAME primitives warmup uses. Mock them so
// `--fix` exercises the doctor orchestration (before → repair → after) without
// downloading a model or launching a real browser.
const installBrowserMock = vi.fn(async () => ({ ok: true as boolean, error: undefined as string | undefined }));
const installEmbeddingsMock = vi.fn(async () => ({ embeddings: 'ok' as const, embeddingsError: undefined }));
const wipeSearxngStateMock = vi.fn();
vi.mock('../../../src/cli/warmup.js', () => ({
  installBrowser: (...a: unknown[]) => installBrowserMock(...(a as [])),
  installEmbeddings: (...a: unknown[]) => installEmbeddingsMock(...(a as [])),
  wipeSearxngState: (...a: unknown[]) => wipeSearxngStateMock(...(a as [])),
}));

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { runDoctor } from '../../../src/cli/doctor.js';
import { getBreakerSnapshot, resetBreakers } from '../../../src/search/core/engine-base.js';

function okProc(stdout = ''): ReturnType<typeof spawnSync> {
  return { status: 0, stdout, stderr: '', signal: null, pid: 1, output: [], error: undefined } as ReturnType<typeof spawnSync>;
}

let outBuffer = '';
let stdoutBuffer = '';
let writeSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  outBuffer = '';
  stdoutBuffer = '';
  resetConfig();
  vi.clearAllMocks();
  installBrowserMock.mockResolvedValue({ ok: true, error: undefined });
  installEmbeddingsMock.mockResolvedValue({ embeddings: 'ok', embeddingsError: undefined });
  vi.mocked(readdirSync).mockReturnValue([] as never);
  writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    outBuffer += String(chunk);
    return true;
  });
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdoutBuffer += String(chunk);
    return true;
  });
});

afterEach(() => {
  resetConfig();
  resetBreakers();
  delete process.env.WIGOLO_DATA_DIR;
  writeSpy.mockRestore();
  stdoutSpy.mockRestore();
});

/** Mock a fully-healthy machine: python ok, everything on disk, searxng ready. */
function mockHealthy(): void {
  vi.mocked(spawnSync).mockImplementation((cmd, args) => {
    const joined = [cmd, ...((args ?? []) as string[])].join(' ');
    if (joined.includes('--version')) return okProc('Python 3.12.4');
    return okProc('Python 3.12.4');
  });
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readdirSync).mockReturnValue(['model'] as never);
  vi.mocked(readFileSync).mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
    if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
    return '';
  });
}

describe('doctor --fix', () => {
  it('installs the missing browser and reports before/after (exit 0 when repaired)', async () => {
    // Browser on disk path resolves but file is missing → chromium missing.
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('1.50.0');
      return okProc('Python 3.12.4');
    });
    // First doctor pass: chromium binary NOT on disk. After the repair the
    // installer mock reports ok, so the after-check must see it launchable —
    // we flip existsSync via the install mock side effect.
    let browserOnDisk = false;
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('/fake/playwright/chromium/')) return browserOnDisk;
      return true;
    });
    vi.mocked(readdirSync).mockReturnValue(['model'] as never);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    installBrowserMock.mockImplementation(async () => {
      browserOnDisk = true; // repair puts the binary on disk
      return { ok: true, error: undefined };
    });

    const code = await runDoctor('/tmp/.wigolo', { fix: true });

    expect(installBrowserMock).toHaveBeenCalledWith('chromium');
    expect(outBuffer.toLowerCase()).toMatch(/fix/);
    expect(code).toBe(0);
  });

  it('installs the missing embedding model when the fastembed cache is empty', async () => {
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('Python 3.12.4');
      return okProc('Python 3.12.4');
    });
    let embeddingsInstalled = false;
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('fastembed')) return embeddingsInstalled;
      return true;
    });
    vi.mocked(readdirSync).mockImplementation(() => (embeddingsInstalled ? ['model'] : []) as never);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    installEmbeddingsMock.mockImplementation(async () => {
      embeddingsInstalled = true;
      return { embeddings: 'ok', embeddingsError: undefined };
    });

    const code = await runDoctor('/tmp/.wigolo', { fix: true });

    expect(installEmbeddingsMock).toHaveBeenCalled();
    expect(code).toBe(0);
  });

  it('NEGATIVE: on backend=core, stale searxng locks do NOT trigger wipeSearxngState', async () => {
    // WHY (D9 hard gate): wiping searxng state on a core-backend machine is a
    // false repair — the sidecar is not in use. The wipe is gated on
    // searxngConfigured(); core + stale locks ⇒ wipe NOT called.
    delete process.env.WIGOLO_SEARCH; // core
    resetConfig();
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      // stale searxng.lock present, but state.json failed/absent
      if (s.endsWith('searxng.lock')) return true;
      if (s.endsWith('state.json')) return false;
      return true;
    });
    vi.mocked(readdirSync).mockReturnValue(['model'] as never);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      // stale lock → dead pid
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: 99999999, port: 8888 });
      return '';
    });

    await runDoctor('/tmp/.wigolo', { fix: true });

    expect(wipeSearxngStateMock).not.toHaveBeenCalled();
  });

  it('POSITIVE: on backend=searxng with a failed bootstrap, wipeSearxngState IS called', async () => {
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readdirSync).mockReturnValue(['model'] as never);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'failed', attempts: 3, lastError: { message: 'pip failed' } });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: 99999999, port: 8888 });
      return '';
    });

    await runDoctor('/tmp/.wigolo', { fix: true });

    expect(wipeSearxngStateMock).toHaveBeenCalledWith('/tmp/.wigolo');
    delete process.env.WIGOLO_SEARCH;
    resetConfig();
  });

  it('resets in-process breakers so the pool is un-stuck (getBreakerSnapshot clears)', async () => {
    mockHealthy();
    const { wrapWithRetryAndBreaker } = await import('../../../src/search/core/engine-base.js');
    // Trip a breaker deterministically: an engine that always throws, called
    // three times, opens its breaker.
    const failing = wrapWithRetryAndBreaker({
      name: 'doctor-fix-probe',
      search: async () => { throw new Error('boom'); },
    });
    for (let i = 0; i < 3; i++) {
      await failing.search('q').catch(() => undefined);
    }
    expect(getBreakerSnapshot().some((b) => b.engine === 'doctor-fix-probe' && b.state !== 'closed')).toBe(true);

    await runDoctor('/tmp/.wigolo', { fix: true });

    expect(getBreakerSnapshot()).toHaveLength(0);
  });

  it('is idempotent — a second --fix run reports nothing to fix and changes nothing', async () => {
    mockHealthy();
    const code1 = await runDoctor('/tmp/.wigolo', { fix: true });
    installBrowserMock.mockClear();
    installEmbeddingsMock.mockClear();
    wipeSearxngStateMock.mockClear();
    const code2 = await runDoctor('/tmp/.wigolo', { fix: true });

    expect(code1).toBe(0);
    expect(code2).toBe(0);
    expect(installBrowserMock).not.toHaveBeenCalled();
    expect(installEmbeddingsMock).not.toHaveBeenCalled();
    expect(wipeSearxngStateMock).not.toHaveBeenCalled();
  });
});

describe('doctor --json', () => {
  it('emits a single machine-readable JSON object to stdout that JSON.parses', async () => {
    mockHealthy();
    const code = await runDoctor('/tmp/.wigolo', { json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(parsed).toHaveProperty('status');
    expect(['ok', 'degraded']).toContain(parsed.status);
    expect(parsed).toHaveProperty('exitCode', code);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it('includes per-fix before/after status under --fix --json', async () => {
    // Missing browser so a fix runs; the JSON must carry a before/after entry.
    vi.mocked(spawnSync).mockImplementation((cmd, args) => {
      const joined = [cmd, ...((args ?? []) as string[])].join(' ');
      if (joined.includes('--version')) return okProc('1.50.0');
      return okProc('Python 3.12.4');
    });
    let browserOnDisk = false;
    vi.mocked(existsSync).mockImplementation((p) => {
      const s = String(p);
      if (s.includes('/fake/playwright/chromium/')) return browserOnDisk;
      return true;
    });
    vi.mocked(readdirSync).mockReturnValue(['model'] as never);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: process.pid, port: 8888 });
      return '';
    });
    installBrowserMock.mockImplementation(async () => {
      browserOnDisk = true;
      return { ok: true, error: undefined };
    });

    await runDoctor('/tmp/.wigolo', { fix: true, json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(Array.isArray(parsed.fixes)).toBe(true);
    const browserFix = parsed.fixes.find((f: { name: string }) => f.name === 'browser');
    expect(browserFix).toBeDefined();
    expect(browserFix).toHaveProperty('before');
    expect(browserFix).toHaveProperty('after');
  });

  it('the JSON status field is exit-code-meaningful (degraded → exit 1)', async () => {
    // Failed searxng bootstrap, backend=searxng, non-fixable via wipe alone
    // (wipe clears but bootstrap still needs a warmup) → degraded.
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    vi.mocked(spawnSync).mockImplementation(() => okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockImplementation((p) => String(p).endsWith('state.json'));
    vi.mocked(readdirSync).mockReturnValue(['model'] as never);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ status: 'failed', attempts: 3, lastError: { message: 'pip failed' } }));

    const code = await runDoctor('/tmp/.wigolo', { json: true });
    const parsed = JSON.parse(stdoutBuffer);
    expect(code).toBe(1);
    expect(parsed.status).toBe('degraded');
    expect(parsed.exitCode).toBe(1);
    delete process.env.WIGOLO_SEARCH;
    resetConfig();
  });
});

describe('doctor — SearXNG process state is not a hard failure', () => {
  it('returns 0 and says "starts on-demand" when installed but not running (sidecar configured)', async () => {
    // The process-state line lives in the searxng-configured section (D5 gates
    // it off on the default core backend), so opt into the sidecar backend to
    // exercise the "not a hard failure" assertion.
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    try {
      vi.mocked(spawnSync).mockReturnValue(okProc('Python 3.12.4'));
      vi.mocked(existsSync).mockImplementation((p) => {
        const s = String(p);
        if (s.endsWith('state.json')) return true;
        if (s.endsWith('searxng.lock')) return false;
        return true;
      });
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (String(p).endsWith('state.json')) {
          return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
        }
        return '';
      });

      const code = await runDoctor('/tmp/.wigolo');

      expect(code).toBe(0);
      expect(outBuffer).toMatch(/not running.*starts on-demand/i);
      expect(outBuffer).toMatch(/Overall: OK/);
    } finally {
      delete process.env.WIGOLO_SEARCH;
      resetConfig();
    }
  });

  it('returns 0 when stale lock exists but SearXNG is installed', async () => {
    vi.mocked(spawnSync).mockReturnValue(okProc('Python 3.12.4'));
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('state.json')) return JSON.stringify({ status: 'ready', searxngPath: '/tmp/searxng' });
      if (s.endsWith('searxng.lock')) return JSON.stringify({ pid: 99999999, port: 8888 });
      return '';
    });

    const code = await runDoctor('/tmp/.wigolo');

    expect(code).toBe(0);
    expect(outBuffer).toMatch(/Overall: OK/);
  });
});

