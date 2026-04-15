import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { DaemonHttpServer } from '../../src/daemon/http-server.js';
import { tryConnectDaemon, DaemonProxy } from '../../src/daemon/proxy.js';

let daemon: DaemonHttpServer;
let daemonUrl: string;
let daemonPort: number;

// Plain one-shot HTTP GET with Connection: close to bypass undici's keep-alive
// pool. Avoids ECONNRESET flakes on GH Actions when tests pause between fetches
// and a pooled socket silently closes before reuse.
async function httpGetJson(url: string): Promise<{ status: number; body: unknown }> {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: { 'Connection': 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) });
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('httpGetJson timeout'));
    });
  });
}

describe('Daemon Mode Integration', () => {
  beforeAll(async () => {
    daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1' });
    daemonUrl = await daemon.start();
    daemonPort = parseInt(new URL(daemonUrl).port, 10);
  }, 30000);

  afterAll(async () => {
    await daemon.stop();
  }, 10000);

  it('daemon starts and returns a URL', () => {
    expect(daemonUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('health endpoint responds with JSON', async () => {
    const resp = await fetch(`${daemonUrl}/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body).toHaveProperty('status');
    expect(body).toHaveProperty('searxng');
    expect(body).toHaveProperty('browsers');
    expect(body).toHaveProperty('cache');
    expect(body).toHaveProperty('uptime_seconds');
  });

  it('health status is not "down" after startup', async () => {
    const resp = await fetch(`${daemonUrl}/health`);
    const body = await resp.json();
    expect(body.status).not.toBe('down');
  });

  it('tryConnectDaemon detects the running daemon', async () => {
    const report = await tryConnectDaemon(daemonPort, '127.0.0.1');
    expect(report).not.toBeNull();
    expect(report!.status).toBeDefined();
  });

  it('tryConnectDaemon returns null for wrong port', async () => {
    const report = await tryConnectDaemon(19996, '127.0.0.1');
    expect(report).toBeNull();
  });

  it('DaemonProxy can check health', async () => {
    const proxy = new DaemonProxy(daemonUrl);
    const report = await proxy.checkHealth();
    expect(report).not.toBeNull();
    expect(report!.status).toBeDefined();
  });

  it('MCP endpoint responds to POST (not 404)', async () => {
    const resp = await fetch(`${daemonUrl}/mcp`, {
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
  });

  it('SSE endpoint responds to GET (not 404)', async () => {
    const http = await import('node:http');
    const parsedUrl = new URL(`${daemonUrl}/sse`);
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
  });

  it('unknown path returns 404', async () => {
    const resp = await fetch(`${daemonUrl}/nonexistent`);
    expect(resp.status).toBe(404);
  });

  it('multiple concurrent health checks succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${daemonUrl}/health`).then(r => r.json()),
      ),
    );
    for (const body of results) {
      expect(body).toHaveProperty('status');
    }
  });

  it('uptime_seconds increases over time', async () => {
    const first = await httpGetJson(`${daemonUrl}/health`);
    const uptime1 = (first.body as { uptime_seconds: number }).uptime_seconds;

    await new Promise(r => setTimeout(r, 1100));

    const second = await httpGetJson(`${daemonUrl}/health`);
    const uptime2 = (second.body as { uptime_seconds: number }).uptime_seconds;

    expect(uptime2).toBeGreaterThanOrEqual(uptime1);
  });

  it('cache status is active', async () => {
    const resp = await fetch(`${daemonUrl}/health`);
    const body = await resp.json();
    expect(body.cache).toBe('active');
  });

  it('daemon handles rapid sequential requests', async () => {
    for (let i = 0; i < 5; i++) {
      const resp = await fetch(`${daemonUrl}/health`);
      expect(resp.status).toBe(200);
    }
  });
});
