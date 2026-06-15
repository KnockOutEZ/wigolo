import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createLogger } from '../logger.js';
import { readHandle } from '../studio/handle.js';
import type { HealthReport } from './health-check.js';

const log = createLogger('server');

/**
 * Routing rule: the user's stdio MCP server proxies ONLY `studio_*` tool calls
 * to the live Studio host; every other tool runs locally in-process.
 */
export function shouldProxyToStudioHost(toolName: string): boolean {
  return toolName.startsWith('studio_');
}

export async function tryConnectDaemon(port: number, host: string): Promise<HealthReport | null> {
  const url = `http://${host}:${port}/health`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) {
      log.debug('Daemon health check returned non-OK status', { status: response.status });
      return null;
    }
    const report = (await response.json()) as HealthReport;
    log.debug('Daemon is running', { port, host, status: report.status });
    return report;
  } catch {
    log.debug('No daemon running', { port, host });
    return null;
  }
}

/**
 * Client-side proxy to a Studio/daemon host. Uses the MCP SDK's StreamableHTTP
 * client transport, which performs the full initialize → session-id →
 * notifications/initialized handshake (the old hand-rolled stub skipped it). A
 * bearer token, when provided, is attached to every request.
 */
export class DaemonProxy {
  private readonly baseUrl: string;
  private readonly token: string | undefined;

  constructor(url: string, token?: string) {
    this.baseUrl = url;
    this.token = token;
  }

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StreamableHTTPClientTransport(new URL(`${this.baseUrl}/mcp`), {
      requestInit: this.token ? { headers: { Authorization: `Bearer ${this.token}` } } : undefined,
    });
    const client = new Client({ name: 'wigolo-studio-proxy', version: '1.0.0' });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    return this.withClient((client) => client.callTool({ name: toolName, arguments: args }));
  }

  async listTools(): Promise<unknown> {
    return this.withClient((client) => client.listTools());
  }

  async checkHealth(): Promise<HealthReport | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return null;
      return (await response.json()) as HealthReport;
    } catch {
      return null;
    }
  }
}

/**
 * Build a proxy targeting the active Studio session from its on-disk handle.
 * Returns null when no host is running (no handle), so callers surface a clean
 * "host unreachable" error rather than hanging.
 */
export function studioProxyFromHandle(dataDir?: string): DaemonProxy | null {
  const handle = readHandle(dataDir);
  if (!handle) return null;
  return new DaemonProxy(handle.endpoint, handle.token);
}
