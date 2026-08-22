import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';

/**
 * Redirect chains that mix a named hop with an IP-literal hop.
 *
 * A named hop takes a pinned dispatcher; an IP-literal hop takes none. Before the per-hop fix the
 * dispatcher was declared outside the loop, so the literal hop inherited the previous hop's Agent.
 *
 * Be straight about what this test is: a REGRESSION GUARD, not a discriminating test. The buggy
 * version passes it too, because `createPinnedLookup` defers to real DNS whenever the host it is
 * asked for is not the host it was built for — so the inherited Agent behaved like a plain one and
 * produced the right answer by accident. That fallthrough is what kept this a correctness problem
 * rather than a routing one. The test is here so the mixed chain stays exercised, since nothing
 * else in the suite covers it.
 */
describe('redirect chains mixing named and IP-literal hops', () => {
  let server: Server;
  let port: number;
  const seen: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url ?? '');
      if (req.url === '/to-literal') {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/done` });
        res.end();
        return;
      }
      if (req.url === '/to-name') {
        res.writeHead(302, { location: `http://localhost:${port}/done` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>arrived</body></html>');
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('name -> IP literal: the literal hop must not inherit the named hop dispatcher', async () => {
    const res = await httpFetch(`http://localhost:${port}/to-literal`);
    expect(res.statusCode).toBe(200);
    expect(res.html).toContain('arrived');
    expect(res.finalUrl).toBe(`http://127.0.0.1:${port}/done`);
  }, 30000);

  it('IP literal -> name: the named hop still gets its own pin', async () => {
    const res = await httpFetch(`http://127.0.0.1:${port}/to-name`);
    expect(res.statusCode).toBe(200);
    expect(res.html).toContain('arrived');
    expect(res.finalUrl).toBe(`http://localhost:${port}/done`);
  }, 30000);
});
