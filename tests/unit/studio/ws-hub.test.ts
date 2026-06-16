import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { StudioWsHub, type StudioWsHubOptions } from '../../../src/studio/ws-hub.js';
import { SessionRegistry } from '../../../src/studio/registry.js';

/**
 * Drive the hub over a real loopback WebSocket — the hub completes the handshake
 * and tracks clients, which a fake socket can't exercise honestly. Auth is the
 * daemon's job (tested in http-server.test.ts), so the hub server here is
 * unauthenticated: this isolates hub behavior. No browser involved.
 */
type Hub = Awaited<ReturnType<typeof startHub>>;
const open: Hub[] = [];

async function startHub(opts: StudioWsHubOptions = {}) {
  const hub = new StudioWsHub(opts);
  const server = createServer();
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  const h = {
    hub,
    port,
    url: (path: string) => `ws://127.0.0.1:${port}${path}`,
    close: async () => { hub.closeAll(); await new Promise<void>((r) => server.close(() => r())); },
  };
  open.push(h);
  return h;
}

/** Raw WebSocket handshake — returns the 101 response's negotiated subprotocol header (or undefined). */
function rawUpgrade(port: number, path: string, offeredProtocol: string): Promise<{ statusCode: number; protocolHeader: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Protocol': offeredProtocol,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve({ statusCode: res.statusCode ?? 0, protocolHeader: res.headers['sec-websocket-protocol'] as string | undefined });
    });
    req.on('response', (res) => {
      res.resume();
      resolve({ statusCode: res.statusCode ?? 0, protocolHeader: res.headers['sec-websocket-protocol'] as string | undefined });
    });
    req.on('error', reject);
    req.end();
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (d: WebSocket.RawData) => resolve(JSON.parse(d.toString()))));
}

function waitFor(pred: () => boolean, ms = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); resolve(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('waitFor timeout')); }
    }, 5);
  });
}

afterEach(async () => {
  while (open.length) await open.pop()!.close();
});

describe('StudioWsHub', () => {
  it('registers a client by session id (from the path) and sends a hello on connect', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/sess-1/stream'));
    const hello = await nextMessage(ws);
    expect(hello).toEqual({ t: 'hello', sessionId: 'sess-1' });
    expect(h.hub.clientCount('sess-1')).toBe(1);
    ws.close();
  });

  it('merges helloExtras (initial control state) into the hello message', async () => {
    const h = await startHub({ helloExtras: () => ({ holder: 'agent', epoch: 3 }) });
    const ws = new WebSocket(h.url('/studio/he/stream'));
    const hello = await nextMessage(ws);
    expect(hello).toEqual({ t: 'hello', sessionId: 'he', holder: 'agent', epoch: 3 });
    ws.close();
  });

  it('drops the client from the session on close', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/sess-2/stream'));
    await nextMessage(ws);
    expect(h.hub.clientCount('sess-2')).toBe(1);
    ws.close();
    await waitFor(() => h.hub.clientCount('sess-2') === 0);
    expect(h.hub.clientCount('sess-2')).toBe(0);
  });

  it('broadcast() delivers a message to the session clients', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/sess-3/stream'));
    await nextMessage(ws); // hello
    h.hub.broadcast('sess-3', { t: 'frame', data: 'abc' });
    const frame = await nextMessage(ws);
    expect(frame).toEqual({ t: 'frame', data: 'abc' });
    ws.close();
  });

  it('does not deliver a broadcast to a different session', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/sess-A/stream'));
    await nextMessage(ws);
    // Broadcast to a session this client is not in — it must not arrive.
    let got = false;
    ws.on('message', () => { got = true; });
    h.hub.broadcast('sess-B', { t: 'frame', data: 'x' });
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toBe(false);
    ws.close();
  });

  it('rejects an upgrade whose path has no session id (no registration)', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/not-a-studio-path'));
    let helloSeen = false;
    ws.on('message', () => { helloSeen = true; });
    await new Promise<void>((resolve) => { ws.on('error', () => resolve()); ws.on('close', () => resolve()); });
    expect(helloSeen).toBe(false);
    expect(h.hub.clientCount('not-a-studio-path')).toBe(0);
  });

  it('closeAll() disconnects connected clients', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/sess-Z/stream'));
    await nextMessage(ws);
    const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
    h.hub.closeAll();
    await closed; // resolves only if the server closed the socket
    expect(h.hub.clientCount('sess-Z')).toBe(0);
  });
});

