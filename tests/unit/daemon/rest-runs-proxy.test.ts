import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHandle, removeHandle, setMyInstanceId } from '../../../src/studio/handle.js';
import {
  resolveRunsOwner,
  proxyRunsRequest,
  RUNS_PROXY_HOP_HEADER,
  type RunsOwner,
} from '../../../src/daemon/rest/runs-owner.js';
import { handleRunsRequest } from '../../../src/daemon/rest/runs.js';
import type { HttpError } from '../../../src/daemon/rest/errors.js';

/**
 * WHY: SD1 mini-spec §6 (A-43-5) gives the run store exactly ONE live owner, because a live SSE
 * tail is fed by an in-process bus and a bus only ever sees appends made in its own process. These
 * rows pin the two halves of that: WHO the request belongs to, and — when it is not us — that the
 * bytes reach the client unchanged.
 *
 * The streaming rows are the load-bearing ones. `proxyToStudioHost` buffers a JSON result and never
 * touches a `ServerResponse`, which is exactly why this could not reuse it; a proxy that
 * re-serialized the frames would still pass a "did the events arrive" assertion while quietly
 * breaking `Last-Event-ID` resume, so the assertion here is on the BYTES.
 */

let dataDir: string;
let upstream: http.Server;
let upstreamPort: number;
let proxy: http.Server;
let proxyPort: number;

/** Every request the upstream saw, so the hop's own headers can be asserted rather than assumed. */
interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
let seen: SeenRequest[] = [];
/** Set per test: what the fake studio host does with the request it receives. */
let upstreamHandler: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: http.Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

/**
 * The daemon side: one route that hands everything to the proxy under test.
 *
 * It pre-reads a POST body and passes it as `body`, because that is what `handleRunsRequest` does
 * and the proxy deliberately never pipes `req` — piping auto-destroys the stream, which breaks the
 * local handler the no-store fallback hands off to.
 */
function startProxyServer(streaming: boolean): Promise<number> {
  proxy = http.createServer((req, res) => {
    const run = (body?: Buffer): void => {
      void proxyRunsRequest(req, res, {
        target: { endpoint: `http://127.0.0.1:${upstreamPort}`, token: 'host-token' },
        path: req.url ?? '/',
        method: req.method ?? 'GET',
        streaming,
        ...(body && body.length > 0 ? { body } : {}),
        sendError: (e: HttpError) => {
          if (res.headersSent) return;
          res.writeHead(e.status, { 'Content-Type': 'application/json', ...e.headers });
          res.end(JSON.stringify(e.body));
        },
      });
    };
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => run(Buffer.concat(chunks)));
    } else {
      run();
    }
  });
  return listen(proxy);
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function call(opts: { method?: string; path: string; headers?: Record<string, string>; body?: string; port?: number }): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port ?? proxyPort,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { Connection: 'close', ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => req.destroy(new Error('client timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-runs-owner-'));
  seen = [];
  upstreamHandler = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  };
  upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      upstreamHandler(req, res, body);
    });
  });
  upstreamPort = await listen(upstream);
});

