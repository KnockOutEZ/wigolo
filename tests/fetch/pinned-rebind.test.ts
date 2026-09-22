import { createServer, type Server } from 'node:http';
import { Agent, request } from 'undici';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPinnedLookup } from '../../src/fetch/pinned-dispatcher.js';

/**
 * The discriminating test: does pinning actually change which host the socket dials?
 *
 * Two servers on the same port, different loopback addresses — 127.0.0.1 is the address SSRF
 * validation cleared, 127.0.0.2 stands in for the address an attacker's resolver flips to inside
 * the TTL window. A "rebinding" lookup always answers 127.0.0.2.
 *
 *   - through a plain Agent using that lookup, the request lands on the ATTACKER server
 *   - through a pinned Agent, it lands on the VALIDATED one
 *
 * That is DNS rebinding reproduced over a real socket, and it is the assertion that fails if the
 * pin is ever removed or wired wrong. The `expect(attacker.hits)` line is the control: without it
 * a broken pin that simply never connected would look the same as a working one.
 */
describe('pinning changes which address the socket dials (issue #207)', () => {
  const VALIDATED_IP = '127.0.0.1';
  const ATTACKER_IP = '127.0.0.2';
  let validated: Server;
  let attacker: Server;
  let port = 0;
  const hits = { validated: 0, attacker: 0 };
  let bothBound = false;

  beforeAll(async () => {
    validated = createServer((_q, r) => {
      hits.validated++;
      r.writeHead(200, { 'content-type': 'text/plain' });
      r.end('validated');
    });
    attacker = createServer((_q, r) => {
      hits.attacker++;
      r.writeHead(200, { 'content-type': 'text/plain' });
      r.end('attacker');
    });
    await new Promise<void>((res) => validated.listen(0, VALIDATED_IP, res));
    port = (validated.address() as { port: number }).port;
    // 127.0.0.2 is bindable on Linux and Windows; if a platform refuses it, skip rather than
    // report a pass we did not actually get.
    bothBound = await new Promise<boolean>((res) => {
      attacker.once('error', () => res(false));
      attacker.listen(port, ATTACKER_IP, () => res(true));
    });
  });

  afterAll(async () => {
    await new Promise<void>((res) => validated.close(() => res()));
    if (bothBound) await new Promise<void>((res) => attacker.close(() => res()));
  });

  /** A resolver that always answers with the attacker's address — the second, hostile resolution. */
  const rebindingLookup = ((
    _host: string,
    options: { all?: boolean },
    cb: (...a: unknown[]) => void,
  ) => {
    if (options?.all) cb(null, [{ address: ATTACKER_IP, family: 4 }]);
    else cb(null, ATTACKER_IP, 4);
  }) as never;

  it('WITHOUT pinning the rebinding resolver wins — the attacker server is reached', async (ctx) => {
    // Skip VISIBLY where 127.0.0.2 will not bind. A silent `return` here would report a pass
    // having asserted nothing, which is the failure mode this whole test exists to prevent.
    if (!bothBound) ctx.skip();
    const agent = new Agent({ connect: { lookup: rebindingLookup } as never });
    const res = await request(`http://pinned.test:${port}/`, { dispatcher: agent });
    const body = await res.body.text();
    expect(body).toBe('attacker');
    expect(hits.attacker).toBeGreaterThan(0);
    await agent.close();
  });

  it('WITH pinning the validated address wins, even though DNS would say otherwise', async (ctx) => {
    if (!bothBound) ctx.skip();
    const before = { ...hits };
    const agent = new Agent({
      connect: {
        lookup: createPinnedLookup(
          'pinned.test',
          [{ address: VALIDATED_IP, family: 4 }],
          rebindingLookup,
        ),
      } as never,
    });
    const res = await request(`http://pinned.test:${port}/`, { dispatcher: agent });
    const body = await res.body.text();
    expect(body).toBe('validated');
    expect(hits.validated).toBe(before.validated + 1);
    expect(hits.attacker).toBe(before.attacker); // the attacker got nothing
    await agent.close();
  });
});
