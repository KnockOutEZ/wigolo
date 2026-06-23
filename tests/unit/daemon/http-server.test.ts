import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { resetConfig } from '../../../src/config.js';

vi.mock('../../../src/cache/db.js', () => ({
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../../src/fetch/browser-pool.js', () => {
  class MockMultiBrowserPool {
    shutdown = vi.fn().mockResolvedValue(undefined);
    fetchWithBrowser = vi.fn();
    getConfiguredTypes = vi.fn().mockReturnValue(['chromium']);
    getStats = vi.fn().mockReturnValue([]);
  }
  return {
    MultiBrowserPool: MockMultiBrowserPool,
    BrowserPool: class MockBrowserPool extends MockMultiBrowserPool {
      acquire = vi.fn();
      release = vi.fn();
    },
  };
});

vi.mock('../../../src/fetch/http-client.js', () => ({
  httpFetch: vi.fn(),
}));

vi.mock('../../../src/fetch/router.js', () => {
  return {
    SmartRouter: class MockSmartRouter {
      constructor(_httpClient: unknown, _browserPool: unknown) {}
      fetch = vi.fn();
      getDomainStats = vi.fn();
    },
  };
});

vi.mock('../../../src/searxng/bootstrap.js', () => ({
  resolveSearchBackend: vi.fn().mockResolvedValue({ type: 'scraping' }),
  bootstrapNativeSearxng: vi.fn(),
  getBootstrapState: vi.fn().mockReturnValue(null),
}));

vi.mock('../../../src/searxng/process.js', () => ({
  SearxngProcess: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
    getUrl: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('../../../src/searxng/docker.js', () => ({
  DockerSearxng: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(null),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

// P6-d PIN-1 (LOCKED-B): spy the credential-store reads (passthrough) so a guard pin can assert the
// serve dispatch never reaches them. Passthrough keeps every other test's behavior identical.
const { readKeySpy, resolveProviderKeySpy } = vi.hoisted(() => ({ readKeySpy: vi.fn(), resolveProviderKeySpy: vi.fn() }));
vi.mock('../../../src/security/key-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/security/key-store.js')>();
  return {
    ...actual,
    readKey: (...args: Parameters<typeof actual.readKey>) => { readKeySpy(...args); return actual.readKey(...args); },
    resolveProviderKey: (...args: Parameters<typeof actual.resolveProviderKey>) => { resolveProviderKeySpy(...args); return actual.resolveProviderKey(...args); },
  };
});

describe('DaemonHttpServer', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetConfig();
  });

  it('exports DaemonHttpServer class', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    expect(DaemonHttpServer).toBeDefined();
    expect(typeof DaemonHttpServer).toBe('function');
  });

  it('constructor accepts port and host', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 4444, host: '127.0.0.1' });
    expect(daemon).toBeDefined();
  });

  it('start() returns the listening URL', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await daemon.stop();
    }
  });

  it('responds to GET /health with JSON', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.status).toBeDefined();
      expect(['healthy', 'degraded', 'down']).toContain(body.status);
    } finally {
      await daemon.stop();
    }
  });

  it('responds to GET /health with correct content-type', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      expect(resp.headers.get('content-type')).toContain('application/json');
    } finally {
      await daemon.stop();
    }
  });

  it('responds to unknown paths with 404', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/nonexistent`);
      expect(resp.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });

  it('stop() shuts down cleanly', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    const url = await daemon.start();

    await daemon.stop();

    try {
      await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      expect(true).toBe(false);
    } catch {
      expect(true).toBe(true);
    }
  });

  it('stop() is idempotent', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    await daemon.start();

    await daemon.stop();
    await daemon.stop();
  });

  it('handles POST /mcp endpoint for MCP protocol', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      expect(resp.status).not.toBe(404);
    } finally {
      await daemon.stop();
    }
  });

  it('handles GET /sse endpoint for SSE transport', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const http = await import('node:http');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const parsedUrl = new URL(`${url}/sse`);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port,
          path: parsedUrl.pathname,
          headers: { 'Accept': 'text/event-stream' },
        }, (res) => {
          resolve(res.statusCode ?? 0);
          res.destroy();
        });
        req.on('error', reject);
        setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 3000);
      });
      expect(status).not.toBe(404);
    } finally {
      await daemon.stop();
    }
  });

  it('health endpoint includes searxng status', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      const body = await resp.json();
      expect(body).toHaveProperty('searxng');
    } finally {
      await daemon.stop();
    }
  });

  it('health endpoint includes browsers status', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      const body = await resp.json();
      expect(body).toHaveProperty('browsers');
    } finally {
      await daemon.stop();
    }
  });

  it('health endpoint includes cache status', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      const body = await resp.json();
      expect(body).toHaveProperty('cache');
    } finally {
      await daemon.stop();
    }
  });

  it('health endpoint includes uptime_seconds', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      const body = await resp.json();
      expect(body).toHaveProperty('uptime_seconds');
      expect(typeof body.uptime_seconds).toBe('number');
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    } finally {
      await daemon.stop();
    }
  });

  it('concurrent health check requests are handled', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const results = await Promise.all(
        Array.from({ length: 5 }, () => fetch(`${url}/health`).then(r => r.json())),
      );
      for (const body of results) {
        expect(body.status).toBeDefined();
      }
    } finally {
      await daemon.stop();
    }
  });

  it('rejects second instance on same port with EADDRINUSE', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon1 = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    const url1 = await daemon1.start();
    const port = parseInt(new URL(url1).port, 10);

    const daemon2 = new DaemonHttpServer({ port, host: '127.0.0.1' });
    try {
      await expect(daemon2.start()).rejects.toThrow(/EADDRINUSE/);
    } finally {
      await daemon1.stop();
      await daemon2.stop();
    }
  });

  it('POST /mcp with initialize creates a session (per-session pattern)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          id: 1,
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0' },
          },
        }),
      });
      expect(resp.status).not.toBe(404);
      expect(resp.status).not.toBe(400);
    } finally {
      await daemon.stop();
    }
  });

  it('POST /mcp without initialize and without session ID returns 400', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1, params: {} }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });

  it('POST /messages without sessionId query param returns 400', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1, params: {} }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });

  it('POST /messages with invalid sessionId returns 400', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/messages?sessionId=nonexistent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1, params: {} }),
      });
      expect(resp.status).toBe(400);
    } finally {
      await daemon.stop();
    }
  });
});

describe('DaemonHttpServer auth + request timeout', () => {
  beforeEach(() => {
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetConfig();
  });

  const AUTH = { token: 'secret-token-xyz', host: '127.0.0.1', port: 0 };
  const mcpBody = () =>
    JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} });

  it('rejects POST /mcp with no bearer when auth is enabled (401)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: mcpBody(),
      });
      expect(resp.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('rejects POST /mcp with a wrong bearer (401)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nope' },
        body: mcpBody(),
      });
      expect(resp.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('rejects a cross-origin POST /mcp even with a valid bearer (403)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${AUTH.token}`,
          Origin: 'http://evil.com',
        },
        body: mcpBody(),
      });
      expect(resp.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('leaves GET /health open when auth is enabled (200)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      expect(resp.status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  it('accepts POST /mcp with the correct bearer (not auth-rejected)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: AUTH });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH.token}` },
        body: mcpBody(),
      });
      expect(resp.status).not.toBe(401);
      expect(resp.status).not.toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('does not require auth when the auth option is unset (back-compat)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: mcpBody(),
      });
      expect(resp.status).not.toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('returns 504 when a request exceeds requestTimeoutMs', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const http = await import('node:http');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', requestTimeoutMs: 1 });
    try {
      const url = await daemon.start();
      const parsed = new URL(`${url}/mcp`);
      // Declare a body but send only part of it and never end the request, so the
      // server's body read hangs and the request-timeout fires deterministically
      // (no race with a fast handler path).
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': '64' },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          },
        );
        req.on('error', reject);
        req.write('{');
        setTimeout(() => reject(new Error('no response within 3s')), 3000);
      });
      expect(status).toBe(504);
    } finally {
      await daemon.stop();
    }
  });

  it('does not time out GET /health (health is exempt)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', requestTimeoutMs: 1 });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/health`);
      expect(resp.status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  it('S3: a non-loopback serve forces auth on, so a tokenless request is rejected (401)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const { buildServeAuth } = await import('../../../src/cli/daemon.js');
    // What `wigolo serve --host 0.0.0.0 --allow-remote` (no operator token) computes:
    const decision = buildServeAuth({ host: '0.0.0.0', allowRemote: true, configuredToken: null });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.auth).toBeDefined(); // auth is FORCED on for a non-loopback bind
    // Bind loopback for test safety but enforce that forced auth: a request with
    // no bearer is rejected → no unauthenticated access on a non-loopback serve.
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: decision.auth });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: mcpBody(),
      });
      expect(resp.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });
});

