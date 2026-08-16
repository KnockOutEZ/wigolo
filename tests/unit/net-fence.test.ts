import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
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
      expect(destinationOf([{ host, port: 8080 }])).toEqual({ kind: 'inet', host, port: 8080 });
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
    expect(destinationOf(['/tmp/some.sock'])).toEqual({ kind: 'unix' });
    expect(destinationOf([{ path: '/tmp/some.sock' }])).toEqual({ kind: 'unix' });
    // The normalized form Node actually produces for BOTH unix spellings.
    expect(destinationOf([[{ path: '/tmp/some.sock' }, null]])).toEqual({ kind: 'unix' });
  });

  it('keeps the implicit-localhost default ONLY where Node itself defaults it', () => {
    // `net.connect({port})` genuinely connects to loopback, so this default is correct. It is the
    // same default that, applied to an UNRECOGNIZED shape, opened the hole fixed above — the
    // difference is that here the shape was positively recognized as inet first.
    expect(destinationOf([[{ port: 8080 }, null]])).toEqual({ kind: 'inet', host: 'localhost', port: 8080 });
    expect(destinationOf([8080])).toEqual({ kind: 'inet', host: 'localhost', port: 8080 });
  });
});

/**
 * Regression rows for the arg shapes Node ACTUALLY passes to `Socket.prototype.connect`.
 *
 * Every literal below was dumped from a real call of the named transport, not written to match
 * `destinationOf`. That distinction is the whole point: the first version of this fence was
 * tested only against hand-built `{host, port}` objects, so it never saw the `[options, cb]`
 * array that `net.connect`, `net.createConnection` and all of `node:http` really use — and those
 * three egressed for real, silently, with the fence installed and reporting clean.
 */
describe('network fence — real connect arg shapes', () => {
  afterEach(() => {
    resetNetworkViolations();
  });

  const PUBLIC_SHAPES: ReadonlyArray<[string, unknown[]]> = [
    ["net.connect(443,'example.com')", [[{ port: 443, host: 'example.com' }, null]]],
    ['net.createConnection({host,port})', [[{ host: 'example.com', port: 443 }, null]]],
    ["new net.Socket().connect(443,'example.com')", [443, 'example.com']],
    ['new net.Socket().connect({host,port})', [{ host: 'example.com', port: 443 }]],
    // `node:http` carries `hostname` alongside `host`; cdp-client.ts uses exactly this call form.
    [
      'http.get(url,{timeout},cb) — the src/fetch/cdp-client.ts shape',
      [[{ protocol: 'http:', hostname: 'example.com', port: 80, host: 'example.com', timeout: 5000 }, () => {}]],
    ],
    ["tls.connect(443,'example.com')", [{ port: 443, host: 'example.com', servername: 'example.com' }, () => {}]],
  ];

  it.each(PUBLIC_SHAPES)('classifies %s as a public destination', (_label, args) => {
    const target = destinationOf(args as unknown[]);
    expect(target).toMatchObject({ kind: 'inet', host: 'example.com' });
  });

  it.each(PUBLIC_SHAPES)('FIRES on %s through the real patched connect', (_label, args) => {
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    expect(() =>
      (socket.connect as unknown as (...a: unknown[]) => unknown)(...(args as unknown[])),
    ).toThrow(/\[net-fence\]/);
    expect(networkViolations().map((v) => v.host)).toEqual(['example.com']);
  });
});

/**
 * End-to-end controls, driving the REAL transports rather than replaying dumped literals.
 *
 * The dumped-shape rows above and these are deliberately not redundant: the rows pin the
 * classifier against shapes captured today, and these catch the case where a future Node changes
 * the shape underneath them. Both were silent before the arg-shape fix — the reviewer confirmed
 * `node:http.get` returning a real 200 and `net.connect` completing a real TCP connection with
 * the fence installed. Nothing egresses now: the fence throws before any resolution happens.
 */
describe('network fence — real transports, end to end', () => {
  afterEach(() => {
    resetNetworkViolations();
  });

  it('fires on node:http.get, which passes the normalized array form', async () => {
    await new Promise<void>((resolve) => {
      try {
        const req = http.get('http://example.com/', () => resolve());
        req.on('error', () => resolve());
      } catch {
        resolve();
      }
    });
    expect(networkViolations().map((v) => `${v.host}:${v.port}`)).toEqual(['example.com:80']);
  });

  it('fires on net.connect, which also passes the normalized array form', () => {
    expect(() => net.connect(443, 'example.com').on('error', () => undefined)).toThrow(/\[net-fence\]/);
    expect(networkViolations().map((v) => v.host)).toEqual(['example.com']);
  });

  it('fires on net.createConnection', () => {
    expect(() =>
      net.createConnection({ host: 'example.com', port: 443 }).on('error', () => undefined),
    ).toThrow(/\[net-fence\]/);
    expect(networkViolations().map((v) => v.host)).toEqual(['example.com']);
  });

  it('still lets a real loopback server through on those same transports', async () => {
    // The must-not-fire half of the same change: unwrapping arrays must not start blocking the
    // local servers the REST suites stand up, which arrive by exactly this code path.
    const server = http.createServer((_req, res) => res.end('ok'));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as net.AddressInfo).port;

    const body = await new Promise<string>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          let out = '';
          res.on('data', (c) => (out += c));
          res.on('end', () => resolve(out));
        })
        .on('error', reject);
    });
    server.close();
    await once(server, 'close');

    expect(body).toBe('ok');
    expect(networkViolations()).toEqual([]);
  });
});

