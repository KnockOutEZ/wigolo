import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ScreencastFrame } from './screencast.js';
import { createLogger } from '../logger.js';

/**
 * Per-session WebSocket fan-out for the Studio host. The daemon authorizes the
 * upgrade (Origin/Host + subprotocol bearer) and hands us the socket; we
 * complete the handshake, key the client by the session id in its path
 * (`/studio/<sessionId>/stream`), and track it for frame broadcast. Frame
 * forwarding + inbound input/control routing attach in slices 1b/1c.
 *
 * Liveness: a half-open TCP (killed tab, dropped network with no FIN/RST) never
 * surfaces as `close`/`error`, so a ping/pong heartbeat reaps dead clients —
 * without it they leak in the client set and `broadcast` writes to dead sockets
 * forever. `onAttach`/`onDetach` let the host keep the Session's client count
 * accurate (it backs idle-eviction) for every connect AND every disconnect,
 * graceful or not.
 */

const log = createLogger('studio');

const STREAM_PATH = /^\/studio\/([^/]+)\/stream\/?$/;
const DEFAULT_HEARTBEAT_MS = 30_000;
// The non-secret subprotocol the host negotiates. WS clients connect offering
// BOTH `wigolo.stream` (negotiated + echoed in the 101 response) and
// `wigolo.bearer.<token>` (read by the daemon for auth, never echoed back).
const STREAM_SUBPROTOCOL = 'wigolo.stream';
// Inbound client→host messages are tiny ({t:'ack'}, and Phase-1c input/control).
// Cap the frame size so an authenticated client can't force a 100 MiB allocation
// (ws's default maxPayload) per message.
const MAX_INBOUND_MESSAGE_BYTES = 64 * 1024;
// Per-client send-buffer ceiling. Phase 1's screencast is single-viewer + lock-step
// (one frame in flight, advance on ack/timeout — see ScreencastBridge), so the
// primary viewer's buffer is bounded by design; this guard makes any EXTRA client
// shed frames instead of buffering unboundedly. True multi-client shared viewing
// with independent per-client pacing is Phase 8.
const DEFAULT_FRAME_BACKPRESSURE_BYTES = 8_000_000;

export interface StudioWsHubOptions {
  /** Ping/pong sweep interval; a client that misses a sweep is terminated. */
  heartbeatIntervalMs?: number;
  /** Called once when a client attaches (host wires this to Session.attach). */
  onAttach?: (sessionId: string) => void;
  /** Called once when a client detaches — graceful close, error, or heartbeat reap. */
  onDetach?: (sessionId: string) => void;
  /** Inbound client frame-ack — host wires this to ScreencastBridge.onClientAck. */
  onAck?: (sessionId: string) => void;
  /** Inbound human input event — host wires this to SessionController.handleWireInput. */
  onInput?: (sessionId: string, msg: Record<string, unknown>) => void;
  /** Inbound control op (reclaim/grant/release) — host wires this to SessionController.handleWireControl. */
  onControl?: (sessionId: string, msg: Record<string, unknown>) => void;
  /** Inbound human navigation request ({t:'nav', url}) — host wires this to a guarded navigateSession. */
  onNav?: (sessionId: string, msg: Record<string, unknown>) => void;
  /** Skip sending a frame to a client whose send buffer already exceeds this (drop-under-load). */
  frameBackpressureBytes?: number;
  /** Extra fields merged into the `hello` sent on connect — the host supplies the initial control state {holder, epoch} so a client knows the epoch to stamp on input. */
  helloExtras?: (sessionId: string) => Record<string, unknown>;
}