describe('StudioWsHub — lifecycle / leak prevention', () => {
  it('removes a client on ungraceful socket destruction, not just a clean close', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/ug/stream'));
    await nextMessage(ws);
    expect(h.hub.clientCount('ug')).toBe(1);
    ws.terminate(); // hard-kill the socket — no WS close handshake
    await waitFor(() => h.hub.clientCount('ug') === 0);
    expect(h.hub.clientCount('ug')).toBe(0);
  });

  it('reaps a half-open client that stops answering pings (heartbeat)', async () => {
    const h = await startHub({ heartbeatIntervalMs: 40 });
    const ws = new WebSocket(h.url('/studio/dead/stream'));
    await nextMessage(ws);
    expect(h.hub.clientCount('dead')).toBe(1);
    // Silence the client's outgoing frames so its automatic pong never reaches
    // the server — a true half-open peer the OS won't surface as close/error.
    (ws as unknown as { _socket: { write: () => boolean } })._socket.write = () => true;
    await waitFor(() => h.hub.clientCount('dead') === 0, 2000);
    expect(h.hub.clientCount('dead')).toBe(0);
  });

  it('does not reap a live client across heartbeat ticks', async () => {
    const h = await startHub({ heartbeatIntervalMs: 40 });
    const ws = new WebSocket(h.url('/studio/live/stream'));
    await nextMessage(ws);
    await new Promise((r) => setTimeout(r, 220)); // ~5 ticks; the client auto-pongs
    expect(h.hub.clientCount('live')).toBe(1);
    ws.close();
  });

  it('invokes onAttach on connect and onDetach on disconnect, exactly once each', async () => {
    const attaches: string[] = [];
    const detaches: string[] = [];
    const h = await startHub({ onAttach: (id) => attaches.push(id), onDetach: (id) => detaches.push(id) });
    const ws = new WebSocket(h.url('/studio/acct/stream'));
    await nextMessage(ws);
    expect(attaches).toEqual(['acct']);
    ws.terminate(); // close + error may both fire — onDetach must still be once
    await waitFor(() => detaches.length >= 1);
    expect(detaches).toEqual(['acct']);
  });

  it('keeps the Session client count accurate across connect and ungraceful disconnect (concern 1, end-to-end)', async () => {
    // Wired exactly as the host wires it: onAttach/onDetach -> Session.attach/detach.
    const registry = new SessionRegistry();
    const session = registry.create({ endpoint: 'http://127.0.0.1:0', token: 'tok' });
    const h = await startHub({
      onAttach: (id) => registry.get(id)?.attach(),
      onDetach: (id) => registry.get(id)?.detach(),
    });
    const ws = new WebSocket(h.url(`/studio/${session.id}/stream`));
    await nextMessage(ws);
    expect(session.clients).toBe(1);
    ws.terminate(); // ungraceful — must still decrement so the session can idle-evict
    await waitFor(() => session.clients === 0);
    expect(session.clients).toBe(0);
  });

  it('does not echo the offered bearer subprotocol back in the 101 handshake response', async () => {
    // The bearer travels in the REQUEST's Sec-WebSocket-Protocol (how the client
    // authenticates); finding A is that it must not be REFLECTED in the response.
    const h = await startHub();
    const res = await rawUpgrade(h.port, '/studio/np/stream', 'wigolo.bearer.super-secret-token');
    expect(res.statusCode).toBe(101); // upgrade still succeeds (browsers accept no negotiated subprotocol)
    expect(res.protocolHeader).toBeUndefined(); // bearer NOT echoed back on the wire
  });

  it('negotiates the non-secret wigolo.stream when offered alongside the bearer (never echoes the bearer)', async () => {
    const h = await startHub();
    const res = await rawUpgrade(h.port, '/studio/sp/stream', 'wigolo.stream, wigolo.bearer.super-secret-token');
    expect(res.statusCode).toBe(101);
    expect(res.protocolHeader).toBe('wigolo.stream'); // the non-secret one is reflected, not the token
  });
});