afterEach(async () => {
  setMyInstanceId(null);
  await close(proxy);
  await close(upstream);
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * `pid` defaults to THIS process, which is the only pid a test can be certain is alive. A literal
 * like 4242 would make every proxy row depend on whether that pid happens to exist on the machine.
 */
function publishHandle(
  instanceId: string,
  endpoint = `http://127.0.0.1:${upstreamPort}`,
  pid = process.pid,
): void {
  writeHandle({ id: 'session-1', endpoint, token: 'host-token', pid, instanceId }, dataDir);
}

/** A pid that is definitely gone: spawn something, let it exit, keep the number. */
async function deadPid(): Promise<number> {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return child.pid as number;
}

describe('resolveRunsOwner — who owns the live run store for this request', () => {
  it('serves in-process when no studio handle is published', () => {
    removeHandle(dataDir);
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
  });

  it('proxies to the published host when the handle is a foreign live process', () => {
    publishHandle('host-instance-abc');
    expect(resolveRunsOwner(dataDir)).toEqual({
      kind: 'proxy',
      endpoint: `http://127.0.0.1:${upstreamPort}`,
      token: 'host-token',
    });
  });

  it('serves in-process when the handle points at THIS process — the host never proxies to itself', () => {
    publishHandle('host-instance-abc');
    setMyInstanceId('host-instance-abc');
    // Not a refusal: when the handle is mine I AM the one live owner, so the correct answer is to
    // serve the store I hold. Refusing (as the studio_* dispatch does) would 5xx the host's own
    // REST surface; proxying would be the loop this guard exists to prevent.
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
  });

  it('proxies when the published handle belongs to a different host instance than mine', () => {
    publishHandle('host-instance-abc');
    setMyInstanceId('some-other-instance');
    expect(resolveRunsOwner(dataDir).kind).toBe('proxy');
  });

  it('serves in-process when the handle’s process is gone — a killed host leaves its handle behind', async () => {
    // Nothing removes the file when a host dies, and the run log outlives it. Without this, a fresh
    // daemon started after the app was killed 502s every run request against a stale pointer.
    publishHandle('host-instance-abc', `http://127.0.0.1:${upstreamPort}`, await deadPid());
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
  });

  it('still proxies when the handle’s process is alive', () => {
    publishHandle('host-instance-abc', `http://127.0.0.1:${upstreamPort}`, process.pid);
    expect(resolveRunsOwner(dataDir).kind).toBe('proxy');
  });

  it('proxies when the handle carries no usable pid — the check may only ADD a local branch', () => {
    // Read in the negative direction only. An absent or nonsense pid is not evidence of death, and
    // treating it as such would let a malformed field quietly take the wheel back from a live host.
    for (const pid of [0, -1, Number.NaN]) {
      publishHandle('host-instance-abc', `http://127.0.0.1:${upstreamPort}`, pid);
      expect(resolveRunsOwner(dataDir).kind).toBe('proxy');
    }
  });

  it('serves in-process when the handle names no usable endpoint rather than guessing one', () => {
    // `readHandle` only type-checks the field, so a truncated or half-written handle arrives here
    // as a blank string. A handle that cannot name a host does not name an owner — routing to it
    // would 502 every run request for as long as the file sat there.
    publishHandle('host-instance-abc', '');
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
    publishHandle('host-instance-abc', 'not a url');
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
    publishHandle('host-instance-abc', 'file:///etc/passwd');
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
  });

  /**
   * WHY: the hop sends the handle's bearer token — and the caller's `Last-Event-ID` — to whatever
   * host the handle names. The owner is by definition a process on this machine, since it is what
   * wrote the handle, so an endpoint elsewhere cannot be the owner; it can only be a destination for
   * a credential. Writing the handle needs the same UID already, so this is depth rather than a
   * boundary — but the constraint is free, and "the owner is on this machine" is then a thing we
   * know rather than a thing we hope.
   *
   * The addresses below are RFC 5737 documentation ranges, which are never assigned to a real
   * interface — a plausible-looking LAN literal could be this machine's own on some runner, and the
   * row would then assert nothing.
   */
  it('serves in-process when the handle names a host that is not this machine', () => {
    publishHandle('host-instance-abc', 'http://192.0.2.10:9310');
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
    publishHandle('host-instance-abc', 'https://collector.example.com/v1');
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
    // No DNS, on purpose: a name is not an address of this machine, and resolving one would put the
    // answer in the hands of a resolver the handle's writer may control.
    publishHandle('host-instance-abc', 'http://localhost.evil.example:9310');
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
    publishHandle('host-instance-abc', 'http://[2001:db8::5]:9310');
    expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'local' });
  });

  /**
   * The must-not-fire half. `--allow-remote` is a supported studio bind, and the handle it publishes
   * then names a routable address of this machine or the wildcard it bound — that host is still the
   * one live owner, and a fence that refused it would split the live fan-out A-43-5 exists to close.
   */
  it('still proxies to every address that names this machine — the fence must not eat the real host', () => {
    const local = Object.values(networkInterfaces())
      .flatMap((addrs) => addrs ?? [])
      .filter((a) => !a.internal)
      .map((a) => (a.family === 'IPv6' ? `[${a.address.split('%')[0]}]` : a.address));
    for (const host of ['127.0.0.1', 'localhost', '[::1]', '127.8.9.10', '0.0.0.0', ...local.slice(0, 2)]) {
      const endpoint = `http://${host}:${upstreamPort}`;
      publishHandle('host-instance-abc', endpoint);
      expect(resolveRunsOwner(dataDir)).toEqual({ kind: 'proxy', endpoint, token: 'host-token' });
    }
  });
});

