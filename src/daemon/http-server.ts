import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { initSubsystems, createMcpServer, type Subsystems } from '../server.js';
import { probeHealth } from './health-check.js';
import { createLogger } from '../logger.js';

const log = createLogger('server');

export interface DaemonOptions {
  port: number;
  host: string;
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

  constructor(options: DaemonOptions) {
    this.port = options.port;
    this.host = options.host;
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

  private handleHealthRequest(res: ServerResponse): void {
    try {
      const report = probeHealth({
        backendStatus: this.subsystems?.backendStatus ?? null,
        browserPool: this.subsystems?.browserPool ?? null,
        startedAt: this.startedAt,
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

  private async handleSseRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
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
