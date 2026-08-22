import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';

/**
 * A redirect whose body never ends must not be able to hang the fetch.
 *
 * The redirect path reads `location` and continues without consuming the response body. That was
 * untidy before this branch; it became a hang once the per-hop Agents started being closed on the
 * way out, because `Agent.close()` waits for in-flight requests and an undrained body keeps one in
 * flight forever. The wait happens in the `finally`, outside the AbortSignal that bounds the
 * request, so `timeoutMs` cannot rescue it.
 *
 * The server here sends a 302 with a valid Location and then writes forever without ending. If the
 * body is not cancelled before the hop advances, this test times out instead of asserting.
 */
describe('a never-ending redirect body must not hang the fetch', () => {
  let server: Server;
  let port: number;
  let stop: (() => void) | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, {
          location: `http://127.0.0.1:${port}/done`,
          'content-type': 'text/plain',
        });
        // Never call res.end(). Keep the body open so the request stays in flight.
        const t = setInterval(() => {
          try {
            res.write('.'.repeat(1024));
          } catch {
            /* client went away */
          }
        }, 10);
        stop = () => clearInterval(t);
        res.on('close', () => clearInterval(t));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>done</body></html>');
    });
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    stop?.();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('completes rather than hanging on the undrained redirect body', async () => {
    const started = Date.now();
    const res = await httpFetch(`http://localhost:${port}/redir`, { timeoutMs: 2000 });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.html).toContain('done');
    // With the body cancelled the hop costs nothing. If it is left undrained the call is held up
    // until the per-hop AbortSignal fires, so elapsed tracks timeoutMs instead.
    console.log(`   elapsed ${elapsed}ms for timeoutMs=2000`);
    expect(elapsed).toBeLessThan(1500);
  }, 20000);
});

