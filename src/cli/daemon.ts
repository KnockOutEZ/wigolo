import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { DaemonHttpServer, type DaemonAuthConfig } from '../daemon/http-server.js';
import { checkBindHost } from '../studio/bind.js';
import { resolveHostToken } from '../studio/auth.js';
import { closeDaemonBrowser } from '../fetch/playwright-tier.js';

const logger = createLogger('cli');

function log(msg: string): void {
  process.stderr.write(`[wigolo serve] ${msg}\n`);
}

export interface DaemonArgs {
  port: number;
  host: string;
  allowRemote: boolean;
}

export function parseDaemonArgs(args: string[]): DaemonArgs {
  const config = getConfig();
  let port = config.daemonPort;
  let host = config.daemonHost;
  let allowRemote = false;

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
    } else if (args[i] === '--allow-remote') {
      allowRemote = true;
    }
  }

  return { port, host, allowRemote };
}

export type ServeAuthDecision =
  | { ok: false; message: string }
  | { ok: true; auth?: DaemonAuthConfig; minted: boolean };

/**
 * Decide `wigolo serve` auth from the bind target — closes audit S3
 * (unauthenticated daemon reachable on 0.0.0.0). Loopback stays token-optional
 * (back-compat). A non-loopback bind requires explicit `--allow-remote` AND
 * forces auth on: an operator-supplied token (stable across restarts) if set,
 * else a freshly minted per-launch token.
 */
export function buildServeAuth(opts: {
  host: string;
  allowRemote: boolean;
  configuredToken: string | null;
}): ServeAuthDecision {
  const bind = checkBindHost(opts.host, { allowRemote: opts.allowRemote });
  if (!bind.ok) return { ok: false, message: bind.message };

  if (bind.requireAuth) {
    const { token, minted } = resolveHostToken(opts.configuredToken);
    return { ok: true, auth: { token, host: opts.host }, minted };
  }

  const trimmed = opts.configuredToken?.trim();
  if (trimmed) return { ok: true, auth: { token: trimmed, host: opts.host }, minted: false };
  return { ok: true, auth: undefined, minted: false };
}

export function runDaemon(args: string[]): void {
  const parsed = parseDaemonArgs(args);

  const decision = buildServeAuth({
    host: parsed.host,
    allowRemote: parsed.allowRemote,
    configuredToken: getConfig().studioAuthToken,
  });
  if (!decision.ok) {
    log(decision.message);
    process.exit(1);
    return;
  }
  if (decision.minted && decision.auth) {
    log('WARNING: bound to a non-loopback host with a freshly MINTED per-launch bearer token.');
    log(`  Bearer token (required by every client): ${decision.auth.token}`);
    log('  This token is invalidated on restart — pin WIGOLO_STUDIO_TOKEN for stable remote use.');
  }

  log(`Starting daemon on ${parsed.host}:${parsed.port}...`);

  const daemon = new DaemonHttpServer({
    port: parsed.port,
    host: parsed.host,
    auth: decision.auth,
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
    await closeDaemonBrowser().catch((e) => logger.debug('closeDaemonBrowser failed', { error: e instanceof Error ? e.message : String(e) }));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
