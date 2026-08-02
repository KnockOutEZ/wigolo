/**
 * Embedded local-daemon mode (node-only). `createLocalClient` ensures a wigolo
 * daemon is listening on a loopback port — reusing an already-running one, or
 * spawning `wigolo serve` when the port is free — then hands back a
 * {@link WigoloClient} plus lifecycle controls. This is the zero-setup path a
 * connection-refused error points at.
 *
 * Exposed at the "wigolo-sdk/local" subpath. It imports `node:*` builtins, so
 * it is intentionally NOT part of the edge-safe barrel.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { WigoloClient, type WigoloClientOptions } from './client.js';
import { WigoloError } from './errors.js';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 3333;
const HEALTH_PROBE_TIMEOUT_MS = 1000;
const SPAWN_HEALTH_BUDGET_MS = 20_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const CLOSE_SIGTERM_GRACE_MS = 5_000;
const STDERR_RING_LINES = 20;

/** The version below which the daemon lacks the REST API this SDK requires. */
const MIN_REST_VERSION_HINT = '0.1.43-beta.2';

export interface CreateLocalClientOptions {
  /** Loopback port. Default resolution: option > WIGOLO_LOCAL_PORT > 3333. */
  port?: number;
  /**
   * Command (argv array, end-to-end — never split on spaces) used to spawn the
   * daemon. Default resolution: option > WIGOLO_CLI (JSON array, or a single
   * executable path) > `wigolo` resolved on PATH.
   */
  command?: string[];
  /** Bearer token. Default resolution: option > WIGOLO_API_TOKEN. */
  token?: string;
  /** Per-request deadline override handed to the returned client. */
  timeoutMs?: number;
}

export interface LocalClient {
  /** The client bound to the local daemon. */
  client: WigoloClient;
  /** True when this call spawned the daemon (and `close()` will stop it). */
  owned: boolean;
  /** Stop the owned daemon (no-op when not owned). */
  close(): Promise<void>;
}

function readEnv(name: string): string | undefined {
  try {
    const value = process.env[name];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Validate a port as an integer in 1–65535. Accepts a number (option) or the
 * raw env string; rejects trailing garbage like "3333;x" that parseInt would
 * silently truncate to 3333.
 */
function validatePort(value: number | string, source: string): number {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else {
    // A strict integer string only — no trailing junk, no floats.
    if (!/^\d+$/.test(value.trim())) {
      throw new WigoloError(
        `${source} is not a valid port ("${value}") — set it to an integer between 1 and 65535.`,
      );
    }
    n = Number.parseInt(value.trim(), 10);
  }
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new WigoloError(
      `${source} is out of range (${n}) — set it to an integer between 1 and 65535.`,
    );
  }
  return n;
}

function resolvePort(opts: CreateLocalClientOptions): number {
  if (opts.port !== undefined) return validatePort(opts.port, 'port option');
  const envPort = readEnv('WIGOLO_LOCAL_PORT');
  if (envPort) return validatePort(envPort, 'WIGOLO_LOCAL_PORT');
  return DEFAULT_PORT;
}

const isWindows = process.platform === 'win32';

/** Resolve an executable name against PATH (PATHEXT-aware on win32). */
function resolveOnPath(name: string): string | null {
  if (name.includes('/') || (isWindows && name.includes('\\'))) {
    return existsSync(name) ? name : null;
  }
  const pathValue = process.env.PATH ?? '';
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = isWindows ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve the base spawn command (argv, sans `serve` args). Never split on
 * spaces: a WIGOLO_CLI string that is not a JSON array is treated as ONE
 * executable path (paths can contain spaces).
 */
function resolveCommand(opts: CreateLocalClientOptions): string[] {
  if (opts.command && opts.command.length > 0) return opts.command;
  const envCli = readEnv('WIGOLO_CLI');
  if (envCli) {
    const trimmed = envCli.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') && parsed.length > 0) {
          return parsed as string[];
        }
      } catch {
        // Fall through: treat the whole string as one path.
      }
    }
    return [envCli];
  }
  const resolved = resolveOnPath('wigolo');
  if (resolved) return [resolved];
  // Return the bare name; spawn will surface an actionable ENOENT.
  return ['wigolo'];
}

/** Whether a resolved command ends in a Windows shim extension needing cmd. */
function needsCmdShim(command: string): boolean {
  const lower = command.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat') || lower.endsWith('.ps1');
}

interface ProbeResult {
  reachable: boolean;
  healthStatus?: number;
}

