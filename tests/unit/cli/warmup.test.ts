import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  checkPythonAvailable: vi.fn(),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn(),
}));

vi.mock('../../../src/config.js', () => ({
  getConfig: vi.fn(() => ({ dataDir: '/tmp/test-wigolo' })),
}));

vi.mock('../../../src/search/flashrank.js', () => ({
  isFlashRankAvailable: vi.fn(),
  resetAvailabilityCache: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { runWarmup } from '../../../src/cli/warmup.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../../../src/searxng/bootstrap.js';
import { isFlashRankAvailable, resetAvailabilityCache } from '../../../src/search/flashrank.js';

describe('runWarmup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
  });

  it('installs Playwright chromium', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(execSync).toHaveBeenCalledWith(
      'npx playwright install chromium',
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(result.playwright).toBe('ok');
  });

  it('reports playwright failure without throwing', async () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('install failed');
    });
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup();

    expect(result.playwright).toBe('failed');
    expect(result.playwrightError).toBe('install failed');
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
});

describe('runWarmup with flags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
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

  it('installs trafilatura when --trafilatura flag is passed', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    const result = await runWarmup(['--trafilatura']);

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('pip'),
      expect.objectContaining({ timeout: 120000 }),
    );
    // The call list should include both playwright install and pip install
    const calls = vi.mocked(execSync).mock.calls;
    const pipCall = calls.find((c) => String(c[0]).includes('trafilatura'));
    expect(pipCall).toBeDefined();
  });

  it('installs trafilatura when --all flag is passed', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    await runWarmup(['--all']);

    const calls = vi.mocked(execSync).mock.calls;
    const pipCall = calls.find((c) => String(c[0]).includes('trafilatura'));
    expect(pipCall).toBeDefined();
  });

  it('does not install trafilatura when no flag is passed', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    await runWarmup([]);

    const calls = vi.mocked(execSync).mock.calls;
    const pipCall = calls.find((c) => String(c[0]).includes('trafilatura'));
    expect(pipCall).toBeUndefined();
  });

  it('handles trafilatura install failure gracefully', async () => {
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });

    // First call succeeds (playwright), second call fails (pip install trafilatura)
    let callCount = 0;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      callCount++;
      if (String(cmd).includes('trafilatura')) {
        throw new Error('pip install failed: network error');
      }
      return Buffer.from('');
    });

    // Should not throw -- warmup continues despite trafilatura install failure
    const result = await runWarmup(['--trafilatura']);
    expect(result.playwright).toBe('ok');
  });
});

describe('warmup --reranker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execSync).mockReturnValue(Buffer.from(''));
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
  });

  it('installs FlashRank Python package when --reranker passed', async () => {
    const result = await runWarmup(['--reranker']);

    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('pip'),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(result.reranker).toBe('ok');
  });

  it('--all flag includes reranker installation', async () => {
    const result = await runWarmup(['--all']);

    const pipCalls = vi.mocked(execSync).mock.calls.filter(
      (call) => String(call[0]).includes('pip') && String(call[0]).includes('flashrank'),
    );
    expect(pipCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.reranker).toBe('ok');
  });

  it('reports failure when pip install fails', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('flashrank')) {
        throw new Error('pip install failed: network error');
      }
      return Buffer.from('');
    });

    const result = await runWarmup(['--reranker']);

    expect(result.reranker).toBe('failed');
    expect(result.rerankerError).toContain('pip install failed');
  });

  it('does not install reranker when flag not passed', async () => {
    const result = await runWarmup([]);

    const pipCalls = vi.mocked(execSync).mock.calls.filter(
      (call) => String(call[0]).includes('flashrank'),
    );
    expect(pipCalls).toHaveLength(0);
    expect(result.reranker).toBeUndefined();
  });

  it('verifies FlashRank availability after install', async () => {
    vi.mocked(isFlashRankAvailable).mockResolvedValue(true);

    await runWarmup(['--reranker']);

    expect(resetAvailabilityCache).toHaveBeenCalled();
  });

  it('reports failure when python3 not found for reranker install', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('python3')) {
        throw new Error('ENOENT: python3 not found');
      }
      return Buffer.from('');
    });

    const result = await runWarmup(['--reranker']);

    expect(result.reranker).toBe('failed');
  });
});
