import { mkdirSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * D13: atomically write the minted per-launch remote bearer to a 0600 owner-only file
 * (`<dataDir>/serve-bearer`), mirroring the studio handle discipline (mkdir 0700 -> write 0600
 * -> chmod -> rename). Returns the path. Throws on any fs error so the caller can fail closed —
 * the token is never echoed to stderr as a fallback.
 */
function writeServeBearer(token: string): string {
  const dataDir = getConfig().dataDir;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const finalPath = join(dataDir, 'serve-bearer');
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, token, { mode: 0o600 });
  chmodSync(tmpPath, 0o600); // deterministic regardless of umask
  renameSync(tmpPath, finalPath);
  return finalPath;
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
  | { ok: true; auth?: DaemonAuthConfig; minted: boolean; remote: boolean };

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

  // bind.requireAuth is true iff the bind is non-loopback (loopback short-circuits to false above).
  if (bind.requireAuth) {
    const { token, minted } = resolveHostToken(opts.configuredToken);
    return { ok: true, auth: { token, host: opts.host }, minted, remote: true };
  }

  const trimmed = opts.configuredToken?.trim();
  if (trimmed) return { ok: true, auth: { token: trimmed, host: opts.host }, minted: false, remote: false };
  return { ok: true, auth: undefined, minted: false, remote: false };
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
  // Keyed off the non-loopback bind, NOT token minting: an operator-supplied token is just as
  // remotely reachable on a 0.0.0.0 bind, so the operator must be warned either way.
  if (decision.remote) {
    log('WARNING: bound to a non-loopback host — the daemon is reachable beyond this machine; a bearer token is required on every request.');
    if (decision.minted && decision.auth) {
      // D13: deliver the minted bearer via a 0600 handle file, NOT echoed to stderr (terminal/shell-log
      // scrollback is a leak surface). Fail CLOSED on write error — never fall back to printing the
      // token, never start with remote exposure unprotected.
      let handlePath: string;
      try {
        handlePath = writeServeBearer(decision.auth.token);
      } catch (err) {
        log(`ERROR: refusing to start — could not write the bearer token file (${err instanceof Error ? err.message : String(err)}). Fix the data dir or pin WIGOLO_STUDIO_TOKEN.`);
        process.exit(1);
        return;
      }
      log(`  Bearer token written to ${handlePath} (0600, owner-only). Every client must send it; it is invalidated on restart — pin WIGOLO_STUDIO_TOKEN for stable remote use.`);
    }
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
