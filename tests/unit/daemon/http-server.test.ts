import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetConfig } from '../../../src/config.js';
import { resolveSearchBackend, getBootstrapState } from '../../../src/searxng/bootstrap.js';

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

describe('DaemonHttpServer', () => {
  beforeEach(() => {
    // An ambient API token in dev/CI would 401 the /mcp tests below.
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
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

  it('start() performs ZERO sidecar activity on the default core backend', async () => {
    // WHY (D1): the daemon must honor the same zero-config gate as stdio mode.
    // A default `core` daemon must not resolve/probe/install the sidecar.
    delete process.env.WIGOLO_SEARCH;
    resetConfig();
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      await daemon.start();
      // bootstrapSearxng runs detached via .catch(); let its microtask settle.
      await new Promise((r) => setTimeout(r, 20));
      expect(resolveSearchBackend).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
    }
  });

  it('start() DOES resolve the backend when WIGOLO_SEARCH=searxng and the sidecar is installed (positive control)', async () => {
    process.env.WIGOLO_SEARCH = 'searxng';
    resetConfig();
    vi.mocked(getBootstrapState).mockReturnValue({ status: 'ready', searxngPath: '/tmp/searxng' });
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      await daemon.start();
      await new Promise((r) => setTimeout(r, 20));
      expect(resolveSearchBackend).toHaveBeenCalled();
    } finally {
      await daemon.stop();
      delete process.env.WIGOLO_SEARCH;
      vi.mocked(getBootstrapState).mockReturnValue(null);
      resetConfig();
    }
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

  it('sets server-level request + headers timeouts after start() (slow-loris guard, L2)', async () => {
    // WHY: without explicit server.requestTimeout / headersTimeout a slow-drip
    // client stays under the byte cap yet holds a connection (and, since /v1
    // acquires a slot before the body read, a slot) for Node's ~300s default.
    // These bounded values cut a slow body/headers off. A revert to the Node
    // defaults (0 for requestTimeout) fails this.
    delete process.env.WIGOLO_SERVE_REQUEST_TIMEOUT_MS;
    delete process.env.WIGOLO_SERVE_HEADERS_TIMEOUT_MS;
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      await daemon.start();
      const server = (daemon as unknown as { httpServer: import('node:http').Server }).httpServer;
      expect(server.requestTimeout).toBe(120000);
      expect(server.headersTimeout).toBe(60000);
    } finally {
      await daemon.stop();
    }
  });

  it('honours env overrides for the server-level timeouts (L2)', async () => {
    process.env.WIGOLO_SERVE_REQUEST_TIMEOUT_MS = '45000';
    process.env.WIGOLO_SERVE_HEADERS_TIMEOUT_MS = '15000';
    resetConfig();
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      await daemon.start();
      const server = (daemon as unknown as { httpServer: import('node:http').Server }).httpServer;
      expect(server.requestTimeout).toBe(45000);
      expect(server.headersTimeout).toBe(15000);
    } finally {
      await daemon.stop();
      delete process.env.WIGOLO_SERVE_REQUEST_TIMEOUT_MS;
      delete process.env.WIGOLO_SERVE_HEADERS_TIMEOUT_MS;
      resetConfig();
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

describe('DaemonHttpServer — MCP transport DNS-rebinding / Origin guard (MED-1)', () => {
  // WHY (MED-1): /mcp, /sse, /messages previously gated only through the bearer
  // check, which allows through in open mode (no token). In that mode they
  // applied NO Host allowlist and NO Origin reject — unlike the REST router and
  // the admin route. A malicious web page resolving an attacker domain to
  // 127.0.0.1 could POST JSON-RPC to /mcp with a browser Origin and drive the
  // local MCP server. Origin remains blocked in both open and token modes; a
  // configured bearer token authorizes a remote MCP client without requiring a
  // loopback Host.
  beforeEach(() => {
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    resetConfig();
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.WIGOLO_API_TOKEN;
    resetConfig();
  });

  async function postMcp(url: string, headers: Record<string, string>): Promise<number> {
    const http = await import('node:http');
    const parsed = new URL(url);
    return new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: '/mcp',
          method: 'POST',
          headers: {
            Accept: 'application/json, text/event-stream',
            'Content-Type': 'application/json',
            ...headers,
          },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.destroy();
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        id: 1,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' },
        },
      }));
    });
  }

  it('NEGATIVE: POST /mcp with a browser Origin → 403 (open mode)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      expect(resp.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: POST /mcp with a browser Origin → 403 (token mode)', async () => {
    process.env.WIGOLO_API_TOKEN = 'secret-token';
    resetConfig();
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: 'secret-token' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-token',
          Origin: 'https://evil.example.com',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      expect(resp.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: GET /sse with a browser Origin → 403 (open mode)', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const http = await import('node:http');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const parsed = new URL(`${url}/sse`);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            headers: { Accept: 'text/event-stream', Origin: 'https://evil.example.com' },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.destroy();
          },
        );
        req.on('error', reject);
        setTimeout(() => { req.destroy(); reject(new Error('timeout')); }, 3000);
      });
      expect(status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: POST /mcp with a non-loopback Host → 403 in open mode', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const http = await import('node:http');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const parsed = new URL(url);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: '/mcp',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Host: 'attacker.example.com' },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.destroy();
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }));
      });
      expect(status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('POSITIVE: POST /mcp with a valid bearer and remote Host reaches the transport', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: 'secret-token' });
    try {
      const url = await daemon.start();
      const status = await postMcp(url, {
        Authorization: 'Bearer secret-token',
        Host: 'mcp.example.com',
      });
      expect(status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: POST /mcp with an invalid bearer and remote Host → 401', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: 'secret-token' });
    try {
      const url = await daemon.start();
      const status = await postMcp(url, {
        Authorization: 'Bearer wrong-token',
        Host: 'mcp.example.com',
      });
      expect(status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('POSITIVE: a normal no-Origin MCP client request still passes (open mode)', async () => {
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
      expect(resp.status).not.toBe(403);
      expect(resp.status).not.toBe(404);
    } finally {
      await daemon.stop();
    }
  });
});

describe('DaemonHttpServer — POST /admin/reset-breakers auth (D9)', () => {
  // WHY (D9 review BLOCKER): the admin reset route is a privileged control
  // surface. Loopback source-IP is NOT the control — cloudflared remote-serve
  // delivers everything from 127.0.0.1. The boundary is a random bearer token
  // written owner-only to disk PLUS a browser-Origin reject PLUS a Host
  // allowlist. Each negative below encodes one of those guards.
  let dir: string;

  beforeEach(async () => {
    delete process.env.WIGOLO_API_TOKEN;
    delete process.env.WIGOLO_API_TOKEN_FILE;
    resetConfig();
    vi.clearAllMocks();
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    dir = mkdtempSync(join(tmpdir(), 'wigolo-admin-route-'));
    process.env.WIGOLO_DATA_DIR = dir;
    resetConfig();
  });

  afterEach(async () => {
    delete process.env.WIGOLO_DATA_DIR;
    resetConfig();
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a 0600 admin token file at daemon start', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const { adminTokenPath, readAdminToken } = await import('../../../src/daemon/admin-token.js');
    const { existsSync, statSync } = await import('node:fs');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      await daemon.start();
      expect(existsSync(adminTokenPath(dir))).toBe(true);
      expect(readAdminToken(dir)).toBeTruthy();
      if (process.platform !== 'win32') {
        expect(statSync(adminTokenPath(dir)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await daemon.stop();
    }
  });

  it('valid bearer token resets breakers and returns 200 with a snapshot', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const { readAdminToken } = await import('../../../src/daemon/admin-token.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const token = readAdminToken(dir);
      const resp = await fetch(`${url}/admin/reset-breakers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body).toHaveProperty('reset', true);
      expect(Array.isArray(body.breakers)).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: no Authorization header → 401', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/admin/reset-breakers`, { method: 'POST' });
      expect(resp.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: wrong bearer token → 401', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/admin/reset-breakers`, {
        method: 'POST',
        headers: { Authorization: 'Bearer not-the-real-token' },
      });
      expect(resp.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: valid token BUT a browser Origin header → 403', async () => {
    // A legitimate CLI never sets Origin; a browser always does. An Origin on an
    // admin request means a page is trying to drive the daemon — reject even
    // with a correct token (a CSRF-style guard).
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const { readAdminToken } = await import('../../../src/daemon/admin-token.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const token = readAdminToken(dir);
      const resp = await fetch(`${url}/admin/reset-breakers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: 'https://evil.example.com',
        },
      });
      expect(resp.status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('NEGATIVE: non-allowlisted Host header → 403', async () => {
    // DNS-rebinding guard: only localhost / the configured host may reach the
    // admin route. A spoofed Host is rejected before the token is even checked.
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const { readAdminToken } = await import('../../../src/daemon/admin-token.js');
    const http = await import('node:http');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const token = readAdminToken(dir);
      const parsed = new URL(url);
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: '/admin/reset-breakers',
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              Host: 'attacker.example.com',
            },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.destroy();
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(403);
    } finally {
      await daemon.stop();
    }
  });

  it('GET /admin/reset-breakers is not a valid route → 404', async () => {
    const { DaemonHttpServer } = await import('../../../src/daemon/http-server.js');
    const daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    try {
      const url = await daemon.start();
      const resp = await fetch(`${url}/admin/reset-breakers`, { method: 'GET' });
      expect(resp.status).toBe(404);
    } finally {
      await daemon.stop();
    }
  });
});