export class StudioWsHub {
  // Negotiate the non-secret `wigolo.stream` (when offered) and NEVER the
  // `wigolo.bearer.<token>` the client also offers — so the token is not echoed
  // back in the 101 response / into any proxy access log. A client offering no
  // subprotocol negotiates none (browsers accept that).
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_INBOUND_MESSAGE_BYTES,
    handleProtocols: (protocols) => (protocols.has(STREAM_SUBPROTOCOL) ? STREAM_SUBPROTOCOL : false),
  });
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  private readonly onAttach?: (sessionId: string) => void;
  private readonly onDetach?: (sessionId: string) => void;
  private readonly onAck?: (sessionId: string) => void;
  private readonly onInput?: (sessionId: string, msg: Record<string, unknown>) => void;
  private readonly onControl?: (sessionId: string, msg: Record<string, unknown>) => void;
  private readonly onNav?: (sessionId: string, msg: Record<string, unknown>) => void;
  private readonly helloExtras?: (sessionId: string) => Record<string, unknown>;
  private readonly frameBackpressureBytes: number;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(opts: StudioWsHubOptions = {}) {
    this.onAttach = opts.onAttach;
    this.onDetach = opts.onDetach;
    this.onAck = opts.onAck;
    this.onInput = opts.onInput;
    this.onControl = opts.onControl;
    this.onNav = opts.onNav;
    this.helloExtras = opts.helloExtras;
    this.frameBackpressureBytes = opts.frameBackpressureBytes ?? DEFAULT_FRAME_BACKPRESSURE_BYTES;
    this.heartbeat = setInterval(() => this.heartbeatTick(), opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS);
    // Don't let the heartbeat keep the process alive on its own.
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  /** Complete an authorized upgrade and register the client under its session id. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const sessionId = this.parseSessionId(req.url);
    if (!sessionId) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.alive.set(ws, true);
      ws.on('pong', () => this.alive.set(ws, true));
      this.register(sessionId, ws);
      ws.on('close', () => this.unregister(sessionId, ws));
      ws.on('error', () => this.unregister(sessionId, ws));
      ws.on('message', (data) => this.onMessage(sessionId, data));
      // Register BEFORE hello so a client that acts on hello sees a live registration.
      this.send(ws, { t: 'hello', sessionId, ...(this.helloExtras?.(sessionId) ?? {}) });
    });
  }

  clientCount(sessionId: string): number {
    return this.clients.get(sessionId)?.size ?? 0;
  }

  /** Send a control message to every open client of a session (server → client). */
  broadcast(sessionId: string, message: Record<string, unknown>): void {
    const set = this.clients.get(sessionId);
    if (!set) return;
    const data = JSON.stringify(message);
    for (const ws of set) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  /**
   * Forward a screencast frame to a session's clients, shedding any whose send
   * buffer already exceeds the backpressure ceiling so a lagging client drops
   * frames rather than buffering unboundedly (and never stalls the source).
   * Returns the sent/dropped split for observability.
   */
  broadcastFrame(sessionId: string, frame: ScreencastFrame): { sent: number; dropped: number } {
    const set = this.clients.get(sessionId);
    if (!set) return { sent: 0, dropped: 0 };
    const data = JSON.stringify({ t: 'frame', data: frame.data, meta: frame.metadata });
    let sent = 0;
    let dropped = 0;
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > this.frameBackpressureBytes) {
        dropped++;
        continue;
      }
      ws.send(data);
      sent++;
    }
    return { sent, dropped };
  }

  /** Disconnect every client and stop the heartbeat (host shutdown). */
  closeAll(): void {
    clearInterval(this.heartbeat);
    for (const set of this.clients.values()) {
      for (const ws of set) ws.close();
    }
    this.clients.clear();
    this.wss.close();
  }

  /** Ping every client; terminate any that missed the previous sweep (no pong since). */
  private heartbeatTick(): void {
    for (const set of this.clients.values()) {
      for (const ws of [...set]) {
        if (this.alive.get(ws) === false) {
          ws.terminate(); // fires 'close' → unregister → onDetach
          continue;
        }
        this.alive.set(ws, false);
        try {
          ws.ping();
        } catch {
          /* socket already gone; the close/error handler will unregister */
        }
      }
    }
  }

  /** Route an inbound client message: frame `ack` (paces the screencast), `input` (human input), `control` (token op). */
  private onMessage(sessionId: string, data: RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // ignore malformed input — never throw on attacker/garbage data
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'ack':
        this.onAck?.(sessionId);
        break;
      case 'input':
        this.onInput?.(sessionId, msg);
        break;
      case 'control':
        this.onControl?.(sessionId, msg);
        break;
      case 'nav':
        this.onNav?.(sessionId, msg);
        break;
    }
  }

  private parseSessionId(url: string | undefined): string | null {
    if (!url) return null;
    const m = STREAM_PATH.exec(url.split('?')[0]);
    return m ? m[1] : null;
  }

  private register(sessionId: string, ws: WebSocket): void {
    let set = this.clients.get(sessionId);
    if (!set) {
      set = new Set();
      this.clients.set(sessionId, set);
    }
    if (set.has(ws)) return;
    set.add(ws);
    log.debug('studio ws client connected', { sessionId, clients: set.size });
    this.onAttach?.(sessionId);
  }

  private unregister(sessionId: string, ws: WebSocket): void {
    const set = this.clients.get(sessionId);
    if (!set || !set.delete(ws)) return; // only fire onDetach once, even if close + error both fire
    const remaining = set.size;
    if (remaining === 0) this.clients.delete(sessionId);
    log.debug('studio ws client disconnected', { sessionId, clients: remaining });
    this.onDetach?.(sessionId);
  }

  private send(ws: WebSocket, message: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }
}
