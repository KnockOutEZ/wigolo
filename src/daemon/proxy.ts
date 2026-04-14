import { createLogger } from '../logger.js';
import type { HealthReport } from './health-check.js';

const log = createLogger('server');

export async function tryConnectDaemon(port: number, host: string): Promise<HealthReport | null> {
  const url = `http://${host}:${port}/health`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      log.debug('Daemon health check returned non-OK status', { status: response.status });
      return null;
    }

    const report = await response.json() as HealthReport;
    log.debug('Daemon is running', { port, host, status: report.status });
    return report;
  } catch {
    log.debug('No daemon running', { port, host });
    return null;
  }
}

// NOTE: callTool and listTools are incomplete — they skip the MCP initialize
// handshake required by StreamableHTTP transport. Full proxy deferred to v2.1.
// Only checkHealth (which uses /health, not /mcp) works today.
export class DaemonProxy {
  private readonly baseUrl: string;

  constructor(url: string) {
    this.baseUrl = url;
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}/mcp`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: Date.now(),
          params: {
            name: toolName,
            arguments: args,
          },
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Daemon returned HTTP ${response.status}: ${text}`);
      }

      return response.json();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Daemon returned')) throw err;
      throw new Error(`Failed to call tool via daemon: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async checkHealth(): Promise<HealthReport | null> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });

      if (!response.ok) return null;

      return response.json() as Promise<HealthReport>;
    } catch {
      return null;
    }
  }

  async listTools(): Promise<unknown> {
    const url = `${this.baseUrl}/mcp`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/list',
          id: Date.now(),
          params: {},
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return null;
      return response.json();
    } catch {
      return null;
    }
  }
}
