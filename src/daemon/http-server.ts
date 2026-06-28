import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { initSubsystems, createMcpServer, type Subsystems } from '../server.js';
import type { StudioHostHandlers } from './studio-dispatch.js';
import type { StudioSessionsAccessor } from '../studio/session-drive.js';
import { probeHealth } from './health-check.js';
import { probeCacheDb } from '../cache/db.js';
import { checkAuth, checkAuthSubprotocol, checkOriginHost } from '../studio/auth.js';
import { serveStaticAsset } from './static-assets.js';
import type { NonceStore } from '../studio/nonce.js';
import { createLogger } from '../logger.js';

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

const log = createLogger('server');

export interface DaemonAuthConfig {
  token: string;
  host: string;
}

export interface DaemonOptions {
  port: number;
  host: string;
  /** When set, every MCP request requires a matching bearer token and passes the Origin/Host guard. `/health` stays open. */
  auth?: DaemonAuthConfig;
  /** When > 0, every request is bounded; on expiry a 504 is returned (host path only). */
  requestTimeoutMs?: number;
  /**
   * When set, WebSocket upgrades that pass the Origin/Host + subprotocol-bearer
   * guard are handed to this handler (the Studio host wires its WS hub here).
   * Long-lived, so it never enters `handleRequest`'s per-request timeout. Host
   * path only — the stdio server never constructs this server.
   */
  onUpgrade?: UpgradeHandler;
  /**
   * When set, the built Studio web-app shell is served (OPEN, like `/health`) from this directory for
   * `GET /` and the allowlisted shell assets — and ONLY those paths (see static-assets.ts). The auth-gated
   * MCP surface is never shadowed. Host path only; unset on the stdio server (no static serving).
   */
  webappRoot?: string;
  /**
   * When set (with `auth`), `POST /studio/token` exchanges a valid one-time nonce for the session bearer.
   * The browser tab is opened with a NONCE in its URL (not the bearer); the page redeems it here over a
   * loopback POST so the long-lived bearer never rides a URL/query. Open (the tab has no bearer yet) but
   * Origin/Host-guarded and single-use/TTL-bounded by the nonce store. Host path only.
   */
  nonceStore?: NonceStore;
}

