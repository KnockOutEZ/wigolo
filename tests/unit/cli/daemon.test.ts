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
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
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

  it('parses --allow-unauthenticated', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    expect(parseDaemonArgs([]).allowUnauthenticated).toBe(false);
    expect(parseDaemonArgs(['--allow-unauthenticated']).allowUnauthenticated).toBe(true);
  });

  it('honors WIGOLO_SERVE_ALLOW_UNAUTHENTICATED=1 for the override', async () => {
    process.env.WIGOLO_SERVE_ALLOW_UNAUTHENTICATED = '1';
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    expect(parseDaemonArgs([]).allowUnauthenticated).toBe(true);
    delete process.env.WIGOLO_SERVE_ALLOW_UNAUTHENTICATED;
  });
});

describe('checkServeBindGate (fail-closed bind matrix)', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
  });
  afterEach(() => { process.env = originalEnv; });

  it('non-loopback bind + no token + no override → refuses, message names WIGOLO_API_TOKEN + override', async () => {
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    const r = checkServeBindGate({ host: '0.0.0.0', port: 3333, allowUnauthenticated: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('WIGOLO_API_TOKEN');
    expect(r.message).toContain('--allow-unauthenticated');
  });

  it('loopback bind + no token → starts', async () => {
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    expect(checkServeBindGate({ host: '127.0.0.1', port: 3333, allowUnauthenticated: false }).ok).toBe(true);
  });

  it('non-loopback bind + token → starts (and returns the token)', async () => {
    process.env.WIGOLO_API_TOKEN = 'secret';
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    const r = checkServeBindGate({ host: '0.0.0.0', port: 3333, allowUnauthenticated: false });
    expect(r.ok).toBe(true);
    expect(r.token).toBe('secret');
  });

  it('non-loopback bind + override → starts', async () => {
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    expect(checkServeBindGate({ host: '0.0.0.0', port: 3333, allowUnauthenticated: true }).ok).toBe(true);
  });

  it('empty WIGOLO_API_TOKEN = unconfigured (non-loopback refuses)', async () => {
    process.env.WIGOLO_API_TOKEN = '   ';
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    expect(checkServeBindGate({ host: '0.0.0.0', port: 3333, allowUnauthenticated: false }).ok).toBe(false);
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

describe('serve license notice', () => {
  // WHY: a daemon serving other machines is where commercial use happens, so
  // the operator gets one stderr line pointing at the commercial terms. A local
  // dev bind or the MCP stdio path is not that situation and stays quiet — the
  // line must not read as a warning to people it does not apply to.
  const originalEnv = process.env;
  let stderrOutput: string;
  const noticeLines = () => stderrOutput.split('\n').filter((l) => /AGPL/.test(l));

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
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

  it('formatServeLicenseNotice is null for every loopback spelling', async () => {
    const { formatServeLicenseNotice } = await import('../../../src/cli/daemon.js');
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      expect(formatServeLicenseNotice(host)).toBeNull();
    }
  });

  it('formatServeLicenseNotice is one line naming AGPL and LICENSING.md for a non-loopback host', async () => {
    const { formatServeLicenseNotice } = await import('../../../src/cli/daemon.js');
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'example.internal']) {
      const notice = formatServeLicenseNotice(host);
      expect(notice).not.toBeNull();
      expect(notice).not.toContain('\n');
      expect(notice).toContain('AGPL');
      expect(notice).toContain('LICENSING.md');
    }
  });

  it('runDaemon prints the notice exactly once after binding a non-loopback host', async () => {
    process.env.WIGOLO_API_TOKEN = 'secret';
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '0.0.0.0']);
    await vi.waitFor(() => expect(stderrOutput).toContain('Press Ctrl+C to stop.'));
    expect(noticeLines()).toHaveLength(1);
    expect(noticeLines()[0]).toMatch(/^\[wigolo serve\] /);
  });

  it('runDaemon prints no notice on a loopback bind', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '127.0.0.1']);
    await vi.waitFor(() => expect(stderrOutput).toContain('Press Ctrl+C to stop.'));
    expect(noticeLines()).toEqual([]);
  });
});
