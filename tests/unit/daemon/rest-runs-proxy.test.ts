import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHandle, removeHandle, setMyInstanceId } from '../../../src/studio/handle.js';
import {
  resolveRunsOwner,
  proxyRunsRequest,
  RUNS_PROXY_HOP_HEADER,
} from '../../../src/daemon/rest/runs-owner.js';
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

/** The daemon side: one route that hands everything to the proxy under test. */
function startProxyServer(streaming: boolean): Promise<number> {
  proxy = http.createServer((req, res) => {
    void proxyRunsRequest(req, res, {
      target: { endpoint: `http://127.0.0.1:${upstreamPort}`, token: 'host-token' },
      path: req.url ?? '/',
      method: req.method ?? 'GET',
      streaming,
      sendError: (e: HttpError) => {
        if (res.headersSent) return;
        res.writeHead(e.status, { 'Content-Type': 'application/json', ...e.headers });
        res.end(JSON.stringify(e.body));
      },
    });
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

function publishHandle(instanceId: string, endpoint = `http://127.0.0.1:${upstreamPort}`): void {
  writeHandle({ id: 'session-1', endpoint, token: 'host-token', pid: 4242, instanceId }, dataDir);
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
