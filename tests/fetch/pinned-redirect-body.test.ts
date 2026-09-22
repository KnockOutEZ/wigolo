import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';

/**
 * A redirect whose body never ends must not be able to hold up the fetch.
 *
 * The redirect path reads `location` and continues without consuming the response body. That was
 * untidy before this branch; it became costly once the per-hop Agents started being torn down on
 * the way out, because an unread body keeps the request in flight. Measured at the time: 2038ms
 * against `timeoutMs=2000`, i.e. a full timeout added to every such redirect.
 *
 * WHY /done IS GATED ON THE REDIRECT SOCKET CLOSING
 * -------------------------------------------------
 * An elapsed-time assertion alone does NOT test what it looks like it tests. The fix has two
 * halves — `response.body.cancel()` on the redirect path, and `Agent.destroy()` rather than
 * `close()` in the cleanup — and `destroy()` does not wait for in-flight requests. So with the
 * cancel deleted and only `destroy()` left, the call still returns immediately and a naive timing
 * test passes. Verified by deleting it: the test passed in 202ms with no cancel anywhere.
 *
 * Gating `/done` on the redirect response's `close` event makes the second hop *depend* on the
 * first hop's body actually being released. With the cancel in place the socket closes at once and
 * this finishes in milliseconds. Without it, nothing closes until the per-hop AbortSignal fires,
 * so `/done` cannot answer and elapsed climbs to `timeoutMs` — the assertion fails, by design.
 */
describe('a never-ending redirect body must not hold up the fetch', () => {
  let server: Server;
  let port: number;
  let stopWriting: (() => void) | undefined;
  let onRedirectClosed: (() => void) | undefined;
  let redirectClosed: Promise<void>;

  beforeAll(async () => {
    redirectClosed = new Promise<void>((resolve) => {
      onRedirectClosed = resolve;
    });

    server = createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, {
          location: `http://127.0.0.1:${port}/done`,
          'content-type': 'text/plain',
        });
        // Never end this response. It stays in flight until the client lets go of the body.
        const timer = setInterval(() => {
          try {
            res.write('.'.repeat(1024));
          } catch {
            /* peer gone */
          }
        }, 10);
        stopWriting = () => clearInterval(timer);
        res.on('close', () => {
          clearInterval(timer);
          onRedirectClosed?.();
        });
        return;
      }

      // The second hop only answers once the first hop's body has actually been released.
      void redirectClosed.then(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<html><body>done</body></html>');
      });
    });

    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    stopWriting?.();
    onRedirectClosed?.();
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('releases the redirect body instead of leaving it in flight', async () => {
    const started = Date.now();
    const res = await httpFetch(`http://localhost:${port}/redir`, { timeoutMs: 2000 });
    const elapsed = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.html).toContain('done');
    console.log(`   elapsed ${elapsed}ms for timeoutMs=2000`);
    expect(elapsed).toBeLessThan(1500);
  }, 20000);
});
