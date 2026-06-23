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

  it('defaults allowRemote to false and parses --allow-remote', async () => {
    const { parseDaemonArgs } = await import('../../../src/cli/daemon.js');
    expect(parseDaemonArgs([]).allowRemote).toBe(false);
    expect(parseDaemonArgs(['--allow-remote']).allowRemote).toBe(true);
  });

  // P6-d finding 2: the prominent remote-exposure WARNING must key off the NON-LOOPBACK bind,
  // not off token minting. An operator-supplied token (minted:false) on a 0.0.0.0 bind is just
  // as remotely reachable, so the operator must still be warned.
  it('emits the remote-exposure WARNING on a non-loopback bind even with an OPERATOR token (not minted-gated)', async () => {
    process.env.WIGOLO_STUDIO_TOKEN = 'pinned-operator-token';
    resetConfig();
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '0.0.0.0', '--allow-remote']); // operator token → minted:false
    expect(stderrOutput).toMatch(/WARNING[\s\S]*non-loopback/i);
  });

  // Guard the other side: a loopback bind never emits the remote-exposure WARNING (keyed off
  // non-loopback, NOT "always warn"). Holds before and after the fix.
  it('does NOT emit the remote-exposure WARNING on a loopback bind with an operator token', async () => {
    process.env.WIGOLO_STUDIO_TOKEN = 'pinned-operator-token';
    resetConfig();
    const { runDaemon } = await import('../../../src/cli/daemon.js');
    runDaemon(['--host', '127.0.0.1']);
    expect(stderrOutput).not.toMatch(/WARNING/i);
  });
});

describe('buildServeAuth (audit S3 closure)', () => {
  it('loopback + no token → no auth required (back-compat)', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    expect(buildServeAuth({ host: '127.0.0.1', allowRemote: false, configuredToken: null })).toEqual({
      ok: true,
      auth: undefined,
      minted: false,
      remote: false,
    });
  });

  it('loopback + operator token → uses the supplied token', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    expect(buildServeAuth({ host: '127.0.0.1', allowRemote: false, configuredToken: 'pinned' })).toEqual({
      ok: true,
      auth: { token: 'pinned', host: '127.0.0.1' },
      minted: false,
      remote: false,
    });
  });

  it('non-loopback WITHOUT --allow-remote → refused', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    const d = buildServeAuth({ host: '0.0.0.0', allowRemote: false, configuredToken: null });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.message).toMatch(/allow-remote/i);
  });

  it('non-loopback + --allow-remote + no token → FORCES auth on (minted) — closes S3', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    const d = buildServeAuth({ host: '0.0.0.0', allowRemote: true, configuredToken: null });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.minted).toBe(true);
      expect(d.auth?.token).toHaveLength(43);
      expect(d.auth?.host).toBe('0.0.0.0');
    }
  });

  it('non-loopback + --allow-remote + operator token → forces auth with that (stable) token', async () => {
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    expect(buildServeAuth({ host: '0.0.0.0', allowRemote: true, configuredToken: 'pinned' })).toEqual({
      ok: true,
      auth: { token: 'pinned', host: '0.0.0.0' },
      minted: false,
      remote: true,
    });
  });
});
