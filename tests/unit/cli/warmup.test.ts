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
import { runWarmup, type WarmupResult } from '../../../src/cli/warmup.js';
import { checkPythonAvailable, bootstrapNativeSearxng, getBootstrapState } from '../../../src/searxng/bootstrap.js';

describe('runWarmup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