describe('DaemonHttpServer websocket upgrade seam', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); });

  const AUTH = { token: 'ws-secret-token-1234567890', host: '127.0.0.1', port: 0 };

  async function startWithUpgrade(opts: Record<string, unknown>) {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const wss = new WebSocketServer({ noServer: true });
    const onUpgrade = vi.fn((req: IncomingMessage, socket: Duplex, head: Buffer) => {
      wss.handleUpgrade(req, socket, head, (ws) => { ws.send('hello'); });
    });
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', ...opts, onUpgrade });
    const url = await daemon.start();
    return { daemon, wss, onUpgrade, wsUrl: url.replace('http://', 'ws://') };
  }

  function connect(url: string, protocols: string[], options?: { origin?: string }): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, protocols, options);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('invokes onUpgrade for an authenticated upgrade with a valid subprotocol bearer', async () => {
    const { daemon, wss, onUpgrade, wsUrl } = await startWithUpgrade({ auth: AUTH });
    try {
      const ws = await connect(`${wsUrl}/studio/x/stream`, [`wigolo.bearer.${AUTH.token}`]);
      expect(onUpgrade).toHaveBeenCalledTimes(1);
      ws.close();
    } finally {
      wss.close();
      await daemon.stop();
    }
  });

  it('rejects an upgrade with a wrong subprotocol bearer (socket destroyed, onUpgrade not called)', async () => {
    const { daemon, wss, onUpgrade, wsUrl } = await startWithUpgrade({ auth: AUTH });
    try {
      await expect(connect(`${wsUrl}/studio/x/stream`, ['wigolo.bearer.wrong'])).rejects.toBeDefined();
      expect(onUpgrade).not.toHaveBeenCalled();
    } finally {
      wss.close();
      await daemon.stop();
    }
  });

  it('rejects a cross-origin upgrade even with a valid bearer (DNS-rebinding defense)', async () => {
    const { daemon, wss, onUpgrade, wsUrl } = await startWithUpgrade({ auth: AUTH });
    try {
      await expect(
        connect(`${wsUrl}/studio/x/stream`, [`wigolo.bearer.${AUTH.token}`], { origin: 'http://evil.com' }),
      ).rejects.toBeDefined();
      expect(onUpgrade).not.toHaveBeenCalled();
    } finally {
      wss.close();
      await daemon.stop();
    }
  });

  it('a websocket upgrade is not bounded by requestTimeoutMs (long-lived, bypasses the 504 path)', async () => {
    const { daemon, wss, onUpgrade, wsUrl } = await startWithUpgrade({ auth: AUTH, requestTimeoutMs: 1 });
    try {
      const ws = await connect(`${wsUrl}/studio/x/stream`, [`wigolo.bearer.${AUTH.token}`]);
      await new Promise((r) => setTimeout(r, 30)); // well past the 1ms request budget
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(onUpgrade).toHaveBeenCalledTimes(1);
      ws.close();
    } finally {
      wss.close();
      await daemon.stop();
    }
  });

  it('does not attach an upgrade listener / accepts no upgrade when onUpgrade is unset (back-compat)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    const url = await daemon.start();
    const wsUrl = url.replace('http://', 'ws://');
    try {
      await expect(connect(`${wsUrl}/anything`, [])).rejects.toBeDefined();
    } finally {
      await daemon.stop();
    }
  });
});

