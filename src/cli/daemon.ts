import { createServer } from 'node:net';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { DaemonHttpServer } from '../daemon/http-server.js';
import { checkBindHost } from '../companion/bind.js';
import { closeDaemonBrowser } from '../fetch/playwright-tier.js';
import { resolveApiToken, evaluateBindGate } from '../daemon/rest/auth.js';

const logger = createLogger('cli');

function log(msg: string): void {
  process.stderr.write(`[wigolo serve] ${msg}\n`);
}

export interface DaemonArgs {
  port: number;
  host: string;
  /**
   * Explicit operator INTENT to expose the daemon beyond this machine. A non-loopback
   * bind requires it (fail-closed) on top of the token gate below — binding to 0.0.0.0
   * by accident must never silently expose the daemon.
   */
  allowRemote: boolean;
  allowUnauthenticated: boolean;
}

export function parseDaemonArgs(args: string[]): DaemonArgs {
  const config = getConfig();
  let port = config.daemonPort;
  let host = config.daemonHost;
  let allowRemote = false;
  let allowUnauthenticated = process.env.WIGOLO_SERVE_ALLOW_UNAUTHENTICATED === '1';

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
    } else if (args[i] === '--allow-unauthenticated') {
      allowUnauthenticated = true;
    }
  }

  return { port, host, allowRemote, allowUnauthenticated };
}

/**
 * Fail-closed INTENT check for a non-loopback bind: exposing the daemon beyond this
 * machine requires an explicit `--allow-remote`. This runs BEFORE the token gate and is
 * additive to it — remote exposure needs both deliberate intent and (per
 * `checkServeBindGate`) either a bearer token or an explicit unauthenticated override.
 */
export function checkServeRemoteIntent(args: DaemonArgs): { ok: boolean; message?: string; remote: boolean } {
  const bind = checkBindHost(args.host, { allowRemote: args.allowRemote });
  if (!bind.ok) return { ok: false, message: bind.message, remote: true };
  return { ok: true, remote: bind.requireAuth };
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

export interface ServeBindGateResult {
  ok: boolean;
  message?: string;
  token: string | null;
}

/**
 * Fail-closed bind gate for `wigolo serve`. A non-loopback bind with no
 * configured token and no override refuses to start; the message names the
 * token env var and the override. Returns the resolved token so the caller can
 * hand it to the server without re-reading env.
 */
export function checkServeBindGate(args: DaemonArgs): ServeBindGateResult {
  const token = resolveApiToken();
  const gate = evaluateBindGate({
    host: args.host,
    token,
    allowUnauthenticated: args.allowUnauthenticated,
  });
  return gate.ok ? { ok: true, token } : { ok: false, message: gate.message, token };
}

export function runDaemon(args: string[]): void {
  const parsed = parseDaemonArgs(args);

  // Two fail-closed checks before the server starts, in order:
  //   1. INTENT — a non-loopback bind requires an explicit `--allow-remote`.
  //   2. AUTH — a non-loopback bind additionally needs a bearer token, or an explicit
  //      unauthenticated override. This is the gate of record (WIGOLO_API_TOKEN).
  const intent = checkServeRemoteIntent(parsed);
  if (!intent.ok) {
    log(intent.message ?? 'Refusing to start.');
    process.exit(1);
    return;
  }

  const gate = checkServeBindGate(parsed);
  if (!gate.ok) {
    log(gate.message ?? 'Refusing to start.');
    process.exit(1);
    return;
  }

  // Keyed off the non-loopback BIND, not off token provenance: an operator-supplied token
  // is just as remotely reachable on a 0.0.0.0 bind, so the operator is warned either way.
  if (intent.remote) {
    log('WARNING: bound to a non-loopback host — the daemon is reachable beyond this machine.');
  }

  log(`Starting daemon on ${parsed.host}:${parsed.port}...`);

  const authState = gate.token
    ? 'bearer token required (WIGOLO_API_TOKEN)'
    : parsed.allowUnauthenticated
      ? 'UNAUTHENTICATED (open remote access — operator override)'
      : 'open on loopback only';
  const shimOn = process.env.WIGOLO_FIRECRAWL_COMPAT === '1';

  const daemon = new DaemonHttpServer({
    port: parsed.port,
    host: parsed.host,
    apiToken: gate.token,
    allowUnauthenticated: parsed.allowUnauthenticated,
  });

  daemon.start()
    .then((url) => {
      log(`Daemon running at ${url}`);
      log(`Health check: curl ${url}/health`);
      log(`REST API: ${url}/v1  (OpenAPI: ${url}/openapi.json)`);
      log(`Auth: ${authState}`);
      if (shimOn) {
        log(`Firecrawl-compat shim: ENABLED (experimental) at ${url}/compat/firecrawl`);
      }
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