/**
 * The reserved-literal allowance, and the line that keeps it from reintroducing the defect.
 *
 * Two suites in the full run connect to reserved addresses ON PURPOSE — `192.0.2.1` to force a
 * timeout, `10.0.0.5` to prove an SSRF hop is attempted — so "loopback only" was too narrow. The
 * widened predicate must admit those WITHOUT admitting anything that can resolve.
 */
describe('network fence — reserved literals pass, names never do', () => {
  afterEach(() => {
    resetNetworkViolations();
  });

  it.each([
    ['TEST-NET-1, used by proxy.test.ts to force a timeout', '192.0.2.1'],
    ['TEST-NET-2', '198.51.100.7'],
    ['TEST-NET-3', '203.0.113.7'],
    ['RFC 1918 /8, used by redirect-guard.test.ts', '10.0.0.5'],
    ['RFC 1918 /12 low', '172.16.0.1'],
    ['RFC 1918 /12 high', '172.31.255.254'],
    ['RFC 1918 /16', '192.168.1.1'],
    ['link-local incl. the metadata endpoint', '169.254.169.254'],
    ['IPv6 unique-local', 'fd00::1'],
    ['IPv6 link-local', 'fe80::1'],
  ])('allows %s', (_label, host) => {
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    expect(() => socket.connect({ host, port: 1 })).not.toThrow();
    socket.destroy();
    expect(networkViolations()).toEqual([]);
  });

  it.each([
    ['a routable public address', '93.184.216.34'],
    ['just outside RFC 1918 /12 low', '172.15.0.1'],
    ['just outside RFC 1918 /12 high', '172.32.0.1'],
    ['a near-miss on 192.168', '192.169.1.1'],
    ['a near-miss on TEST-NET-1', '192.0.3.1'],
  ])('still blocks %s', (_label, host) => {
    expect(() => new net.Socket().connect({ host, port: 443 })).toThrow(/\[net-fence\]/);
    expect(networkViolations()).toHaveLength(1);
  });

  it('NEVER allows a hostname, however reserved-looking — this is what keeps the widening safe', () => {
    // The defect is a result that depends on NAME RESOLUTION reaching the internet. Only literal
    // addresses are allowed above, so no allowance here can cause a DNS query. A name that merely
    // LOOKS internal is still a name, and still resolves through whatever the runner's resolver
    // decides — which is precisely the host-dependence being fenced.
    for (const host of ['internal', 'private.example.com', 'metadata.google.internal', '10-0-0-5.example.com']) {
      expect(() => new net.Socket().connect({ host, port: 80 })).toThrow(/\[net-fence\]/);
      resetNetworkViolations();
    }
  });
});

describe('network fence — unrecognized shapes fail CLOSED', () => {
  afterEach(() => {
    resetNetworkViolations();
  });

  it.each([
    ['an object with no host, hostname, port or path', [{ foo: 'bar' }]],
    ['an empty object', [{}]],
    ['no arguments at all', []],
    ['a null first argument', [null]],
    ['a boolean first argument', [true]],
  ])('treats %s as unknown rather than as loopback', (_label, args) => {
    const target = destinationOf(args as unknown[]);
    expect(target.kind).toBe('unknown');
  });

  it('records and throws on an unclassifiable connect, naming why it could not be judged', () => {
    // The direction that matters. Before the fix an unrecognized shape defaulted to 'localhost'
    // and took the pass-through branch, so a shape the fence did not understand became a shape
    // the fence waved through. A guard may refuse to classify; it may not assume harmless.
    const socket = new net.Socket();
    socket.on('error', () => undefined);
    expect(() => (socket.connect as unknown as (...a: unknown[]) => unknown)({ foo: 'bar' })).toThrow(
      /\[net-fence\].*unclassified/,
    );
    expect(networkViolations()).toHaveLength(1);
    expect(networkViolations()[0].detail).toMatch(/no host\/hostname\/port\/path/);
    expect(violationMessage(networkViolations())).toContain('unclassified connect');
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
