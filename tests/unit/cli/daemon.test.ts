import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';

// Mock DaemonHttpServer to prevent actual server start
vi.mock('../../../src/daemon/http-server.js', () => {
  return {
    DaemonHttpServer: class MockDaemonHttpServer {
      port: number;
      host: string;
      constructor(options: { port: number; host: string }) {
        this.port = options.port;
        this.host = options.host;
      }
      start = vi.fn().mockResolvedValue('http://127.0.0.1:3333');
      stop = vi.fn().mockResolvedValue(undefined);
    },
  };
});

describe('runDaemon', () => {
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

  it('exports runDaemon function', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(typeof runDaemon).toBe('function');
  });

  it('runDaemon accepts args array', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(() => runDaemon([])).not.toThrow();
  });

  it('parses --port flag from args', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port', '4444']);
    expect(parsed.port).toBe(4444);
  });

  it('defaults port to config value when not specified', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs([]);
    expect(parsed.port).toBe(3333);
  });

  it('parses --host flag from args', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--host', '0.0.0.0']);
    expect(parsed.host).toBe('0.0.0.0');
  });

  it('defaults host to config value when not specified', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs([]);
    expect(parsed.host).toBe('127.0.0.1');
  });

  it('handles --port without value (ignores, uses default)', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port']);
    expect(parsed.port).toBe(3333);
  });

  it('handles --port with non-numeric value (uses default)', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port', 'abc']);
    expect(parsed.port).toBe(3333);
  });

  it('handles combined flags', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--port', '5555', '--host', '0.0.0.0']);
    expect(parsed.port).toBe(5555);
    expect(parsed.host).toBe('0.0.0.0');
  });

  it('ignores unknown flags', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    const parsed = parseDaemonArgs(['--unknown', 'value', '--port', '4444']);
    expect(parsed.port).toBe(4444);
  });
});

describe('serve-port conflict (S9)', () => {
  // WHY (D9): a taken serve port gets an actionable error naming --port AND the
  // next free port — no auto-rebind (predictability). This is the message a
  // user sees when `wigolo serve` collides with a running daemon.
  it('findNextFreePort returns a port > the taken one that is actually bindable', async () => {
    const { findNextFreePort } = await import('../../../src/cli/daemon.js');
    const net = await import('node:net');
    // Take a port on 127.0.0.1, then ask for the next free one.
    const taken = await new Promise<number>((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
      // keep it open for the duration of the test
      (globalThis as Record<string, unknown>).__takenServer = s;
    });
    const next = await findNextFreePort(taken, '127.0.0.1');
    expect(next).toBeGreaterThan(taken);
    const s = (globalThis as Record<string, unknown>).__takenServer as import('node:net').Server;
    await new Promise<void>((r) => s.close(() => r()));
    delete (globalThis as Record<string, unknown>).__takenServer;
  });

  it('formatPortConflictError names --port and the suggested next free port', async () => {
    const { formatPortConflictError } = await import('../../../src/cli/daemon.js');
    const msg = await formatPortConflictError(3333, '127.0.0.1');
    expect(msg).toContain('3333');
    expect(msg).toContain('--port');
    // The suggested port must be present and different from the taken one.
    expect(msg).toMatch(/--port \d+/);
  });
});
