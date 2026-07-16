import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { initSubsystems, createMcpServer, type Subsystems } from '../server.js';
import { probeHealth } from './health-check.js';
import { getConfig } from '../config.js';
import { searxngConfigured } from '../searxng/enabled.js';
import { createLogger } from '../logger.js';
import { ensureAdminToken, readAdminToken, tokenMatches } from './admin-token.js';
import { resetBreakers, getBreakerSnapshot } from '../search/core/engine-base.js';
import { resolveApiToken } from './rest/auth.js';
import type { RestRouter } from './rest/router.js';

const log = createLogger('server');

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
  private readonly apiToken: string | null;
  private readonly allowUnauthenticated: boolean;
  private readonly restBindHost: string;
  private restRouter: RestRouter | null = null;
  private restRouterPromise: Promise<RestRouter> | null = null;

  constructor(options: DaemonOptions) {
    this.port = options.port;
    this.host = options.host;
    // The CLI resolves the token; fall back to env resolution so direct
    // DaemonHttpServer construction (tests, embedders) still honors it.
    this.apiToken = options.apiToken !== undefined ? options.apiToken : resolveApiToken();
    this.allowUnauthenticated = options.allowUnauthenticated ?? false;
    this.restBindHost = options.restBindHost ?? options.host;
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
        });
        this.restRouter = router;
        return router;
      })();
    }
    return this.restRouterPromise;
  }

  /** Whether a token-configured daemon should bearer-gate the MCP transport
   * routes (/mcp, /sse, /messages). 401 envelope on failure. */
  private mcpBearerRejected(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.apiToken) return false;
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

  async start(): Promise<string> {
    this.startedAt = Date.now();
    this.stopped = false;

    try {
      this.subsystems = await initSubsystems();
    } catch (err) {
      log.error('Failed to initialize subsystems', { error: String(err) });
      throw err;
    }

    // Admin control routes (breaker reset) are gated by a random bearer token
    // written owner-only to disk at start. doctor --fix reads it back to
    // authenticate. A fresh token per process invalidates any leaked prior one.
    try {
      ensureAdminToken(getConfig().dataDir);
    } catch (err) {
      log.warn('Failed to write daemon admin token', { error: String(err) });
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

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (pathname === '/health' && method === 'GET') {
      return this.handleHealthRequest(res);
    }

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
      if (this.mcpBearerRejected(req, res)) return;
      return this.handleStreamableHttpRequest(req, res);
    }

    if (pathname === '/mcp' && method === 'GET') {
      if (this.mcpBearerRejected(req, res)) return;
      return this.handleStreamableHttpGet(req, res);
    }

    if (pathname === '/mcp' && method === 'DELETE') {
      if (this.mcpBearerRejected(req, res)) return;
      return this.handleStreamableHttpDelete(req, res);
    }

    if (pathname === '/sse' && method === 'GET') {
      if (this.mcpBearerRejected(req, res)) return;
      return this.handleSseRequest(req, res);
    }

    if (pathname === '/messages' && method === 'POST') {
      if (this.mcpBearerRejected(req, res)) return;
      const sessionId = url.searchParams.get('sessionId');
      return this.handleSseMessageRequest(req, res, sessionId);
    }

    if (pathname === '/admin/reset-breakers' && method === 'POST') {
      return this.handleAdminResetBreakers(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private handleHealthRequest(res: ServerResponse): void {
    try {
      const report = probeHealth({
        backendStatus: this.subsystems?.backendStatus ?? null,
        browserPool: this.subsystems?.browserPool ?? null,
        startedAt: this.startedAt,
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
