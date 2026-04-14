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
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
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

import { execSync } from 'node:child_process';
import { runWarmup } from '../../../src/cli/warmup.js';

describe('warmup --firefox flag', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });
  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
  });

  it('installs Firefox when --firefox flag is passed', async () => {
    const result = await runWarmup(['--firefox']);

    const calls = vi.mocked(execSync).mock.calls;
    const firefoxCall = calls.find(c => String(c[0]).includes('playwright install firefox'));
    expect(firefoxCall).toBeDefined();
    expect(result.firefox).toBe('ok');
  });

  it('does not install Firefox without --firefox flag', async () => {
    const result = await runWarmup([]);

    const calls = vi.mocked(execSync).mock.calls;
    const firefoxCall = calls.find(c => String(c[0]).includes('playwright install firefox'));
    expect(firefoxCall).toBeUndefined();
    expect(result.firefox).toBeUndefined();
  });

  it('installs Firefox when --all flag is passed', async () => {
    const result = await runWarmup(['--all']);

    const calls = vi.mocked(execSync).mock.calls;
    const firefoxCall = calls.find(c => String(c[0]).includes('playwright install firefox'));
    expect(firefoxCall).toBeDefined();
    expect(result.firefox).toBe('ok');
  });

  it('reports failure when Firefox install fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd) => {
      if (String(cmd).includes('firefox')) {
        throw new Error('Host system is missing dependencies to run Firefox');
      }
      return Buffer.from('');
    });

    const result = await runWarmup(['--firefox']);
    expect(result.firefox).toBe('failed');
    expect(result.firefoxError).toContain('missing dependencies');
  });

  it('installs WebKit when --webkit flag is passed', async () => {
    const result = await runWarmup(['--webkit']);

    const calls = vi.mocked(execSync).mock.calls;
    const webkitCall = calls.find(c => String(c[0]).includes('playwright install webkit'));
    expect(webkitCall).toBeDefined();
    expect(result.webkit).toBe('ok');
  });

  it('does not install WebKit without --webkit flag', async () => {
    const result = await runWarmup([]);

    const calls = vi.mocked(execSync).mock.calls;
    const webkitCall = calls.find(c => String(c[0]).includes('playwright install webkit'));
    expect(webkitCall).toBeUndefined();
    expect(result.webkit).toBeUndefined();
  });

  it('installs WebKit when --all flag is passed', async () => {
    const result = await runWarmup(['--all']);

    const calls = vi.mocked(execSync).mock.calls;
    const webkitCall = calls.find(c => String(c[0]).includes('playwright install webkit'));
    expect(webkitCall).toBeDefined();
  });

  it('reports failure when WebKit install fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd) => {
      if (String(cmd).includes('webkit')) {
        throw new Error('webkit installation error');
      }
      return Buffer.from('');
    });

    const result = await runWarmup(['--webkit']);
    expect(result.webkit).toBe('failed');
    expect(result.webkitError).toContain('webkit installation error');
  });

  it('installs both Firefox and WebKit when both flags are passed', async () => {
    const result = await runWarmup(['--firefox', '--webkit']);

    const calls = vi.mocked(execSync).mock.calls;
    const firefoxCall = calls.find(c => String(c[0]).includes('playwright install firefox'));
    const webkitCall = calls.find(c => String(c[0]).includes('playwright install webkit'));
    expect(firefoxCall).toBeDefined();
    expect(webkitCall).toBeDefined();
    expect(result.firefox).toBe('ok');
    expect(result.webkit).toBe('ok');
  });

  it('summary output includes Firefox status when installed', async () => {
    let output = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    await runWarmup(['--firefox']);

    expect(output).toContain('Firefox');
    vi.restoreAllMocks();
  });

  it('summary output includes WebKit status when installed', async () => {
    let output = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });

    await runWarmup(['--webkit']);

    expect(output).toContain('WebKit');
    vi.restoreAllMocks();
  });

  it('--firefox does not interfere with --reranker', async () => {
    const result = await runWarmup(['--firefox', '--reranker']);

    const calls = vi.mocked(execSync).mock.calls;
    const firefoxCall = calls.find(c => String(c[0]).includes('playwright install firefox'));
    const flashrankCall = calls.find(c => String(c[0]).includes('flashrank'));
    expect(firefoxCall).toBeDefined();
    expect(flashrankCall).toBeDefined();
    expect(result.firefox).toBe('ok');
    expect(result.reranker).toBe('ok');
  });

  it('--firefox does not interfere with --trafilatura', async () => {
    const result = await runWarmup(['--firefox', '--trafilatura']);

    const calls = vi.mocked(execSync).mock.calls;
    const firefoxCall = calls.find(c => String(c[0]).includes('playwright install firefox'));
    const trafCall = calls.find(c => String(c[0]).includes('trafilatura'));
    expect(firefoxCall).toBeDefined();
    expect(trafCall).toBeDefined();
    expect(result.firefox).toBe('ok');
    expect(result.trafilatura).toBe('ok');
  });

  it('handles --force combined with --firefox', async () => {
    const result = await runWarmup(['--force', '--firefox']);
    expect(result.firefox).toBe('ok');
  });

  it('timeout on Firefox install reports failure', async () => {
    vi.mocked(execSync).mockImplementation((cmd) => {
      if (String(cmd).includes('firefox')) {
        const error = new Error('TIMEOUT');
        (error as any).killed = true;
        throw error;
      }
      return Buffer.from('');
    });

    const result = await runWarmup(['--firefox']);
    expect(result.firefox).toBe('failed');
  });
});
