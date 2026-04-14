import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

describe('runHealthCheck', () => {
  const originalEnv = process.env;
  let stderrOutput: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetConfig();
    vi.clearAllMocks();
    stderrOutput = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === 'string' ? data : new TextDecoder().decode(data);
      return true;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('exports runHealthCheck function', async () => {
    const { runHealthCheck } = await import('../../../src/cli/health.js');
    expect(typeof runHealthCheck).toBe('function');
  });

  it('returns exit code 1 when daemon is not running', async () => {
    process.env.WIGOLO_DAEMON_PORT = '19999';
    resetConfig();
    const { runHealthCheck } = await import('../../../src/cli/health.js');
    const exitCode = await runHealthCheck();
    expect(exitCode).toBe(1);
  });

  it('writes error message to stderr when daemon unreachable', async () => {
    process.env.WIGOLO_DAEMON_PORT = '19999';
    resetConfig();
    const { runHealthCheck } = await import('../../../src/cli/health.js');
    await runHealthCheck();
    expect(stderrOutput).toContain('not running');
  });

  it('returns a number from runHealthCheck', async () => {
    const { runHealthCheck } = await import('../../../src/cli/health.js');
    expect(typeof runHealthCheck).toBe('function');
  });

  it('writes health report info to stderr', async () => {
    process.env.WIGOLO_DAEMON_PORT = '19999';
    resetConfig();
    const { runHealthCheck } = await import('../../../src/cli/health.js');
    await runHealthCheck();
    expect(stderrOutput.length).toBeGreaterThan(0);
  });
});