describe('DaemonHttpServer — P6-d close-out guard pins', () => {
  beforeEach(() => { resetConfig(); vi.clearAllMocks(); });
  afterEach(() => { resetConfig(); });

  // Refactor-safety (NOT the LOCKED-B guard): a non-tool serve path (health / 404) does not resolve a
  // PROVIDER API key (security/key-store.ts). This is acceptable-and-harmless — a serve-dispatched LLM
  // TOOL legitimately resolves a provider key; this only pins that bare dispatch/health paths don't.
  // The LOCKED-B browser-credential-store invariant is the structural import-closure pin in
  // serve-lockedb-closure.test.ts (profile-store.ts), NOT this provider-key spy.
  it('refactor-safety: bare serve paths (health/404) do not resolve a PROVIDER key', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' }); // loopback serve
    try {
      const url = await daemon.start();
      await fetch(`${url}/health`); // serve dispatch entry (handleRequest)
      await fetch(`${url}/nonexistent`); // reaches routeRequest
      // mutation: wire a provider-key read (readKey/resolveProviderKey) into the bare dispatch → fires → reds.
      expect(readKeySpy).not.toHaveBeenCalled();
      expect(resolveProviderKeySpy).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it('PIN-2 (slice 3d): the bearer is NEVER written to stderr/logs on the verify path', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const TOKEN = 'p6d-pin2-secret-bearer-abc123xyz';
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', auth: { token: TOKEN, host: '127.0.0.1' } });
    const writes: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk: unknown) => { writes.push(typeof chunk === 'string' ? chunk : String(chunk)); return true; };
    try {
      const url = await daemon.start();
      // verify-FAIL (wrong bearer) + verify-PASS (correct bearer) — both run checkAuth on the verify path.
      await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' }, body: '{}' });
      await fetch(`${url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: '{}' });
      // mutation: log the token in the auth/verify block (e.g. log.error('t', this.auth.token)) → it lands here → reds.
      expect(writes.join('')).not.toContain(TOKEN);
    } finally {
      (process.stderr as unknown as { write: typeof origWrite }).write = origWrite;
      await daemon.stop();
    }
  });
});