describe('proxyRunsRequest — the raw hop to the live owner', () => {
  it('forwards method, path, query and body, and relays the upstream status and JSON verbatim', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Run-Owner': 'host' });
      res.end(JSON.stringify({ ok: true, run: { id: 'c29x', task: 'compare monitors' } }));
    };
    proxyPort = await startProxyServer(false);

    const r = await call({
      method: 'POST',
      path: '/v1/runs?spaceId=work',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: 'compare monitors' }),
    });

    expect(r.status).toBe(201);
    expect(JSON.parse(r.body)).toEqual({ ok: true, run: { id: 'c29x', task: 'compare monitors' } });
    expect(r.headers['x-run-owner']).toBe('host');
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/v1/runs?spaceId=work');
    expect(JSON.parse(seen[0].body)).toEqual({ task: 'compare monitors' });
  });

  it('authenticates the hop with the handle token and never forwards the caller’s own credential', async () => {
    proxyPort = await startProxyServer(false);
    await call({ path: '/v1/runs', headers: { Authorization: 'Bearer caller-secret' } });

    // The daemon already authenticated the caller; the upstream hop is authenticated by the handle
    // token. Passing the caller's bearer through would offer the host a credential minted for a
    // different surface, which is a widening nobody asked for.
    expect(seen[0].headers.authorization).toBe('Bearer host-token');
    expect(seen[0].headers.authorization).not.toContain('caller-secret');
  });

  it('forwards Last-Event-ID so a resume across the hop resumes at the client’s seq', async () => {
    proxyPort = await startProxyServer(true);
    await call({ path: '/v1/runs/c29x/events', headers: { 'Last-Event-ID': '3', Accept: 'text/event-stream' } });
    expect(seen[0].headers['last-event-id']).toBe('3');
    expect(seen[0].headers.accept).toBe('text/event-stream');
  });

  it('streams SSE through byte-for-byte, preserving id/event/data framing', async () => {
    const wire =
      'retry: 3000\n\n'
      + 'id: 4\nevent: run.note\ndata: {"seq":4,"type":"run.note"}\n\n'
      + ': ping\n\n'
      + 'id: 5\nevent: run.done\ndata: {"seq":5,"type":"run.done"}\n\n';
    upstreamHandler = (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      });
      // Written in three chunks: a proxy that re-framed on chunk boundaries would fail the byte
      // comparison below, which is the whole point of piping rather than parsing.
      res.write(wire.slice(0, 20));
      res.write(wire.slice(20, 60));
      setTimeout(() => { res.write(wire.slice(60)); res.end(); }, 20);
    };
    proxyPort = await startProxyServer(true);

    const r = await call({ path: '/v1/runs/c29x/events', headers: { Accept: 'text/event-stream' } });

    expect(r.status).toBe(200);
    expect(r.body).toBe(wire);
    expect(r.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(r.headers['cache-control']).toBe('no-cache, no-transform');
    expect(r.headers['x-accel-buffering']).toBe('no');
  });

  it('drops hop-by-hop headers instead of relaying a directive about a socket that is not the client’s', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        Upgrade: 'h2c',
        Trailer: 'X-Nope',
        TE: 'trailers',
        'X-Run-Owner': 'host',
      });
      res.end('{"ok":true}');
    };
    proxyPort = await startProxyServer(false);
    const r = await call({ path: '/v1/runs' });

    // Each of these describes the hop between this daemon and the owner. Relaying them tells the
    // client about a connection it does not have — and `Upgrade` in particular invites it to
    // renegotiate a protocol on a socket the owner never saw.
    expect(r.headers.upgrade).toBeUndefined();
    expect(r.headers.trailer).toBeUndefined();
    expect(r.headers.te).toBeUndefined();
    // End-to-end headers are untouched: the filter is a hop-by-hop list, not a general scrub.
    expect(r.headers['x-run-owner']).toBe('host');
    expect(JSON.parse(r.body)).toEqual({ ok: true });
  });

  it('answers an unreachable owner with structured JSON rather than a hung stream', async () => {
    // Close the upstream first so the connect is refused — the stale-handle case.
    await close(upstream);
    proxy = http.createServer((req, res) => {
      void proxyRunsRequest(req, res, {
        target: { endpoint: `http://127.0.0.1:${upstreamPort}`, token: 'host-token' },
        path: req.url ?? '/',
        method: 'GET',
        streaming: true,
        sendError: (e: HttpError) => {
          res.writeHead(e.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(e.body));
        },
      });
    });
    proxyPort = await listen(proxy);

    const r = await call({ path: '/v1/runs/c29x/events' });
    expect(r.status).toBe(502);
    const body = JSON.parse(r.body) as { ok: boolean; error_reason: string; hint?: string };
    expect(body.ok).toBe(false);
    expect(body.error_reason).toBe('studio_host_unreachable');
    // Never a silent fall back to the local store: two live owners is the exact split fan-out the
    // ownership rule exists to prevent, and a refused connect cannot tell "dead" from "busy".
    expect(body.hint).toBeTruthy();
    // Re-created so afterEach's close() has something to close.
    upstream = http.createServer();
    upstreamPort = await listen(upstream);
  });

  it('refuses a request that already carries the hop marker instead of looping', async () => {
    proxyPort = await startProxyServer(false);
    const r = await call({ path: '/v1/runs', headers: { [RUNS_PROXY_HOP_HEADER]: '1' } });
    expect(r.status).toBe(502);
    expect((JSON.parse(r.body) as { error_reason: string }).error_reason).toBe('studio_host_proxy_loop');
    // A forged marker can only fail the forger's own request — it can never downgrade the route to
    // the local store, which would be the split fan-out an attacker-writable predicate would buy.
    expect(seen).toHaveLength(0);
  });

  it('marks the hop so the next process can see it is already a proxied request', async () => {
    proxyPort = await startProxyServer(false);
    await call({ path: '/v1/runs' });
    expect(seen[0].headers[RUNS_PROXY_HOP_HEADER]).toBe('1');
  });

  it('tears the upstream request down when the client disconnects mid-stream', async () => {
    let upstreamClosed = false;
    upstreamHandler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('id: 1\nevent: run.created\ndata: {"seq":1}\n\n');
      req.on('close', () => { upstreamClosed = true; });
    };
    proxyPort = await startProxyServer(true);

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port: proxyPort, path: '/v1/runs/c29x/events', headers: { Accept: 'text/event-stream' } },
        (res) => {
          res.on('data', () => req.destroy());
          res.on('error', () => { /* our own destroy */ });
          resolve();
        },
      );
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      req.end();
    });

    const deadline = Date.now() + 5000;
    while (!upstreamClosed && Date.now() < deadline) {
      await new Promise<void>((r) => setTimeout(r, 25));
    }
    // A dropped client that leaves the hop alive leaks a socket per reconnect on the host — the
    // long-lived tail makes that a slow exhaustion rather than a visible failure.
    expect(upstreamClosed).toBe(true);
  });
});

