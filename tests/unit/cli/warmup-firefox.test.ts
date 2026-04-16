import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/cli/tui/run-command.js', () => ({
  runCommand: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockImplementation((p) => String(p).endsWith('lightpanda')),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    createWriteStream: vi.fn(),
    chmodSync: vi.fn(),
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn().mockReturnValue(false),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/search/flashrank.js', () => ({
  resetAvailabilityCache: vi.fn(),
}));

import { runCommand } from '../../../src/cli/tui/run-command.js';
import { runWarmup } from '../../../src/cli/warmup.js';

const ok = { code: 0, stdout: '', stderr: '', timedOut: false };
const failWith = (msg: string) => ({ code: 1, stdout: '', stderr: msg, timedOut: false });

const argsOf = (call: unknown[]): string[] => (call[1] as string[]) ?? [];
const includesArg = (call: unknown[], needle: string): boolean =>
  argsOf(call).some((a) => String(a).includes(needle));
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
    expect(calls.find((c) => includesArg(c, 'flashrank'))).toBeDefined();
    expect(result.firefox).toBe('ok');
    expect(result.reranker).toBe('ok');
  });

  it('--firefox does not interfere with --trafilatura', async () => {
    const result = await runWarmup(['--firefox', '--trafilatura']);

    const calls = vi.mocked(runCommand).mock.calls;
    expect(calls.find(hasFirefoxInstall)).toBeDefined();
    expect(calls.find((c) => includesArg(c, 'trafilatura'))).toBeDefined();
    expect(result.firefox).toBe('ok');
    expect(result.trafilatura).toBe('ok');
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
});