describe('StudioWsHub — frame fan-out + ack routing (1b.3)', () => {
  it('broadcastFrame delivers a {t:frame} envelope to a ready client and reports it sent', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/f1/stream'));
    await nextMessage(ws); // hello
    const result = h.hub.broadcastFrame('f1', { data: 'JPEG==', metadata: { pageScaleFactor: 1 } });
    expect(result).toEqual({ sent: 1, dropped: 0 });
    const frame = await nextMessage(ws);
    expect(frame).toEqual({ t: 'frame', data: 'JPEG==', meta: { pageScaleFactor: 1 } });
    ws.close();
  });

  it('drops a frame to a backpressured client (over the buffered-bytes threshold) instead of buffering', async () => {
    // Threshold -1 makes any client (bufferedAmount >= 0) count as backpressured —
    // a deterministic exercise of the drop branch without OS-buffer timing games.
    const h = await startHub({ frameBackpressureBytes: -1 });
    const ws = new WebSocket(h.url('/studio/f2/stream'));
    await nextMessage(ws);
    const result = h.hub.broadcastFrame('f2', { data: 'JPEG==', metadata: {} });
    expect(result).toEqual({ sent: 0, dropped: 1 });
    ws.close();
  });

  it('routes an inbound {t:ack} message to onAck with the session id', async () => {
    const acks: string[] = [];
    const h = await startHub({ onAck: (id) => acks.push(id) });
    const ws = new WebSocket(h.url('/studio/f3/stream'));
    await nextMessage(ws);
    ws.send(JSON.stringify({ t: 'ack' }));
    await waitFor(() => acks.length === 1);
    expect(acks).toEqual(['f3']);
    ws.close();
  });

  it('ignores a malformed inbound message without crashing', async () => {
    const acks: string[] = [];
    const h = await startHub({ onAck: (id) => acks.push(id) });
    const ws = new WebSocket(h.url('/studio/f4/stream'));
    await nextMessage(ws);
    ws.send('not json{{');
    ws.send(JSON.stringify({ t: 'something-else' }));
    await new Promise((r) => setTimeout(r, 40));
    expect(acks).toEqual([]); // no ack fired, no throw
    expect(h.hub.clientCount('f4')).toBe(1); // still connected
    ws.close();
  });

  it('closes a client that exceeds the inbound message-size cap (no 100MiB allocation)', async () => {
    const h = await startHub();
    const ws = new WebSocket(h.url('/studio/big/stream'));
    await nextMessage(ws);
    const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
    ws.send('x'.repeat(70 * 1024)); // > 64 KiB cap → server rejects
    expect(await closed).toBe(1009); // 1009 = message too big
  });

  it('routes inbound {t:input} to onInput with the session id and the raw message', async () => {
    const inputs: Array<{ id: string; msg: Record<string, unknown> }> = [];
    const h = await startHub({ onInput: (id, msg) => inputs.push({ id, msg }) });
    const ws = new WebSocket(h.url('/studio/i1/stream'));
    await nextMessage(ws);
    ws.send(JSON.stringify({ t: 'input', party: 'human', epoch: 0, kind: 'mouse', type: 'mousePressed', nx: 0.5, ny: 0.5 }));
    await waitFor(() => inputs.length === 1);
    expect(inputs[0].id).toBe('i1');
    expect(inputs[0].msg).toMatchObject({ kind: 'mouse', type: 'mousePressed', nx: 0.5, ny: 0.5 });
    ws.close();
  });

  it('routes inbound {t:control} to onControl', async () => {
    const controls: Array<{ id: string; msg: Record<string, unknown> }> = [];
    const h = await startHub({ onControl: (id, msg) => controls.push({ id, msg }) });
    const ws = new WebSocket(h.url('/studio/c1/stream'));
    await nextMessage(ws);
    ws.send(JSON.stringify({ t: 'control', op: 'reclaim' }));
    await waitFor(() => controls.length === 1);
    expect(controls[0]).toMatchObject({ id: 'c1', msg: { op: 'reclaim' } });
    ws.close();
  });

  it('routes inbound {t:nav} to onNav', async () => {
    const navs: Array<{ id: string; msg: Record<string, unknown> }> = [];
    const h = await startHub({ onNav: (id, msg) => navs.push({ id, msg }) });
    const ws = new WebSocket(h.url('/studio/n1/stream'));
    await nextMessage(ws);
    ws.send(JSON.stringify({ t: 'nav', url: 'https://example.com/' }));
    await waitFor(() => navs.length === 1);
    expect(navs[0]).toMatchObject({ id: 'n1', msg: { url: 'https://example.com/' } });
    ws.close();
  });
});