/**
 * WHY: the hop runs over Node's keep-alive pool, so a `Content-Length` describing a body the hop
 * never writes does not fail the request that carried it — the owner's parser is simply left
 * waiting for bytes on a socket that goes straight back into the pool. The NEXT request over that
 * socket is the casualty: its opening bytes are swallowed as the previous request's body and what
 * remains is not a request line. That makes one crafted read a denial primitive against an
 * unrelated caller, which in the default local posture (loopback, no API token) is any process on
 * the machine. The framing of the hop is ours to state, never the client's.
 */
describe('request framing across the hop', () => {
  /**
   * An owner that answers without draining the request body — the ordinary shape for a GET handler,
   * and the one that leaves the announced bytes pending on the socket.
   */
  function startBodylessOwner(seenReqs: SeenRequest[], sockets: number[], clientErrors: string[]): Promise<number> {
    const owner = http.createServer((req, res) => {
      seenReqs.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
      sockets.push(req.socket.remotePort ?? 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    // Replaces Node's default handler, so the socket has to be destroyed here. A parser error is the
    // symptom the desync produces, and it is invisible from the client side without this.
    owner.on('clientError', (err, socket) => {
      clientErrors.push((err as NodeJS.ErrnoException).code ?? String(err));
      socket.destroy();
    });
    // Adopted as the suite's upstream so the shared teardown closes it.
    upstream = owner;
    return listen(owner);
  }

  it('never relays the client’s content-length onto a bodyless proxied request', async () => {
    const ownerSeen: SeenRequest[] = [];
    const ownerSockets: number[] = [];
    const clientErrors: string[] = [];
    await close(upstream);
    upstreamPort = await startBodylessOwner(ownerSeen, ownerSockets, clientErrors);
    proxyPort = await startProxyServer(false);

    // The crafted read: a GET with no body that claims to carry 40 bytes. The proxy's own answer is
    // fine — the damage is deferred to whoever gets the socket next.
    const first = await call({ path: '/v1/runs/aaa', headers: { 'Content-Length': '40' } });
    expect(first.status).toBe(200);

    // The victim: an unrelated request the owner must see whole.
    const second = await call({ path: '/v1/runs/bbb' });

    expect(ownerSeen.map((r) => r.url)).toEqual(['/v1/runs/aaa', '/v1/runs/bbb']);
    expect(clientErrors).toEqual([]);
    expect(second.status).toBe(200);
    expect(JSON.parse(second.body)).toEqual({ ok: true });
    // Both hops shared one pooled socket. Without that the desync has nowhere to land and the rows
    // above would pass on a bug they never exercised.
    expect(new Set(ownerSockets).size).toBe(1);
    // The cause, stated directly: our hop describes its own framing, never the client's.
    expect(ownerSeen[0]?.headers['content-length']).toBeUndefined();
  });
});

describe('handleRunsRequest — the ownership branch', () => {
  /** A runs surface whose store access is observable, so "did not touch it" is an assertion. */
  function startRunsServer(owner: RunsOwner): Promise<{ port: number; dbOpens: () => number }> {
    let opens = 0;
    proxy = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleRunsRequest(req, res, {
        pathname: url.pathname,
        method: req.method ?? 'GET',
        url,
        respond: (status, body, headers) => {
          res.writeHead(status, { 'Content-Type': 'application/json', ...(headers ?? {}) });
          res.end(JSON.stringify(body));
        },
        sendError: (e: HttpError) => {
          if (res.headersSent) return;
          res.writeHead(e.status, { 'Content-Type': 'application/json', ...e.headers });
          res.end(JSON.stringify(e.body));
        },
        openDb: () => { opens++; throw new Error('the store must not be opened on the proxy path'); },
        resolveOwner: () => owner,
      });
    });
    return listen(proxy).then((port) => ({ port, dbOpens: () => opens }));
  }

  it('sends the request to the live owner and never opens its own store', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, run: { id: 'c29x' } }));
    };
    const { port, dbOpens } = await startRunsServer({
      kind: 'proxy',
      endpoint: `http://127.0.0.1:${upstreamPort}`,
      token: 'host-token',
    });

    const r = await call({ method: 'POST', path: '/v1/runs', port, body: '{"task":"x"}', headers: { 'Content-Type': 'application/json' } });

    expect(r.status).toBe(201);
    expect((JSON.parse(r.body) as { run: { id: string } }).run.id).toBe('c29x');
    // The daemon HAS a usable store here — that is the trap. Writing into it beside a live owner is
    // the double-append whose live tails fan out separately.
    expect(dbOpens()).toBe(0);
    expect(seen[0].url).toBe('/v1/runs');
  });

  it('proxies the SSE tail as a stream, not as a buffered result', async () => {
    const wire = 'id: 7\nevent: run.note\ndata: {"seq":7}\n\n';
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.end(wire);
    };
    const { port } = await startRunsServer({
      kind: 'proxy',
      endpoint: `http://127.0.0.1:${upstreamPort}`,
      token: 'host-token',
    });

    const r = await call({ path: '/v1/runs/c29x/events', port, headers: { Accept: 'text/event-stream' } });
    expect(r.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(r.body).toBe(wire);
  });

  it('still refuses a route that is not a run route before consulting the owner', async () => {
    const { port } = await startRunsServer({
      kind: 'proxy',
      endpoint: `http://127.0.0.1:${upstreamPort}`,
      token: 'host-token',
    });
    const r = await call({ path: '/v1/runs/c29x/events/extra', port });
    expect(r.status).toBe(404);
    // Shape errors are answered here rather than turned into traffic the owner has to reject too.
    expect(seen).toHaveLength(0);
  });
});

