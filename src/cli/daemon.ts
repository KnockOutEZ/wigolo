import { createServer } from 'node:net';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { DaemonHttpServer } from '../daemon/http-server.js';
import { closeDaemonBrowser } from '../fetch/playwright-tier.js';

const logger = createLogger('cli');

function log(msg: string): void {
  process.stderr.write(`[wigolo serve] ${msg}\n`);
}

export interface DaemonArgs {
  port: number;
  host: string;
}

export function parseDaemonArgs(args: string[]): DaemonArgs {
  const config = getConfig();
  let port = config.daemonPort;
  let host = config.daemonHost;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed)) {
        port = parsed;
      }
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    }
  }

  return { port, host };
}

/** Whether a TCP port is bindable on `host` right now. Resolves false on any
 * bind error (EADDRINUSE / EACCES / etc.). */
function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, host);
  });
}

/**
 * Find the next bindable port at or above `from + 1`, scanning up to `limit`
 * ports. Returns the taken port + 1 as a best-effort fallback if the scan finds
 * nothing (the message is a hint, not a guarantee).
 */
export async function findNextFreePort(from: number, host: string, limit = 50): Promise<number> {
  for (let p = from + 1; p <= from + limit && p <= 65535; p++) {
    if (await isPortFree(p, host)) return p;
  }
  return Math.min(from + 1, 65535);
}

/** Build the actionable serve-port-conflict message. Names the taken port,
 * `--port`, and a concrete next-free port to retry with. No auto-rebind —
 * predictability over convenience (D9). */
export async function formatPortConflictError(port: number, host: string): Promise<string> {
  const next = await findNextFreePort(port, host);
  return (
    `Port ${port} on ${host} is already in use (another wigolo serve, or a different process). ` +
    `Not auto-rebinding — retry with a free port, e.g.: wigolo serve --port ${next}`
  );
}

export function runDaemon(args: string[]): void {
  const parsed = parseDaemonArgs(args);

  log(`Starting daemon on ${parsed.host}:${parsed.port}...`);

  const daemon = new DaemonHttpServer({
    port: parsed.port,
    host: parsed.host,
  });

  daemon.start()
    .then((url) => {
      log(`Daemon running at ${url}`);
      log(`Health check: curl ${url}/health`);
      log(`MCP endpoint: ${url}/mcp (StreamableHTTP)`);
      log(`SSE endpoint: ${url}/sse`);
      log('');
      log('Press Ctrl+C to stop.');
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string } | null)?.code;
      if (code === 'EADDRINUSE' || message.includes('EADDRINUSE')) {
        log(await formatPortConflictError(parsed.port, parsed.host));
      } else {
        log(`Failed to start daemon: ${message}`);
      }
      process.exit(1);
    });

  const shutdown = async () => {
    log('Shutting down daemon...');
    try {
      await daemon.stop();
    } catch (err) {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    await closeDaemonBrowser().catch((e) => logger.debug('closeDaemonBrowser failed', { error: e instanceof Error ? e.message : String(e) }));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
