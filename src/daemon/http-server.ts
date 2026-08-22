import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
// `../server.js` and `../cache/db.js` pull the full subsystem graph incl. the native cache DB
// (better-sqlite3). They are imported DYNAMICALLY inside start()/the health path (full-daemon mode
// only) so that a studio-only gateway (mcpServerFactory set) — which runs in the Electron main where
// better-sqlite3 cannot load (spec §13.7) — never triggers that load. Type-only imports are erased.
import type { Subsystems } from '../server.js';
import type { StudioHostHandlers } from './studio-dispatch.js';
import type { StudioSessionsAccessor } from '../studio/session-drive.js';
import { probeHealth } from './health-check.js';
import { checkAuth, checkAuthSubprotocol, checkOriginHost } from '../studio/auth.js';
import { getConfig } from '../config.js';
import { searxngConfigured } from '../searxng/enabled.js';
import { createLogger } from '../logger.js';
import { ensureAdminToken, readAdminToken, tokenMatches } from './admin-token.js';
import { resetBreakers, getBreakerSnapshot } from '../search/core/engine-base.js';
import { resolveApiToken } from './rest/auth.js';
import type { RestRouter } from './rest/router.js';
import type { RunsStore } from './rest/runs-store.js';

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

const log = createLogger('server');

export interface DaemonAuthConfig {
  token: string;
  host: string;
}