/**
 * WHY THIS BRANCH EXISTS, and why it is not the fall-back A-70-1 forbids.
 *
 * A-70-1 refuses to fall back on an UNREACHABLE owner, because a refused connect cannot tell "dead"
 * from "busy" and guessing wrong splits the live tail. A `503 store_unavailable` is the opposite
 * kind of signal: a live, authenticated process stating what it is. The app's gateway sends exactly
 * that today — it has no native store, and it appends through the broker child, so it can neither
 * serve a run nor fan one out.
 *
 * This was not reasoned into existence. The first version of this change had no such branch, and CI
 * red on seven `apps/studio` e2e rows: the SD1 exit gate runs a daemon child beside the real app,
 * and every `/v1/runs` call it made started returning the app's 503.
 */
describe('an owner that declares it holds no store', () => {
  let db: Database.Database;

  beforeEach(() => {
    _resetMigrationGuard();
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
  });

  afterEach(() => db.close());

  function startRunsServer(): Promise<{ port: number; dbOpens: () => number }> {
    let opens = 0;
    proxy = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleRunsRequest(req, res, {
        pathname: url.pathname,
        method: req.method ?? 'GET',
        url,
        respond: (status, body, headers) => {
          res.writeHead(status, { 'Content-Type': 'application/json', ...(headers ?? {}) });
          res.end(JSON.stringify(body));
        },
        sendError: (e: HttpError) => {
          if (res.headersSent) return;
          res.writeHead(e.status, { 'Content-Type': 'application/json', ...e.headers });
          res.end(JSON.stringify(e.body));
        },
        openDb: () => { opens++; return db; },
        resolveOwner: () => ({ kind: 'proxy', endpoint: `http://127.0.0.1:${upstreamPort}`, token: 'host-token' }),
      });
    });
    return listen(proxy).then((port) => ({ port, dbOpens: () => opens }));
  }

  function declineWith(reason: string, status = 503): void {
    upstreamHandler = (_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'nope', error_reason: reason }));
    };
  }

  it('serves the request itself — a process with no store is not an owner', async () => {
    declineWith('store_unavailable');
    const { port, dbOpens } = await startRunsServer();

    const r = await call({ path: '/v1/runs', port });

    expect(r.status).toBe(200);
    expect((JSON.parse(r.body) as { ok: boolean }).ok).toBe(true);
    expect(dbOpens()).toBe(1);
    // The hop was still attempted — the fallback is a response to what the owner SAID, never a
    // shortcut around asking it.
    expect(seen).toHaveLength(1);
  });

  it('creates the run locally with the body the caller sent, not an empty one', async () => {
    declineWith('store_unavailable');
    const { port } = await startRunsServer();

    const r = await call({
      method: 'POST',
      path: '/v1/runs',
      port,
      body: JSON.stringify({ task: 'the body has to survive the hop' }),
      headers: { 'Content-Type': 'application/json' },
    });

    expect(r.status).toBe(201);
    // A request stream can be consumed once. Without the pre-read, this create reads an empty body
    // and 400s on a task the caller definitely sent.
    expect((JSON.parse(r.body) as { run: { task: string } }).run.task).toBe('the body has to survive the hop');
    // And the owner really did see it, byte-equal in meaning.
    expect(JSON.parse(seen[0].body)).toEqual({ task: 'the body has to survive the hop' });
  });

  it('relays any OTHER 503 as the client’s answer rather than taking the wheel', async () => {
    // "I am temporarily unavailable" is not "I am not a store owner". Treating them alike would let
    // a busy owner hand this daemon the wheel, which is the split fan-out A-70-1 forbids.
    declineWith('too_many_requests');
    const { port, dbOpens } = await startRunsServer();

    const r = await call({ path: '/v1/runs', port });
    expect(r.status).toBe(503);
    expect((JSON.parse(r.body) as { error_reason: string }).error_reason).toBe('too_many_requests');
    expect(dbOpens()).toBe(0);
  });

  it('relays a non-503 refusal untouched', async () => {
    declineWith('store_unavailable', 500);
    const { port, dbOpens } = await startRunsServer();

    const r = await call({ path: '/v1/runs', port });
    // The reason string is not the trigger on its own — the status is half the predicate.
    expect(r.status).toBe(500);
    expect(dbOpens()).toBe(0);
  });

  it('relays a 503 whose body is not an error envelope', async () => {
    upstreamHandler = (_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      res.end('gateway is sad');
    };
    const { port, dbOpens } = await startRunsServer();

    const r = await call({ path: '/v1/runs', port });
    expect(r.status).toBe(503);
    expect(r.body).toBe('gateway is sad');
    expect(dbOpens()).toBe(0);
  });

  it('falls back on the SSE tail too, so a tail is never 503ed by a storeless owner', async () => {
    declineWith('store_unavailable');
    const { port } = await startRunsServer();
    const { createRunWithTail } = await import('../../../src/studio/run-bus.js');
    const run = createRunWithTail(db, { task: 'tail me' });

    // A healthy tail never ends, so this reads until the birth event lands and then hangs up. The
    // one-shot helper would wait for an 'end' that a working stream is designed never to send —
    // and an earlier version of this row PASSED its status assertion for exactly that reason: the
    // response had ended with no headers at all, and `statusCode` reads 200 when nothing wrote one.
    const seenBytes = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: `/v1/runs/${run.id}/events`, headers: { Accept: 'text/event-stream' } },
        (res) => {
          let body = '';
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            body += chunk;
            if (body.includes('id: 1')) {
              req.destroy();
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
            }
          });
          res.on('error', () => { /* our own destroy */ });
        },
      );
      req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      req.setTimeout(8000, () => req.destroy(new Error('no SSE frame arrived')));
      req.end();
    });

    expect(seenBytes.status).toBe(200);
    expect(seenBytes.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(seenBytes.body).toContain('id: 1');
    expect(seenBytes.body).toContain('event: run.created');
  });
});
