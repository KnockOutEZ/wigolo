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

import { execSync } from 'node:child_process';
import { runWarmup } from '../../../src/cli/warmup.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../../../src/searxng/bootstrap.js';

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
