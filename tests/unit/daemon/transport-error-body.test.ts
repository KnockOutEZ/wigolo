import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resetConfig } from '../../../src/config.js';

/**
 * SD-409 (b) — the same claim SD-406 pinned for the broker route, for the four arms it did not reach:
 * the two MCP transports, the SSE message pump, and `/health`.
 *
 * All four caught a throw and wrote `String(err)` into the response. The messages that reach them are
 * written by the storage layer, the transport SDK and the browser engine, and they name absolute file
 * paths ("unable to open database file: /Users/…/.wigolo/cache.db"), ports and session identifiers. All
 * four answer a caller the daemon has not authenticated — the MCP transports and `/health` are open on
 * loopback — so an ordinary 500 was a disclosure of where the machine keeps its data.
 *
 * The two halves are one claim and are asserted together, exactly as in `companion-broker-error-body`:
 * dropping the detail from the WIRE is only correct if the operator can still read it in the LOG. A test
 * that checked the body alone would stay green if someone deleted the log line too.
 */
const THROWN = 'unable to open database file: /Users/secretname/.wigolo/cache.db';

vi.mock('../../../src/daemon/health-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/daemon/health-check.js')>();
  return {
    ...actual,
    probeHealth: vi.fn(() => {
      throw new Error(THROWN);
    }),
  };
});

describe('daemon transport + health arms — unexpected failures', () => {
  const originalEnv = process.env;
  let dataDir: string;
  let stderr: string[];
  let restoreStderr: () => void;
  let daemon: any;
  let url: string;

  /** The structured records the daemon wrote under one message, parsed off its own stderr. */
  function records(msg: string): Array<{ level: string; data?: { error?: string } }> {
    return stderr
      .join('')
      .split('\n')
      .filter((line) => line.includes(msg))
      .map((line) => JSON.parse(line) as { level: string; data?: { error?: string } });
  }

  /** Every field of the body is searched: a leak could ride any one of them. */
  function expectNoLeak(body: unknown): void {
    const wire = JSON.stringify(body);
    expect(wire).not.toContain(THROWN);
    expect(wire).not.toContain('/Users/secretname');
    expect(wire).not.toContain('cache.db');
  }

  async function startDaemon(options: Record<string, unknown>): Promise<void> {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', ...options });
    url = await daemon.start();
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'wigolo-transport-500-'));
    // `error`, and json: the level is read when the module builds its logger, so the log half of these
    // tests only has a chance to observe anything if the arms' own level is enabled from the first import.
    process.env = { ...originalEnv, WIGOLO_DATA_DIR: dataDir, LOG_LEVEL: 'error', LOG_FORMAT: 'json' };
    resetConfig();

    stderr = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write);
    restoreStderr = () => spy.mockRestore();
  });

  afterEach(async () => {
    if (daemon) await daemon.stop();
    daemon = undefined;
    restoreStderr();
    resetConfig();
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('/health', () => {
    it('answers a fixed reason and keeps the storage-layer message off the wire', async () => {
      await startDaemon({});

      const resp = await fetch(`${url}/health`);
      const body = await resp.json();

      expect(resp.status).toBe(500);
      // Spelled out rather than imported: the fixed string is the thing under test, so an assertion that
      // read the constant would agree with any future rewording, including one that put the path back.
      expect(body).toEqual({
        status: 'down',
        error: 'The health check could not complete. The daemon log has the detail.',
      });
      expectNoLeak(body);
    });

    it('keeps the real message in the daemon log, where the operator can read it', async () => {
      await startDaemon({});
      await fetch(`${url}/health`);

      const logged = records('Health check failed');
      expect(logged).toHaveLength(1);
      expect(logged[0].level).toBe('error');
      expect(logged[0].data?.error).toBe(`Error: ${THROWN}`);
    });
  });

  /**
   * The transports are driven in companion-hosted mode with a factory that throws: it is the one
   * dependency both arms take INSIDE their try, so it reaches the catch without the test having to
   * reach into the SDK. It also keeps `../server.js` and the native cache out of these two cases.
   */
  describe('MCP transports', () => {
    const throwingFactory = () => {
      throw new Error(THROWN);
    };

    it('answers a fixed reason on the streamable-HTTP POST arm and logs the detail', async () => {
      await startDaemon({ mcpServerFactory: throwingFactory });

      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
        }),
      });
      const body = await resp.json();

      expect(resp.status).toBe(500);
      expect(body).toEqual({
        error: 'The MCP transport could not complete this request. The daemon log has the detail.',
      });
      expectNoLeak(body);

      const logged = records('StreamableHTTP request failed');
      expect(logged).toHaveLength(1);
      expect(logged[0].data?.error).toBe(`Error: ${THROWN}`);
    });

    it('answers a fixed reason on the SSE connect arm and logs the detail', async () => {
      await startDaemon({ mcpServerFactory: throwingFactory });

      const resp = await fetch(`${url}/sse`);
      const body = await resp.json();

      expect(resp.status).toBe(500);
      expect(body).toEqual({
        error: 'The MCP transport could not complete this request. The daemon log has the detail.',
      });
      expectNoLeak(body);

      const logged = records('SSE connection failed');
      expect(logged).toHaveLength(1);
      expect(logged[0].data?.error).toBe(`Error: ${THROWN}`);
    });

    it('answers a fixed reason on the SSE message arm and logs the detail', async () => {
      // A working factory: this arm is reached only for a session that already exists, and the throw
      // under test belongs to the transport's own pump, which is stubbed here for the same reason
      // SD-406 stubbed `executeBrokerOp` — the arm is what is being tested, not the way in.
      await startDaemon({ mcpServerFactory: () => ({ connect: async () => {} }) });
      daemon.sseSessions.set('session-409', {
        transport: {
          handlePostMessage: () => {
            throw new Error(THROWN);
          },
        },
        server: {},
      });

      const resp = await fetch(`${url}/messages?sessionId=session-409`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      const body = await resp.json();

      expect(resp.status).toBe(500);
      expect(body).toEqual({
        error: 'The MCP transport could not complete this request. The daemon log has the detail.',
      });
      expectNoLeak(body);

      const logged = records('SSE message handling failed');
      expect(logged).toHaveLength(1);
      expect(logged[0].data?.error).toBe(`Error: ${THROWN}`);
    });
  });
});
