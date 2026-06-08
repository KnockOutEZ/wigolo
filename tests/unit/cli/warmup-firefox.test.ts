import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    // Default true: the post-install disk verify (GH #116) treats existsSync
    // false as a failed install. These tests assert the install *plumbing*, so
    // the binary is considered present unless a case overrides it.
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
  };
});

// Mock the bundled Playwright module so the post-install probe can call
// executablePath() + launch() without launching real browsers. launch()
// resolves to a browser that closes cleanly — the smoke-test passes by default.
vi.mock('playwright', () => {
  const okLaunch = () => Promise.resolve({ close: () => Promise.resolve() });
  return {
    chromium: { executablePath: vi.fn(() => '/fake/playwright/chromium/chrome'), launch: vi.fn(okLaunch) },
    firefox: { executablePath: vi.fn(() => '/fake/playwright/firefox/firefox'), launch: vi.fn(okLaunch) },
    webkit: { executablePath: vi.fn(() => '/fake/playwright/webkit/webkit'), launch: vi.fn(okLaunch) },
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn().mockReturnValue(false),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/providers/rerank-provider.js', () => ({
  getRerankProvider: vi.fn(async () => ({
    modelId: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerank: vi.fn().mockResolvedValue([{ id: '0', score: 0.5 }]),
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
import { chromium, firefox } from 'playwright';
import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup } from '../../../src/cli/warmup.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const failWith = (msg: string) => ({ code: 1, stdout: '', stderr: msg, timedOut: false });

const argsOf = (call: unknown[]): string[] => (call[1] as string[]) ?? [];
const hasFirefoxInstall = (call: unknown[]): boolean => {
  const args = argsOf(call);
  return args.includes('firefox') && args.includes('install');
};
const hasWebkitInstall = (call: unknown[]): boolean => {
  const args = argsOf(call);
  return args.includes('webkit') && args.includes('install');
};

describe('warmup --firefox flag', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
    vi.mocked(runCommand).mockResolvedValue(ok);
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('installs Firefox when --firefox flag is passed', async () => {
    const result = await runWarmup(['--firefox']);

    const calls = vi.mocked(runCommand).mock.calls;
    const firefoxCall = calls.find(hasFirefoxInstall);
    expect(firefoxCall).toBeDefined();
    expect(result.firefox).toBe('ok');
  });

  it('does not install Firefox without --firefox flag', async () => {
    const result = await runWarmup([]);

    const calls = vi.mocked(runCommand).mock.calls;
    const firefoxCall = calls.find(hasFirefoxInstall);
    expect(firefoxCall).toBeUndefined();
    expect(result.firefox).toBeUndefined();
  });

  it('installs Firefox when --all flag is passed', async () => {
    const result = await runWarmup(['--all']);

    const calls = vi.mocked(runCommand).mock.calls;
    const firefoxCall = calls.find(hasFirefoxInstall);
    expect(firefoxCall).toBeDefined();
    expect(result.firefox).toBe('ok');
  });

  it('reports failure when Firefox install fails', async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args.includes('firefox')) {
        return failWith('Host system is missing dependencies to run Firefox');
      }
      return ok;
    });

    const result = await runWarmup(['--firefox']);
    expect(result.firefox).toBe('failed');
    expect(result.firefoxError).toContain('missing dependencies');
  });

  it('installs WebKit when --webkit flag is passed', async () => {
    const result = await runWarmup(['--webkit']);

    const calls = vi.mocked(runCommand).mock.calls;
    const webkitCall = calls.find(hasWebkitInstall);
    expect(webkitCall).toBeDefined();
    expect(result.webkit).toBe('ok');
  });

  it('does not install WebKit without --webkit flag', async () => {
    const result = await runWarmup([]);

    const calls = vi.mocked(runCommand).mock.calls;
    const webkitCall = calls.find(hasWebkitInstall);
    expect(webkitCall).toBeUndefined();
    expect(result.webkit).toBeUndefined();
  });

  it('installs WebKit when --all flag is passed', async () => {
    await runWarmup(['--all']);

    const calls = vi.mocked(runCommand).mock.calls;
    const webkitCall = calls.find(hasWebkitInstall);
    expect(webkitCall).toBeDefined();
  });

  it('reports failure when WebKit install fails', async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args.includes('webkit')) {
        return failWith('webkit installation error');
      }
      return ok;
    });

    const result = await runWarmup(['--webkit']);
    expect(result.webkit).toBe('failed');
    expect(result.webkitError).toContain('webkit installation error');
  });

  it('installs both Firefox and WebKit when both flags are passed', async () => {
    const result = await runWarmup(['--firefox', '--webkit']);

    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls.find(hasFirefoxInstall)).toBeDefined();
    expect(calls.find(hasWebkitInstall)).toBeDefined();
    expect(result.firefox).toBe('ok');
    expect(result.webkit).toBe('ok');
  });

  it('summary output includes Firefox status when installed', async () => {
    let output = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    await runWarmup(['--firefox', '--plain']);

    expect(output).toContain('Firefox');
    vi.restoreAllMocks();
  });

  it('summary output includes WebKit status when installed', async () => {
    let output = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    await runWarmup(['--webkit', '--plain']);

    expect(output).toContain('WebKit');
    vi.restoreAllMocks();
  });

  it('--firefox does not interfere with --reranker', async () => {
    const result = await runWarmup(['--firefox', '--reranker']);

    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls.find(hasFirefoxInstall)).toBeDefined();
    expect(result.firefox).toBe('ok');
    expect(result.reranker).toBe('ok');
  });

  it('handles --force combined with --firefox', async () => {
    const result = await runWarmup(['--force', '--firefox']);
    expect(result.firefox).toBe('ok');
  });

  it('timeout on Firefox install reports failure', async () => {
    vi.mocked(runCommand).mockImplementation(async (_cmd, args) => {
      if (args.includes('firefox')) {
        return { code: -1, stdout: '', stderr: 'TIMEOUT', timedOut: true };
      }
      return ok;
    });

    const result = await runWarmup(['--firefox']);
    expect(result.firefox).toBe('failed');
  });

  it('installs Firefox via the bundled Playwright CLI, not bare npx', async () => {
    // WHY (GH #116): install must use the bundled cli.js so the revision
    // matches what doctor/runtime resolve.
    await runWarmup(['--firefox']);

    const calls = vi.mocked(runCommand).mock.calls;
    const firefoxCall = calls.find((c) => (c[1] as string[]).includes('firefox'));
    expect(firefoxCall).toBeDefined();
    expect(firefoxCall?.[0]).toBe(process.execPath);
    expect((firefoxCall?.[1] as string[])[0]).toMatch(/node_modules[\\/]playwright[\\/]cli\.js$/);
  });

  it('reports Firefox FAILED when install exits 0 but the binary is missing on disk', async () => {
    // WHY (GH #116): honest per-browser status. A clean exit is not enough —
    // the binary must exist on disk (doctor's parity probe), else report fail.
    vi.mocked(runCommand).mockResolvedValue(ok);
    // chromium present so the gating browser passes; firefox missing on disk.
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p).includes('firefox') ? false : true,
    );

    const result = await runWarmup(['--firefox']);

    expect(result.firefox).toBe('failed');
    expect(result.firefoxError).toContain('missing on disk');
    // chromium (gating browser) must still report ok independently.
    expect(result.playwright).toBe('ok');
    // sanity: the probe used the bundled executablePath() APIs.
    expect(vi.mocked(firefox.executablePath)).toHaveBeenCalled();
    expect(vi.mocked(chromium.executablePath)).toHaveBeenCalled();
  });
});