async function probeHealth(base: string, token: string | undefined): Promise<ProbeResult> {
  try {
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return { reachable: true, healthStatus: res.status };
  } catch {
    return { reachable: false };
  }
}

/**
 * Capability probe against a reachable daemon. GET /v1/tools with the client's
 * token: 200 → reusable; anything else maps to an actionable throw.
 */
async function probeCapability(base: string, port: number, token: string | undefined): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${base}/v1/tools`, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS * 3),
    });
  } catch (err) {
    throw new Error(
      `A daemon is answering on port ${port} but its tool index could not be read (${String(err)}). ` +
        `Pick another WIGOLO_LOCAL_PORT or restart the daemon.`,
    );
  }
  if (res.status === 200) return;
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `The daemon on port ${port} requires a bearer token this client doesn't have (or the token doesn't match). ` +
        `Set WIGOLO_API_TOKEN to match the running daemon, or pick another WIGOLO_LOCAL_PORT.`,
    );
  }
  if (res.status === 404) {
    throw new Error(
      `The daemon on port ${port} predates the REST API this SDK needs. ` +
        `Upgrade the server (newer than ${MIN_REST_VERSION_HINT}) or set WIGOLO_LOCAL_PORT to a REST-capable daemon.`,
    );
  }
  throw new Error(
    `The service on port ${port} does not look like a REST-capable wigolo daemon (GET /v1/tools returned ${res.status}). ` +
      `Set WIGOLO_LOCAL_PORT to a different port.`,
  );
}

/** Bounded ring buffer of the most recent stderr lines from the child. */
class StderrRing {
  private lines: string[] = [];
  push(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      if (line.length === 0) continue;
      this.lines.push(line);
      if (this.lines.length > STDERR_RING_LINES) this.lines.shift();
    }
  }
  text(): string {
    return this.lines.join('\n');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TASKKILL_WAIT_MS = 2_000;

/** Best-effort tree/plain kill of a child, platform-aware. */
function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.killed) return;
  if (isWindows) {
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    child.kill(signal);
  } catch {
    /* best effort */
  }
}

/**
 * win32-only: spawn taskkill and await its exit (bounded) so a caller's
 * `close()` does not resolve while the tree-kill is still in flight.
 */
async function killChildWindowsAwait(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.killed) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    let killer: ChildProcess;
    try {
      killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      finish();
      return;
    }
    const timer = setTimeout(finish, TASKKILL_WAIT_MS);
    killer.on('exit', () => {
      clearTimeout(timer);
      finish();
    });
    killer.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

export async function createLocalClient(opts: CreateLocalClientOptions = {}): Promise<LocalClient> {
  const port = resolvePort(opts);
  const base = `http://${LOOPBACK_HOST}:${port}`;
  const token = opts.token !== undefined ? opts.token : readEnv('WIGOLO_API_TOKEN');

  const clientOptions: WigoloClientOptions = { baseUrl: base };
  if (token !== undefined) clientOptions.token = token;
  if (opts.timeoutMs !== undefined) clientOptions.timeoutMs = opts.timeoutMs;
  const makeClient = (): WigoloClient => new WigoloClient(clientOptions);

  // Step 2: probe an existing daemon.
  const probe = await probeHealth(base, token);
  if (probe.reachable) {
    // 200 required for reuse; a 503-down daemon is not reusable.
    if (probe.healthStatus === 200) {
      await probeCapability(base, port, token);
      return { client: makeClient(), owned: false, close: async () => {} };
    }
    throw new Error(
      `A daemon on port ${port} reports unhealthy (HTTP ${probe.healthStatus}). ` +
        `Wait for it to recover, restart it, or set WIGOLO_LOCAL_PORT to another port.`,
    );
  }

  // Step 3: connection refused → spawn our own.
  return spawnLocalDaemon({ base, port, token, makeClient, opts });
}

interface SpawnArgs {
  base: string;
  port: number;
  token: string | undefined;
  makeClient: () => WigoloClient;
  opts: CreateLocalClientOptions;
}