/**
 * Server-level slow-loris guards. Without these, a slow-drip client stays under
 * the per-request byte cap yet holds a connection (and, since /v1 acquires a
 * concurrency slot before the body read, a slot) for Node's ~300s default
 * requestTimeout. These bounded defaults cut a slow body/headers off well
 * before that while leaving legit large crawls-over-REST room. Both are
 * env-overridable.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

function envTimeoutMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
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
   * STUDIO-ONLY MODE: when set, start() SKIPS `initSubsystems()` (and never imports `../server.js` /
   * the native cache DB) and every MCP session is served by this factory instead of `createMcpServer`.
   * The Electron app passes a factory that hosts only the `studio_*` surface (spec §13.7). Full-daemon
   * behavior is unchanged when this is absent.
   */
  mcpServerFactory?: () => Server;
  /**
   * The run store this process serves `/v1/runs*` from, for an owner that cannot open a native
   * handle. SD1 §6 rules that the studio-hosting process is the ONE live owner while the app runs,
   * and the Electron main reaches its store only through the broker child — so without this the
   * owner answers 503 and nobody serves. Absent on the daemon, which opens the shared cache DB.
   */
  runStore?: RunsStore;
  /** Configured API token (null = open mode). Resolved by the CLI. */
  apiToken?: string | null;
  /** Operator opted into open remote access. */
  allowUnauthenticated?: boolean;
  /**
   * The bind host the REST auth pipeline reasons about, independent of the
   * actual TCP listen host. Defaults to `host`. Lets tests simulate a
   * non-loopback bind (open-mode override / target-guard rows) without
   * actually binding a public interface.
   */
  restBindHost?: string;
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
  private readonly mcpServerFactory: (() => Server) | null;
  /** Set by start() in full-daemon mode from the dynamically-imported `../server.js`; null in studio-only mode. */
  private createMcpServerFn: ((subsystems: Subsystems) => Server) | null = null;
  private mcpRequestCount = 0;
  private studioHost: StudioHostHandlers | null = null;
  private studioSessions: StudioSessionsAccessor | null = null;
  private readonly apiToken: string | null;
  private readonly allowUnauthenticated: boolean;
  private readonly restBindHost: string;
  private restRouter: RestRouter | null = null;
  private restRouterPromise: Promise<RestRouter> | null = null;

  // `options` is exposed readonly for observability/wiring assertions (e.g. confirming
  // the host enforces the same bearer it published to the handle). In-process only; the
  // token is already in the 0600 handle, so this is no new exposure.
  constructor(public readonly options: DaemonOptions) {
    this.port = options.port;
    this.host = options.host;
    this.auth = options.auth ?? null;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 0;
    this.onUpgrade = options.onUpgrade ?? null;
    this.mcpServerFactory = options.mcpServerFactory ?? null;
    // The CLI resolves the token; fall back to env resolution so direct
    // DaemonHttpServer construction (tests, embedders) still honors it.
    this.apiToken = options.apiToken !== undefined ? options.apiToken : resolveApiToken();
    this.allowUnauthenticated = options.allowUnauthenticated ?? false;
    this.restBindHost = options.restBindHost ?? options.host;
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

  /**
   * Lazily construct the REST router on first matching request. Nothing under
   * `rest/` (including ajv) loads at boot, in stdio mode, or for /mcp-only use.
   */
  private async getRestRouter(): Promise<RestRouter> {
    if (this.restRouter) return this.restRouter;
    if (!this.restRouterPromise) {
      this.restRouterPromise = (async () => {
        const { RestRouter } = await import('./rest/router.js');
        const router = new RestRouter({
          subsystems: this.subsystems!,
          bindHost: this.restBindHost,
          token: this.apiToken,
          allowUnauthenticated: this.allowUnauthenticated,
          ...(this.options.runStore ? { runStore: this.options.runStore } : {}),
        });
        this.restRouter = router;
        return router;
      })();
    }
    return this.restRouterPromise;
  }

  /**
   * Gate the MCP transport routes (/mcp, /sse, /messages). Returns true when the
   * request was rejected (a response was written). A browser `Origin` is always
   * rejected, including in token mode, so a page cannot drive the transport.
   * In token mode the bearer token authorizes remote MCP clients, so Host is not
   * restricted. In open mode, the loopback Host allowlist blocks DNS rebinding.
   */
  private mcpTransportRejected(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.headers.origin !== undefined) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'Forbidden: browser origin not allowed',
        error_reason: 'origin_not_allowed',
        hint: 'Browser-origin requests are not supported on the MCP transport. Use a server-side or CLI client.',
      }));
      return true;
    }
    if (this.apiToken) {
      const auth = req.headers.authorization ?? '';
      const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
      if (tokenMatches(this.apiToken, provided)) return false;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        error: 'Missing or invalid bearer token',
        error_reason: 'unauthorized',
        hint: 'Provide a valid "Authorization: Bearer <token>" header (set via WIGOLO_API_TOKEN).',
      }));
      return true;
    }
    if (this.isAllowedHost(req.headers.host)) return false;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: false,
      error: 'Forbidden: host not allowed',
      error_reason: 'host_not_allowed',
      hint: 'Request Host is not on the loopback allowlist.',
    }));
    return true;
  }

  async start(): Promise<string> {
    this.startedAt = Date.now();
    this.stopped = false;

    if (this.mcpServerFactory) {
      // STUDIO-ONLY: no subsystems, and crucially no `../server.js` import → the native cache DB is
      // never loaded, so this gateway boots in the Electron main (spec §13.7). Sessions are served by
      // the injected factory below.
      log.info('Daemon HTTP server starting in studio-only mode (no core subsystems)');
    } else {
      try {
        const mod = await import('../server.js');
        this.createMcpServerFn = mod.createMcpServer;
        this.subsystems = await mod.initSubsystems();
        if (this.studioHost) this.subsystems.studioHost = this.studioHost; // apply if set before start()
        if (this.studioSessions) this.subsystems.studioSessions = this.studioSessions; // D19: same apply-if-pre-start
      } catch (err) {
        log.error('Failed to initialize subsystems', { error: String(err) });
        throw err;
      }
      this.subsystems.bootstrapSearxng().catch((err) => {
        log.warn('SearXNG bootstrap failed in daemon mode', { error: String(err) });
      });
    }

    // Admin control routes (breaker reset) are gated by a random bearer token
    // written owner-only to disk at start. doctor --fix reads it back to
    // authenticate. A fresh token per process invalidates any leaked prior one.
    // NOTE: `bootstrapSearxng()` is NOT called here — it runs inside the
    // full-daemon branch above, because studio-only mode has no subsystems.
    try {
      ensureAdminToken(getConfig().dataDir);
    } catch (err) {
      log.warn('Failed to write daemon admin token', { error: String(err) });
    }

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

    // Slow-loris guards (env-overridable). See DEFAULT_*_TIMEOUT_MS above.
    this.httpServer.requestTimeout = envTimeoutMs('WIGOLO_SERVE_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS);
    this.httpServer.headersTimeout = envTimeoutMs('WIGOLO_SERVE_HEADERS_TIMEOUT_MS', DEFAULT_HEADERS_TIMEOUT_MS);

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

  /** One fresh MCP server per transport session — the injected studio-only factory, or the full server. */
  private newMcpServer(): Server {
    if (this.mcpServerFactory) return this.mcpServerFactory();
    return this.createMcpServerFn!(this.subsystems!);
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
    // REST surface — lazily loaded so rest/ + ajv never touch the boot / stdio
    // path. Delegated by prefix; the router owns method gating + auth.
    if (
      pathname.startsWith('/v1/') ||
      pathname === '/openapi.json' ||
      pathname === '/compat/firecrawl' ||
      pathname.startsWith('/compat/firecrawl/')
    ) {
      const router = await this.getRestRouter();
      return router.handle(req, res);
    }

    if (pathname === '/mcp' && method === 'POST') {
      if (this.mcpTransportRejected(req, res)) return;
      return this.handleStreamableHttpRequest(req, res);
    }

    if (pathname === '/mcp' && method === 'GET') {
      if (this.mcpTransportRejected(req, res)) return;
      return this.handleStreamableHttpGet(req, res);
    }

    if (pathname === '/mcp' && method === 'DELETE') {
      if (this.mcpTransportRejected(req, res)) return;
      return this.handleStreamableHttpDelete(req, res);
    }

    if (pathname === '/sse' && method === 'GET') {
      if (this.mcpTransportRejected(req, res)) return;
      return this.handleSseRequest(req, res);
    }

    if (pathname === '/messages' && method === 'POST') {
      if (this.mcpTransportRejected(req, res)) return;
      const sessionId = url.searchParams.get('sessionId');
      return this.handleSseMessageRequest(req, res, sessionId);
    }

    if (pathname === '/admin/reset-breakers' && method === 'POST') {
      return this.handleAdminResetBreakers(req, res);
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

  private async handleHealthRequest(res: ServerResponse): Promise<void> {
    try {
      // STUDIO-ONLY: no cache subsystem to probe (better-sqlite3 is never loaded here) — report liveness only.
      if (this.mcpServerFactory) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', mode: 'studio', uptimeMs: Date.now() - this.startedAt }));
        return;
      }
      const { probeCacheDb } = await import('../cache/db.js');
      const report = probeHealth({
        backendStatus: this.subsystems?.backendStatus ?? null,
        browserPool: this.subsystems?.browserPool ?? null,
        startedAt: this.startedAt,
        cacheProbe: () => probeCacheDb(),
        searxngConfigured: searxngConfigured(getConfig()),
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
   * Whether the request's Host header is on the allowlist: `localhost`,
   * `127.0.0.1`, `[::1]`, or the daemon's configured host. Rejecting other
   * Hosts blocks DNS-rebinding: a browser resolving an attacker domain to
   * 127.0.0.1 sends the attacker's Host, not a loopback one.
   */
  private isAllowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    // Strip the :port suffix — but keep IPv6 brackets intact.
    const host = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
      : hostHeader.split(':')[0];
    const allow = new Set(['localhost', '127.0.0.1', '[::1]', '::1', this.host]);
    return allow.has(host);
  }

  /**
   * Reset all search-engine circuit breakers. Privileged control route:
   *   1. Host allowlist (DNS-rebinding guard) — non-allowlisted → 403.
   *   2. No `Origin` header allowed (browsers always set it; a CLI never does)
   *      → 403. Runs before the token check so a browser page can't probe the
   *      token's validity.
   *   3. `Authorization: Bearer <token>` must match the on-disk admin token —
   *      missing/wrong → 401.
   * Loopback source IP is deliberately NOT trusted (cloudflared delivers remote
   * requests from 127.0.0.1).
   */
  private handleAdminResetBreakers(req: IncomingMessage, res: ServerResponse): void {
    const deny = (code: number, message: string): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    };

    if (!this.isAllowedHost(req.headers.host)) {
      return deny(403, 'Forbidden: host not allowed');
    }
    if (req.headers.origin !== undefined) {
      return deny(403, 'Forbidden: browser origin not allowed on admin route');
    }

    const auth = req.headers.authorization ?? '';
    const provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
    const expected = readAdminToken(getConfig().dataDir);
    if (!tokenMatches(expected, provided)) {
      return deny(401, 'Unauthorized');
    }

    resetBreakers();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reset: true, breakers: getBreakerSnapshot() }));
  }

  private async handleStreamableHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.mcpRequestCount++;
    if (!this.subsystems && !this.mcpServerFactory) {
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

        const server = this.newMcpServer();
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
    if (!this.subsystems && !this.mcpServerFactory) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server not ready' }));
      return;
    }

    try {
      const transport = new SSEServerTransport('/messages', res);
      const server = this.newMcpServer();

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
