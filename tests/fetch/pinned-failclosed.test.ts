import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpFetch } from '../../src/fetch/http-client.js';

/**
 * The must-reject control for the pin.
 *
 * `guardResolvedHost` reports ok with no addresses when a host does not resolve. Before this
 * change the caller shrugged and let `fetch` re-resolve, on the reasoning that an unresolvable
 * host has no IP to connect to. That only holds if both lookups get the same answer, and they are
 * two separate queries — an attacker controlling the authority can answer the validation query
 * with nothing and the connect query with 169.254.169.254.
 *
 * `.invalid` is reserved by RFC 6761 and guaranteed never to resolve, so it stands in for the
 * "validation produced nothing" case without needing a hostile resolver.
 */
describe('fail closed when there is nothing to pin to', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_q, r) => r.end('should not be reached'));
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((res) => server.close(() => res()));
  });

  it('refuses a hostname that produced no validated addresses', async () => {
    await expect(httpFetch('http://nothing-resolves-here.invalid/')).rejects.toThrow(
      /refusing to connect without pinning/i,
    );
  }, 30000);

  it('MUST-PASS control: a hostname that does resolve is still fetched normally', async () => {
    // Without this, a change that refused *everything* would pass the test above and look correct.
    const res = await httpFetch(`http://localhost:${port}/`);
    expect(res.statusCode).toBe(200);
  }, 30000);
});
