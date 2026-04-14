import { getConfig } from '../config.js';
import { DaemonHttpServer } from '../daemon/http-server.js';

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
    .catch((err) => {
      log(`Failed to start daemon: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });

  const shutdown = async () => {
    log('Shutting down daemon...');
    try {
      await daemon.stop();
    } catch (err) {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