export class DaemonHttpServer {
  private httpServer: HttpServer | null = null;
  private subsystems: Subsystems | null = null;
  private startedAt: number = 0;
  private stopped = false;
  private sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: Server }>();
  private sseSessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  private readonly port: number;
  private readonly host: string;
  private readonly auth: DaemonAuthConfig | null;
  private readonly requestTimeoutMs: number;
  private readonly onUpgrade: UpgradeHandler | null;
  private readonly webappRoot: string | null;
  private readonly nonceStore: NonceStore | null;
  private mcpRequestCount = 0;
  private studioHost: StudioHostHandlers | null = null;
  private studioSessions: StudioSessionsAccessor | null = null;

  // `options` is exposed readonly for observability/wiring assertions (e.g. confirming
  // the host enforces the same bearer it published to the handle). In-process only; the
  // token is already in the 0600 handle, so this is no new exposure.
  constructor(public readonly options: DaemonOptions) {
    this.port = options.port;
    this.host = options.host;
    this.auth = options.auth ?? null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
    this.onUpgrade = options.onUpgrade ?? null;
    this.webappRoot = options.webappRoot ?? null;
    this.nonceStore = options.nonceStore ?? null;
  }

  /**
   * Inject the live studio host handlers (late setter). cli/studio.ts calls this AFTER
   * start() builds the subsystems but BEFORE the handle is published — closing the
   * window where a studio_* call could arrive with studioHost unset. The lazy
   * per-session createMcpServer reads subsystems.studioHost, so a late-set value is
   * picked up by every subsequent agent connection.
   */
  setStudioHost(handlers: StudioHostHandlers): void {
    this.studioHost = handlers;
    if (this.subsystems) this.subsystems.studioHost = handlers;
  }

  /**
   * D19: inject the live session-drive accessor (late setter, mirrors setStudioHost). cli/studio.ts calls this
   * alongside setStudioHost, AFTER start() builds the subsystems but BEFORE the handle is published. The lazy
   * per-session createMcpServer reads subsystems.studioSessions, so a late-set value is picked up by every
   * subsequent agent connection — a session-targeted fetch/extract/crawl forwarded to this host resolves here.
   */
  setStudioSessions(accessor: StudioSessionsAccessor): void {
    this.studioSessions = accessor;
    if (this.subsystems) this.subsystems.studioSessions = accessor;
  }

  /** Count of MCP (`POST /mcp`) requests handled — observability + round-trip verification. */
  getMcpRequestCount(): number {
    return this.mcpRequestCount;
  }

  async start(): Promise<string> {
    this.startedAt = Date.now();
    this.stopped = false;

    try {
      this.subsystems = await initSubsystems();
      if (this.studioHost) this.subsystems.studioHost = this.studioHost; // apply if set before start()
      if (this.studioSessions) this.subsystems.studioSessions = this.studioSessions; // D19: same apply-if-pre-start
    } catch (err) {
      log.error('Failed to initialize subsystems', { error: String(err) });
      throw err;
    }

    this.subsystems.bootstrapSearxng().catch((err) => {
      log.warn('SearXNG bootstrap failed in daemon mode', { error: String(err) });
    });

    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error('Unhandled request error', { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
    });

    this.httpServer.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));

    return new Promise<string>((resolve, reject) => {
      this.httpServer!.on('error', (err) => {
        log.error('HTTP server error', { error: String(err) });
        reject(err);
      });

      this.httpServer!.listen(this.port, this.host, () => {
        const addr = this.httpServer!.address();
        let resolvedPort = this.port;
        if (addr && typeof addr === 'object') {
          resolvedPort = addr.port;
        }
        const url = `http://${this.host}:${resolvedPort}`;
        log.info('Daemon HTTP server started', { url });
        resolve(url);
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    // /health is always open — it is a liveness probe (the stdio proxy uses it to
    // detect a running host) and exposes no tool surface.
    if (pathname === '/health' && method === 'GET') {
      return this.handleHealthRequest(res);
    }

    // Studio web-app shell — OPEN (like /health), served BEFORE the auth gate. `serveStaticAsset` OWNS
    // only `GET /` + the allowlisted shell assets; for anything else it returns false and we fall through
    // to the auth gate + router, so this can never shadow the auth-gated /mcp surface (S1 PIN-A).
    if (this.webappRoot && method === 'GET' && serveStaticAsset(this.webappRoot, pathname, res)) {
      return;
    }

    // Nonce→bearer exchange (S2) — OPEN (the tab has no bearer yet) but Origin/Host-guarded and gated by a
    // single-use, TTL-bounded nonce. Sits BEFORE the bearer-auth gate by necessity; it is the ONLY non-health
    // path that bypasses the bearer, and it hands the bearer back only for a freshly-minted, unredeemed nonce.
    if (this.nonceStore && this.auth && pathname === '/studio/token' && method === 'POST') {
      return this.handleTokenExchange(req, res);
    }

    // Auth + Origin/Host guard for the MCP surface. Host path only: the stdio
    // server never reaches this code, so stdio behavior is unchanged.
    if (this.auth) {
      const origin = checkOriginHost(req, { host: this.auth.host });
      if (!origin.ok) return this.writeRequestError(res, 403, 'forbidden', origin.reason);
      const auth = checkAuth(req, this.auth.token);
      if (!auth.ok) return this.writeRequestError(res, 401, 'unauthorized', auth.reason);
    }

    const route = () => this.routeRequest(pathname, method, url, req, res);
    if (this.requestTimeoutMs > 0) {
      return this.withRequestTimeout(res, route);
    }
    return route();
  }

  private async routeRequest(
    pathname: string,
    method: string,
    url: URL,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (pathname === '/mcp' && method === 'POST') {
      return this.handleStreamableHttpRequest(req, res);
    }

    if (pathname === '/mcp' && method === 'GET') {
      return this.handleStreamableHttpGet(req, res);
    }

    if (pathname === '/mcp' && method === 'DELETE') {
      return this.handleStreamableHttpDelete(req, res);
    }

    if (pathname === '/sse' && method === 'GET') {
      return this.handleSseRequest(req, res);
    }

    if (pathname === '/messages' && method === 'POST') {
      const sessionId = url.searchParams.get('sessionId');
      return this.handleSseMessageRequest(req, res, sessionId);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private writeRequestError(res: ServerResponse, status: number, error: string, reason: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error, error_reason: reason, stage: 'daemon' }));
  }

  /**
   * Authorize a WebSocket upgrade (Origin/Host + subprotocol bearer when auth is
   * configured) and hand the raw socket to the registered handler. Rejected
   * upgrades get an HTTP status line and the socket destroyed. Nothing here
   * enters `handleRequest`, so a long-lived WS is never bounded by the 504
   * per-request timeout.
   */
  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (this.auth) {
      const origin = checkOriginHost(req, { host: this.auth.host });
      if (!origin.ok) return this.rejectUpgrade(socket, 403, 'Forbidden');
      const auth = checkAuthSubprotocol(req, this.auth.token);
      if (!auth.ok) return this.rejectUpgrade(socket, 401, 'Unauthorized');
    }
    if (!this.onUpgrade) return this.rejectUpgrade(socket, 404, 'Not Found');
    this.onUpgrade(req, socket, head);
  }

  private rejectUpgrade(socket: Duplex, status: number, message: string): void {
    socket.write(`HTTP/1.1 ${status} ${message}\r\n\r\n`);
    socket.destroy();
  }

  /**
   * Bound a request by total duration. On expiry, return 504 if nothing has been
   * sent yet; the underlying handler continues but its late writes are guarded by
   * `res.headersSent`, and its late rejection is swallowed here.
   */
  private async withRequestTimeout(res: ServerResponse, work: () => Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        if (!res.headersSent) {
          this.writeRequestError(res, 504, 'request timed out', 'request_timeout');
        }
        resolve();
      }, this.requestTimeoutMs);
    });
    const guarded = work().catch((err) => {
      log.debug('request handler error', { error: String(err) });
    });
    try {
      await Promise.race([guarded, timed]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private handleHealthRequest(res: ServerResponse): void {
    try {
      const report = probeHealth({
        backendStatus: this.subsystems?.backendStatus ?? null,
        browserPool: this.subsystems?.browserPool ?? null,
        startedAt: this.startedAt,
        cacheProbe: () => probeCacheDb(),
      });

      const statusCode = report.status === 'down' ? 503 : 200;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (err) {
      log.error('Health check failed', { error: String(err) });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'down', error: String(err) }));
    }
  }

  /**
   * Exchange a one-time nonce for the session bearer. Origin/Host-guarded (rebind defense); the nonce is
   * redeemed single-use + TTL-bounded by the store. A bad/expired/used nonce → 401, and the bearer is
   * never written to a log on any path. `this.auth`/`this.nonceStore` are guaranteed by the route guard.
   */
  private async handleTokenExchange(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = checkOriginHost(req, { host: this.auth!.host });
    if (!origin.ok) return this.writeRequestError(res, 403, 'forbidden', origin.reason);
    let nonce: unknown;
    try {
      const body = (await this.readJsonBody(req)) as { nonce?: unknown };
      nonce = body?.nonce;
    } catch {
      return this.writeRequestError(res, 400, 'bad_request', 'invalid_body');
    }
    if (typeof nonce !== 'string' || this.nonceStore!.redeem(nonce).ok === false) {
      return this.writeRequestError(res, 401, 'unauthorized', 'bad_nonce');
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ token: this.auth!.token }));
  }

  private async handleStreamableHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.mcpRequestCount++;
    if (!this.subsystems) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server not ready' }));
      return;
    }

    try {
      const body = await this.readJsonBody(req);
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId && this.sessions.has(sessionId)) {
        const session = this.sessions.get(sessionId)!;
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId: string) => {
            log.debug('StreamableHTTP session initialized', { sessionId: newSessionId });
            this.sessions.set(newSessionId, { transport, server });
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && this.sessions.has(sid)) {
            log.debug('StreamableHTTP session closed', { sessionId: sid });
            this.sessions.delete(sid);
          }
        };

        const server = createMcpServer(this.subsystems);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      }));
    } catch (err) {
      log.error('StreamableHTTP request failed', { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  }

  private async handleStreamableHttpGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }
    const session = this.sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  }

  private async handleStreamableHttpDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !this.sessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing session ID' }));
      return;
    }
    const session = this.sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res);
  }

  private async handleSseRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.subsystems) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server not ready' }));
      return;
    }

    try {
      const transport = new SSEServerTransport('/messages', res);
      const server = createMcpServer(this.subsystems);

      await server.connect(transport);

      const sessionId = transport.sessionId;
      this.sseSessions.set(sessionId, { transport, server });

      res.on('close', () => {
        this.sseSessions.delete(sessionId);
        log.debug('SSE session closed', { sessionId });
      });

      log.debug('SSE session started', { sessionId });
    } catch (err) {
      log.error('SSE connection failed', { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  }

  private async handleSseMessageRequest(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | null,
  ): Promise<void> {
    if (!sessionId || !this.sseSessions.has(sessionId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid or missing sessionId query parameter' }));
      return;
    }

    try {
      const session = this.sseSessions.get(sessionId)!;
      await session.transport.handlePostMessage(req, res);
    } catch (err) {
      log.error('SSE message handling failed', { error: String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    }
  }

  private readJsonBody(req: IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (err) {
          reject(err);
        }
      });
      req.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    log.info('Stopping daemon HTTP server');

    for (const [id, session] of this.sessions) {
      try {
        await session.transport.close();
      } catch {
        log.debug('StreamableHTTP transport close failed', { sessionId: id });
      }
    }
    this.sessions.clear();

    for (const [id, session] of this.sseSessions) {
      try {
        await session.transport.close();
      } catch {
        log.debug('SSE transport close failed', { sessionId: id });
      }
    }
    this.sseSessions.clear();

    if (this.subsystems) {
      try {
        await this.subsystems.shutdown();
      } catch (err) {
        log.error('Subsystems shutdown failed', { error: String(err) });
      }
      this.subsystems = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }
}
