import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';

/**
 * The unit tests for `createPinnedLookup` prove the hook returns the right address. They do NOT
 * prove the hook is actually wired into a real request, or that wiring it does not break one —
 * and every other http-client test fetches an IP literal (`http://127.0.0.1:PORT/`), which skips
 * the pinned path completely.
 *
 * So this fetches by NAME. `localhost` resolves to loopback, which the fetch policy allows for the
 * local-dev promise, so the guard passes, returns its validated addresses, and the request goes
 * out through a pinned Agent. If pinning were broken — wrong callback arity, wrong family, a
 * dispatcher that never connects — this test hangs or fails while every IP-literal test keeps
 * passing.
 */
describe('http tier: a request by hostname goes through the pinned dispatcher (issue #207)', () => {
  let server: Server;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>pinned ok</body></html>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('fetches successfully by name, not by IP literal', async () => {
    const res = await httpFetch(`http://localhost:${port}/`);
    expect(res.statusCode).toBe(200);
    expect(res.html).toContain('pinned ok');
    expect(hits).toBeGreaterThan(0);
  });

  it('still fetches by IP literal, where no pinning applies', async () => {
    const before = hits;
    const res = await httpFetch(`http://127.0.0.1:${port}/`);
    expect(res.statusCode).toBe(200);
    expect(hits).toBe(before + 1);
  });
});
