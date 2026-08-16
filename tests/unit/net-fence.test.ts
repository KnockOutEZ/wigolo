import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import { once } from 'node:events';
import {
  ALLOW_NETWORK_ENV,
  allowNetworkInThisFile,
  callSiteOf,
  destinationOf,
  networkViolations,
  resetNetworkViolations,
  violationMessage,
} from '../net-fence.js';

/**
 * A guard nobody has seen fire is indistinguishable from a guard that cannot fire, so the
 * fence's own suite is built around one question: does it FIRE, and does it stay silent on the
 * traffic the suite legitimately produces?
 *
 * The fence is already installed process-wide by `tests/setup.ts`, so these tests exercise the
 * real patched `net.Socket.prototype.connect` rather than a re-implementation. Every case that
 * deliberately trips it clears the recorder before returning — otherwise setup's `afterEach`
 * would (correctly) red the very test that proved the fence works.
 */

describe('network fence — must FIRE', () => {
  afterEach(() => {
    resetNetworkViolations();
  });

  it('blocks and records a direct connect to a public host, without resolving it', () => {
    const socket = new net.Socket();
    expect(() => socket.connect(443, 'stackoverflow.com')).toThrow(/\[net-fence\].*stackoverflow\.com:443/);
    expect(networkViolations()).toHaveLength(1);
    expect(networkViolations()[0]).toMatchObject({ host: 'stackoverflow.com', port: 443 });
  });

  it('blocks the options form, which is what undici and the http/tls stack actually call', () => {
    const socket = new net.Socket();
    expect(() => socket.connect({ host: 'example.com', port: 80 })).toThrow(/example\.com:80/);
    expect(networkViolations()).toHaveLength(1);
  });

  it('RECORDS even when the caller swallows the throw — the property a bare throw does not have', async () => {
    // This is the case that makes the recorder load-bearing rather than decorative. `SmartRouter`
    // catches a failing tier and escalates, and `httpFetch` wraps undici's failure as
    // `TypeError: fetch failed`. A fence that only threw would be absorbed at exactly those
    // seams and the test would go green having measured the host — the defect, not the fix.
    let swallowed = false;
    try {
      new net.Socket().connect(443, 'arxiv.org');
    } catch {
      swallowed = true;
    }
    expect(swallowed).toBe(true);
    expect(networkViolations().map((v) => v.host)).toEqual(['arxiv.org']);
  });

  it('names the destination and a remedy in the failure text, so the red does not read as flake', () => {
    try {
      new net.Socket().connect(443, 'react.dev');
    } catch {
      /* recorded */
    }
    const message = violationMessage(networkViolations());
    expect(message).toContain('react.dev:443');
    expect(message).toContain('depend on the machine it ran on');
    expect(message).toContain(ALLOW_NETWORK_ENV);
  });

  it('records every distinct destination a single test reaches for', () => {
    for (const host of ['a.example.com', 'b.example.com']) {
      try {
        new net.Socket().connect(443, host);
      } catch {
        /* recorded */
      }
    }
    expect(networkViolations().map((v) => v.host)).toEqual(['a.example.com', 'b.example.com']);
  });
});

describe('network fence — must NOT fire', () => {
  afterEach(() => {
    // A control that silently recorded something would make the whole suite meaningless, so
    // assert emptiness here rather than clearing it.
    expect(networkViolations()).toEqual([]);
  });

  it('lets a loopback connection through and completes it end to end', async () => {
    // The strongest control available: a REAL server, a REAL connection, both on loopback. If
    // the fence over-fired here it would break every suite that stands up a local server.
    const server = net.createServer((c) => c.end('ok'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as net.AddressInfo).port;

    const client = new net.Socket();
    client.connect(port, '127.0.0.1');
    await once(client, 'connect');
    client.destroy();
    server.close();
    await once(server, 'close');
  });

  it('treats every spelling of loopback as loopback', () => {
    for (const host of ['localhost', '127.0.0.1', '127.0.0.53', '::1', '[::1]', 'LOCALHOST', 'foo.localhost']) {
      const dest = destinationOf([{ host, port: 8080 }]);
      expect(dest).toEqual({ host, port: 8080 });
      // Routed through the real patched connect: a throw here is the fence over-firing. Port 1
      // will refuse, so the (async, irrelevant) connection error is absorbed rather than left to
      // surface as an unhandled 'error' event.
      const socket = new net.Socket();
      socket.on('error', () => undefined);
      expect(() => socket.connect({ host, port: 1 })).not.toThrow();
      socket.destroy();
    }
  });

  it('ignores unix-socket connects, which have no host to judge', () => {
    expect(destinationOf(['/tmp/some.sock'])).toBeNull();
    expect(destinationOf([{ path: '/tmp/some.sock' }])).toBeNull();
  });
});

describe('network fence — the opt-out', () => {
  beforeEach(() => {
    resetNetworkViolations();
  });
  afterEach(() => {
    delete process.env[ALLOW_NETWORK_ENV];
    resetNetworkViolations();
  });

  it('lets a public destination through when explicitly allowed, and records nothing', () => {
    process.env[ALLOW_NETWORK_ENV] = '1';
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    // TEST-NET-1 (RFC 5737): non-loopback, so the fence would fire without the opt-out, but
    // reserved-unroutable and never resolved — the control cannot itself reach a live host.
    expect(() => socket.connect({ host: '192.0.2.1', port: 1 })).not.toThrow();
    socket.destroy();
    expect(networkViolations()).toEqual([]);
  });

  it('refuses a per-file declaration with no stated reason', () => {
    // The reason is the whole control. An empty one turns the declaration into the thing this
    // fence exists to prevent — silent, unexplained network dependence — so it is rejected at
    // the point of use rather than surviving as a blank string nobody reads.
    expect(() => allowNetworkInThisFile('')).toThrow(/requires a reason/);
    expect(() => allowNetworkInThisFile('   ')).toThrow(/requires a reason/);
  });

  it('names the per-file declaration in the failure text, not only the whole-run env var', () => {
    // A message that offers only the run-wide switch invites the worst remedy available. The
    // per-file declaration must be the one a reader reaches for first.
    const message = violationMessage([{ host: 'x.example.com', port: 443, stack: '' }]);
    expect(message).toContain('allowNetworkInThisFile');
    expect(message).toMatch(/local debugging/);
  });

  it('is not satisfied by a truthy-but-wrong value, so a stray export cannot disable it', () => {
    // `=1` and nothing else. An opt-out that any non-empty value switches off is one an
    // unrelated `export VITEST_WIGOLO_ALLOW_NETWORK=0` would silently apply.
    for (const value of ['0', 'true', 'yes', '']) {
      process.env[ALLOW_NETWORK_ENV] = value;
      expect(() => new net.Socket().connect(443, 'blocked.example.com')).toThrow(/\[net-fence\]/);
      resetNetworkViolations();
    }
  });
});
