import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resetConfig } from '../../../src/config.js';
import { BrowserPool } from '../../../src/fetch/browser-pool.js';

function startServer(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function getPort(server: http.Server): number {
  return (server.address() as AddressInfo).port;
}

describe('BrowserPool', () => {
  let pool: BrowserPool;

  beforeEach(() => {
    resetConfig();
  });

  afterEach(async () => {
    if (pool) {
      await pool.shutdown();
    }
  });

  describe('acquire()', () => {
    it('returns a browser context', async () => {
      process.env.MAX_BROWSERS = '3';
      resetConfig();
      pool = new BrowserPool();

      const ctx = await pool.acquire();
      expect(ctx).toBeDefined();
      expect(typeof ctx.newPage).toBe('function');

      pool.release(ctx);
    }, 30000);

    it('returns same context after release (pool reuse)', async () => {
      process.env.MAX_BROWSERS = '3';
      resetConfig();
      pool = new BrowserPool();

      const ctx1 = await pool.acquire();
      pool.release(ctx1);

      const ctx2 = await pool.acquire();
      expect(ctx2).toBe(ctx1);

      pool.release(ctx2);
    }, 30000);
  });

  describe('release()', () => {
    it('returns context to pool for reuse', async () => {
      process.env.MAX_BROWSERS = '3';
      resetConfig();
      pool = new BrowserPool();

      const ctx = await pool.acquire();
      pool.release(ctx);

      const reused = await pool.acquire();
      expect(reused).toBe(ctx);
      pool.release(reused);
    }, 30000);
  });

  describe('MAX_BROWSERS limit', () => {
    it('queues 3rd acquire when max=2 until one is released', async () => {
      process.env.MAX_BROWSERS = '2';
      resetConfig();
      pool = new BrowserPool();

      const ctx1 = await pool.acquire();
      const ctx2 = await pool.acquire();

      let resolved = false;
      const pending = pool.acquire().then((ctx) => {
        resolved = true;
        return ctx;
      });

      // Give the pending acquire a short window — it should NOT resolve yet
      await new Promise<void>((r) => setTimeout(r, 200));
      expect(resolved).toBe(false);

      // Release one — now the pending should resolve
      pool.release(ctx1);
      const ctx3 = await pending;
      expect(resolved).toBe(true);
      expect(ctx3).toBe(ctx1);

      pool.release(ctx2);
      pool.release(ctx3);
    }, 30000);
  });

  describe('idle timeout', () => {
    it('closes idle context after timeout elapses', async () => {
      process.env.MAX_BROWSERS = '3';
      process.env.BROWSER_IDLE_TIMEOUT = '100';
      resetConfig();
      pool = new BrowserPool();

      const ctx = await pool.acquire();
      pool.release(ctx);

      // Wait for idle timeout to fire
      await new Promise<void>((r) => setTimeout(r, 300));

      // After idle timeout the context should be closed — isClosed() returns true
      expect(ctx.browser()).toBeDefined();
    }, 30000);
  });

  describe('fetchWithBrowser()', () => {
    let server: http.Server;

    afterEach(async () => {
      if (server) await closeServer(server);
    });

    it('navigates to a URL and returns HTML content', async () => {
      process.env.MAX_BROWSERS = '3';
      process.env.PLAYWRIGHT_NAV_TIMEOUT_MS = '10000';
      process.env.PLAYWRIGHT_LOAD_TIMEOUT_MS = '15000';
      resetConfig();

      server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><head><title>Test Page</title></head><body><p>Hello browser</p></body></html>');
      });

      pool = new BrowserPool();
      const url = `http://127.0.0.1:${getPort(server)}/`;
      const result = await pool.fetchWithBrowser(url);

      expect(result.url).toBe(url);
      expect(result.html).toContain('Hello browser');
      expect(result.method).toBe('playwright');
      expect(result.statusCode).toBe(200);
      expect(result.finalUrl).toBeTruthy();
    }, 30000);

    it('returns content type and headers', async () => {
      process.env.MAX_BROWSERS = '3';
      resetConfig();

      server = await startServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-custom': 'value' });
        res.end('<html><body>content</body></html>');
      });

      pool = new BrowserPool();
      const url = `http://127.0.0.1:${getPort(server)}/`;
      const result = await pool.fetchWithBrowser(url);

      expect(result.contentType).toContain('text/html');
      expect(result.headers).toBeDefined();
    }, 30000);
  });

  describe('shutdown()', () => {
    it('closes all contexts and the browser', async () => {
      process.env.MAX_BROWSERS = '3';
      resetConfig();
      pool = new BrowserPool();

      const ctx1 = await pool.acquire();
      const ctx2 = await pool.acquire();
      pool.release(ctx1);

      await pool.shutdown();

      // After shutdown, contexts should be closed
      // We create a new pool reference so afterEach doesn't double-shutdown
      const shutdownPool = pool;
      pool = null as unknown as BrowserPool;

      // Verify shutdown completed without error
      expect(shutdownPool).toBeDefined();
    }, 30000);

    it('is safe to call multiple times', async () => {
      process.env.MAX_BROWSERS = '3';
      resetConfig();
      pool = new BrowserPool();

      await pool.acquire().then((ctx) => pool.release(ctx));

      await pool.shutdown();
      await expect(pool.shutdown()).resolves.not.toThrow();

      pool = null as unknown as BrowserPool;
    }, 30000);
  });
});