async function spawnLocalDaemon(args: SpawnArgs): Promise<LocalClient> {
  const { base, port, token, makeClient, opts } = args;
  const baseCommand = resolveCommand(opts);
  const serveArgs = ['serve', '--port', String(port), '--host', LOOPBACK_HOST];

  // Child env: inherit minus daemon host/port overrides; force the token to
  // match this client so daemon and client always agree.
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.WIGOLO_DAEMON_HOST;
  delete childEnv.WIGOLO_DAEMON_PORT;
  if (token !== undefined) childEnv.WIGOLO_API_TOKEN = token;
  else delete childEnv.WIGOLO_API_TOKEN;

  const executable = baseCommand[0];
  let spawnCmd: string;
  let spawnArgs: string[];
  if (isWindows && needsCmdShim(executable)) {
    // Direct .cmd spawn is EINVAL on patched Node (CVE-2024-27980) — go via cmd.
    spawnCmd = 'cmd';
    spawnArgs = ['/c', executable, ...baseCommand.slice(1), ...serveArgs];
  } else {
    spawnCmd = executable;
    spawnArgs = [...baseCommand.slice(1), ...serveArgs];
  }

  const ring = new StderrRing();
  let child: ChildProcess;
  try {
    child = spawn(spawnCmd, spawnArgs, {
      env: childEnv,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    throw spawnLaunchError(err);
  }

  child.stderr?.on('data', (buf: Buffer) => ring.push(buf.toString('utf-8')));

  let exited = false;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = { code, signal };
  });
  let spawnErr: unknown;
  child.on('error', (err) => {
    spawnErr = err;
    exited = true;
  });

  const exitKillHook = (): void => killChild(child, 'SIGKILL');
  process.on('exit', exitKillHook);

  const owned: LocalClient = {
    client: makeClient(),
    owned: true,
    close: async () => {
      process.removeListener('exit', exitKillHook);
      if (exited) return;
      if (isWindows) {
        await killChildWindowsAwait(child);
        return;
      }
      killChild(child, 'SIGTERM');
      const deadline = Date.now() + CLOSE_SIGTERM_GRACE_MS;
      while (!exited && Date.now() < deadline) {
        await sleep(50);
      }
      if (!exited) killChild(child, 'SIGKILL');
    },
  };

  // Step 4: poll /health until 200 within budget.
  const deadline = Date.now() + SPAWN_HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    if (exited) {
      // Step 5: concurrent-spawn race — a rival may have won the port bind.
      const rival = await probeHealth(base, token);
      if (rival.reachable && rival.healthStatus === 200) {
        process.removeListener('exit', exitKillHook);
        await probeCapability(base, port, token);
        return { client: makeClient(), owned: false, close: async () => {} };
      }
      process.removeListener('exit', exitKillHook);
      if (spawnErr) throw spawnLaunchError(spawnErr);
      throw childExitError(port, exitInfo, ring, token);
    }
    const health = await probeHealth(base, token);
    if (health.reachable && health.healthStatus === 200) {
      return owned;
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  // Timed out waiting for health — kill and report.
  process.removeListener('exit', exitKillHook);
  killChild(child, 'SIGKILL');
  throw new Error(
    `Local daemon on port ${port} did not become healthy within ${SPAWN_HEALTH_BUDGET_MS}ms. ` +
      `Try running \`wigolo serve --port ${port}\` manually to see the full output.` +
      stderrTail(ring, token),
  );
}

function spawnLaunchError(err: unknown): Error {
  const code = (err as { code?: string }).code;
  if (code === 'ENOENT' || code === 'EINVAL' || code === 'EACCES') {
    return new Error(
      `The wigolo CLI could not be launched (${code}). ` +
        `Install a REST-capable wigolo (this SDK needs the REST API, newer than ${MIN_REST_VERSION_HINT}), ` +
        `or set WIGOLO_CLI to the executable (or a JSON argv array).`,
    );
  }
  return new Error(`Failed to launch the wigolo CLI: ${String(err)}`);
}

function childExitError(
  port: number,
  exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null,
  ring: StderrRing,
  token: string | undefined,
): Error {
  const how = exitInfo?.signal
    ? `signal ${exitInfo.signal}`
    : `exit code ${exitInfo?.code ?? 'unknown'}`;
  return new Error(
    `The local daemon exited before becoming healthy on port ${port} (${how}). ` +
      `Try running \`wigolo serve --port ${port}\` manually to see the full output.` +
      stderrTail(ring, token),
  );
}

/** Redact every occurrence of the resolved bearer token from a string. */
function redactToken(text: string, token: string | undefined): string {
  if (!token) return text;
  return text.split(token).join('[redacted]');
}

function stderrTail(ring: StderrRing, token: string | undefined): string {
  const tail = redactToken(ring.text(), token);
  return tail.length > 0 ? `\n--- daemon stderr (last lines) ---\n${tail}` : '';
}
