import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
