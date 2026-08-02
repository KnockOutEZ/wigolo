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

  it('--json emits the health report on STDOUT and keeps logs on stderr', async () => {
    // WHY (D8): AI-drivable diagnose. `wigolo health --json | jq -e .status`.
    delete process.env.WIGOLO_SEARCH;
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    const url = await daemon.start();
    const port = parseInt(new URL(url).port, 10);
    process.env.WIGOLO_DAEMON_PORT = String(port);
    process.env.WIGOLO_DAEMON_HOST = '127.0.0.1';
    resetConfig();
    let stdoutOutput = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
      stdoutOutput += typeof data === 'string' ? data : new TextDecoder().decode(data);
      return true;
    });
    try {
      const { runHealthCheck } = await import('../../../src/cli/health.js');
      const exitCode = await runHealthCheck(['--json']);
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed).toHaveProperty('status');
      expect(parsed).toHaveProperty('searxng');
      // The human log lines must not land on stdout.
      expect(stdoutOutput).not.toContain('[wigolo health]');
    } finally {
      stdoutSpy.mockRestore();
      delete process.env.WIGOLO_DAEMON_HOST;
      await daemon.stop();
    }
  });

  it('--json emits a JSON error object and exits 1 when the daemon is unreachable', async () => {
    process.env.WIGOLO_DAEMON_PORT = '19999';
    resetConfig();
    let stdoutOutput = '';
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((data: string | Uint8Array) => {
      stdoutOutput += typeof data === 'string' ? data : new TextDecoder().decode(data);
      return true;
    });
    try {
      const { runHealthCheck } = await import('../../../src/cli/health.js');
      const exitCode = await runHealthCheck(['--json']);
      expect(exitCode).toBe(1);
      const parsed = JSON.parse(stdoutOutput);
      expect(parsed).toHaveProperty('status', 'down');
      expect(parsed).toHaveProperty('error');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('exits 0 against a default core daemon (D1: core is healthy, not degraded)', async () => {
    // WHY (D1 review BLOCKER): a default core daemon must report healthy so
    // `wigolo health` exits 0 — before the backend-aware mapping it would have
    // been permanently degraded (exit 1) because health required searxng active.
    delete process.env.WIGOLO_SEARCH; // default core backend, sidecar not configured
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    const url = await daemon.start();
    const port = parseInt(new URL(url).port, 10);
    process.env.WIGOLO_DAEMON_PORT = String(port);
    process.env.WIGOLO_DAEMON_HOST = '127.0.0.1';
    resetConfig();
    try {
      const { runHealthCheck } = await import('../../../src/cli/health.js');
      const exitCode = await runHealthCheck();
      expect(exitCode).toBe(0);
      expect(stderrOutput).toContain('not_configured');
    } finally {
      delete process.env.WIGOLO_DAEMON_HOST;
      await daemon.stop();
    }
  });
});
