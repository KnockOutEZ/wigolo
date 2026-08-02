import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('defaults allowRemote to false and parses --allow-remote', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    expect(parseDaemonArgs([]).allowRemote).toBe(false);
    expect(parseDaemonArgs(['--allow-remote']).allowRemote).toBe(true);
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

  // P6-d finding 2: the prominent remote-exposure WARNING must key off the NON-LOOPBACK BIND,
  // not off token provenance. An operator-supplied token on a 0.0.0.0 bind is just as remotely
  // reachable, so the operator must still be warned.
  it('emits the remote-exposure WARNING on a non-loopback bind even with an OPERATOR token', async () => {
    process.env.WIGOLO_API_TOKEN = 'pinned-operator-token';
    resetConfig();
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '0.0.0.0', '--allow-remote']);
    expect(stderrOutput).toMatch(/WARNING[\s\S]*non-loopback/i);
  });

  // Guard the other side: a loopback bind never emits the remote-exposure WARNING (keyed off
  // non-loopback, NOT "always warn").
  it('does NOT emit the remote-exposure WARNING on a loopback bind with an operator token', async () => {
    process.env.WIGOLO_API_TOKEN = 'pinned-operator-token';
    resetConfig();
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '127.0.0.1']);
    expect(stderrOutput).not.toMatch(/WARNING/i);
  });
});

// Remote exposure needs EXPLICIT operator intent, independent of the token gate. Binding to
// 0.0.0.0 by accident must never silently expose the daemon (audit S3).
describe('checkServeRemoteIntent (explicit remote intent)', () => {
  it('loopback bind → ok, not flagged remote', async () => {
    const { checkServeRemoteIntent } = await import('../../../src/cli/daemon.js');
    const r = checkServeRemoteIntent({ host: '127.0.0.1', port: 3333, allowRemote: false, allowUnauthenticated: false });
    expect(r.ok).toBe(true);
    expect(r.remote).toBe(false);
  });

  it('non-loopback WITHOUT --allow-remote → refused, message names --allow-remote', async () => {
    const { checkServeRemoteIntent } = await import('../../../src/cli/daemon.js');
    const r = checkServeRemoteIntent({ host: '0.0.0.0', port: 3333, allowRemote: false, allowUnauthenticated: false });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/allow-remote/i);
  });

  it('non-loopback WITH --allow-remote → ok and flagged remote (so the caller warns)', async () => {
    const { checkServeRemoteIntent } = await import('../../../src/cli/daemon.js');
    const r = checkServeRemoteIntent({ host: '0.0.0.0', port: 3333, allowRemote: true, allowUnauthenticated: false });
    expect(r.ok).toBe(true);
    expect(r.remote).toBe(true);
  });
});

// Startup is fail-closed on remote exposure, and a refusal never leaks a token to stderr
// (terminal/shell-log scrollback is a leak surface). Both fail-closed checks run before the
// server binds, so an under-protected daemon is never reachable even briefly.
describe('runDaemon — fail-closed remote startup (no token leak)', () => {
  const originalEnv = process.env;
  let stderrOutput: string;
  const exitCalls: number[] = [];

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    delete process.env.WIGOLO_SERVE_ALLOW_UNAUTHENTICATED;
    resetConfig();
    vi.clearAllMocks();
    stderrOutput = '';
    exitCalls.length = 0;
    vi.spyOn(process.stderr, 'write').mockImplementation((data: string | Uint8Array) => {
      stderrOutput += typeof data === 'string' ? data : new TextDecoder().decode(data);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null): never => {
      exitCalls.push(typeof code === 'number' ? code : 0);
      throw new Error(`process.exit(${code})`);
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    resetConfig();
    vi.restoreAllMocks();
  });

  it('refuses a non-loopback bind without --allow-remote (intent gate, before the token gate)', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(() => runDaemon(['--host', '0.0.0.0'])).toThrow(/process\.exit/);
    expect(exitCalls).toContain(1);
    expect(stderrOutput).toMatch(/allow-remote/i);
  });

  it('refuses a non-loopback bind with --allow-remote but NO token and no override, and prints no token', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(() => runDaemon(['--host', '0.0.0.0', '--allow-remote'])).toThrow(/process\.exit/);
    expect(exitCalls).toContain(1);
    expect(stderrOutput).toContain('WIGOLO_API_TOKEN');
    // No token-shaped secret is ever echoed, even on the refusal path.
    expect(stderrOutput).not.toMatch(/bearer token[^\n]*: \S{20,}/i);
  });

  it('loopback default starts with no token configured (back-compat, no refusal)', async () => {
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    expect(() => runDaemon(['--host', '127.0.0.1'])).not.toThrow();
    expect(exitCalls).toHaveLength(0);
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
    const r = checkServeBindGate({ host: '0.0.0.0', port: 3333, allowRemote: true, allowUnauthenticated: false });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('WIGOLO_API_TOKEN');
    expect(r.message).toContain('--allow-unauthenticated');
  });

  it('loopback bind + no token → starts', async () => {
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    expect(checkServeBindGate({ host: '127.0.0.1', port: 3333, allowRemote: false, allowUnauthenticated: false }).ok).toBe(true);
  });

  it('non-loopback bind + token → starts (and returns the token)', async () => {
    process.env.WIGOLO_API_TOKEN = 'secret';
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    const r = checkServeBindGate({ host: '0.0.0.0', port: 3333, allowRemote: true, allowUnauthenticated: false });
    expect(r.ok).toBe(true);
    expect(r.token).toBe('secret');
  });

  it('non-loopback bind + override → starts', async () => {
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    expect(checkServeBindGate({ host: '0.0.0.0', port: 3333, allowRemote: true, allowUnauthenticated: true }).ok).toBe(true);
  });

  it('empty WIGOLO_API_TOKEN = unconfigured (non-loopback refuses)', async () => {
    process.env.WIGOLO_API_TOKEN = '   ';
    const { checkServeBindGate } = await import('../../../src/cli/daemon.js');
    expect(checkServeBindGate({ host: '0.0.0.0', port: 3333, allowRemote: true, allowUnauthenticated: false }).ok).toBe(false);
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
