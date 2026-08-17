import { spawn as nodeSpawn, execFileSync as nodeExecFileSync, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ArtifactDelta } from 'wigolo/studio';

/**
 * Client for the studio DB broker (a plain-Node child process that owns the cache DB — the Electron
 * main must never load a native module, spec §13.7/§13.9). Talks newline-delimited JSON-RPC over the
 * child's stdio. §11 resilience: fail-fast (a down/silent broker rejects, never hangs), respawn with
 * backoff on an unexpected exit.
 */
export interface BrokerClient {
  ready(): Promise<void>;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  onArtifact(handler: (delta: ArtifactDelta) => void): void;
  stop(): Promise<void>;
}

type SpawnFn = (cmd: string, args: string[], opts: object) => ChildProcess;
type ExecFileSyncFn = (cmd: string, args: string[], opts: object) => string;

export interface BrokerClientOptions {
  dataDir?: string;
  /**
   * Bypasses runtime resolution + the ABI probe entirely. Programmatic injection only (tests, and a
   * host that has already decided): a caller naming a binary has made the choice we would otherwise
   * have to validate. Production leaves it unset so `resolveBrokerNodeRuntime` runs.
   */
  nodePath?: string;
  brokerPath?: string;
  spawnFn?: SpawnFn;
  execFileSyncFn?: ExecFileSyncFn;
  /** Loud, operator-visible warnings (stderr — never stdout, which is the MCP frame channel). */
  warn?: (line: string) => void;
  callTimeoutMs?: number;
  bootTimeoutMs?: number;
  probeTimeoutMs?: number;
}

/**
 * Matches a path segment that IS an asar archive — `…/app.asar/…`. Deliberately not a substring test:
 * `…/app.asar.unpacked/…` must NOT match, or a second rewrite would produce `app.asar.unpacked.unpacked`.
 * The `.asar` has to be followed by a separator, and `app.asar.unpacked` has a `.` there instead.
 */
const ASAR_SEGMENT = /([\\/])([^\\/]+)\.asar([\\/])/;

/**
 * Rewrite a path pointing INSIDE `…/app.asar` to the sibling `…/app.asar.unpacked` tree. A no-op on any
 * path that is not inside an archive, so dev/test runs are untouched.
 *
 * WHY this exists: the asar archive is a virtual filesystem implemented by a patch Electron installs
 * into its OWN `fs`. The DB broker is a PLAIN-NODE child process (spec §13.7 — the Electron main must
 * never load a native module), and plain Node has no such patch. Every path inside `app.asar` is,
 * to that child, a file that does not exist. So both things the broker needs from the packaged tree —
 * the entry point it is spawned with, and the database engine the ABI probe validates against — have
 * to be named by their real on-disk location.
 */
export function toUnpackedPath(p: string): string {
  return p.replace(ASAR_SEGMENT, (_match, sep: string, archive: string, tail: string) => `${sep}${archive}.asar.unpacked${tail}`);
}

/**
 * Resolve the broker entry from `anchor`, having first moved the anchor out of the archive.
 *
 * The rewritten anchor is SYNTHETIC in a packaged app: only `node_modules/**` is unpacked, so
 * `…/app.asar.unpacked/out/main/index.js` does not exist on disk and never will. That is fine and it is
 * the point — `createRequire` never stats its anchor, it only walks `node_modules` upward from the
 * anchor's directory. Anchoring there is what makes the walk land in `app.asar.unpacked/node_modules`
 * (real files a plain-Node child can open) instead of `app.asar/node_modules` (archive members it
 * cannot). Do NOT "fix" this by pointing the anchor at a file that exists; that reintroduces the bug.
 * `tests/e2e/packaging.spec.ts` resolves the packaged native modules through the same synthetic anchor.
 */
export function resolveBrokerPathFrom(anchor: string): string {
  return createRequire(toUnpackedPath(anchor)).resolve('wigolo/studio-db-broker');
}

/** The built broker entry, resolved via the `wigolo/studio-db-broker` export subpath (spawned, not imported). */
export function resolveBrokerPath(): string {
  return resolveBrokerPathFrom(fileURLToPath(import.meta.url));
}

export type NodeRuntimeSource = 'WIGOLO_STUDIO_BROKER_NODE' | 'npm_node_execpath' | 'process.execPath' | 'PATH';
export interface NodeRuntimeCandidate {
  /** The binary to exec. `'node'` for the PATH candidate — the exec resolves it, we never shell out to `which`. */
  readonly path: string;
  readonly source: NodeRuntimeSource;
  /** How the candidate reads in an error message ("`node` on PATH", not just "node"). */
  readonly label: string;
}
export interface NodeRuntimeRejection {
  readonly candidate: NodeRuntimeCandidate;
  readonly reason: string;
}
export type NodeRuntimeResolution =
  | { readonly ok: true; readonly path: string; readonly source: NodeRuntimeSource; readonly abi: string }
  | { readonly ok: false; readonly message: string; readonly rejected: readonly NodeRuntimeRejection[] };

/** At most: one override, OR npm_node_execpath + process.execPath + PATH. Asserted by test — an
 *  unbounded candidate walk would spawn a probe per entry with nothing capping the total. */
export const MAX_NODE_RUNTIME_CANDIDATES = 3;
const PROBE_SENTINEL = '__wigolo_broker_abi_ok__';

/**
 * Candidates in priority order. The override short-circuits to a list of ONE: when an operator names a
 * binary and it is unusable, the answer is to say so — falling through to a different runtime would
 * silently ignore the instruction, which is the failure this whole path exists to prevent.
 */
export function nodeRuntimeCandidates(env: NodeJS.ProcessEnv = process.env): NodeRuntimeCandidate[] {
  const override = env.WIGOLO_STUDIO_BROKER_NODE?.trim();
  if (override) return [{ path: override, source: 'WIGOLO_STUDIO_BROKER_NODE', label: `WIGOLO_STUDIO_BROKER_NODE (${override})` }];

  const out: NodeRuntimeCandidate[] = [];
  const seen = new Set<string>();
  const push = (path: string | undefined, source: NodeRuntimeSource, label: string): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ path, source, label });
  };
  push(env.npm_node_execpath?.trim(), 'npm_node_execpath', `npm_node_execpath (${env.npm_node_execpath?.trim() ?? ''})`);
  // Under Electron `process.execPath` is the Electron binary — a different ABI that cannot load the
  // database engine, and ELECTRON_RUN_AS_NODE does not change that. Under plain Node (dev, tests) it is
  // the best candidate there is. We do not guess either way past this point: the probe decides.
  if (!process.versions.electron) push(process.execPath, 'process.execPath', `the current runtime (${process.execPath})`);
  push('node', 'PATH', '`node` on PATH');
  return out;
}

/** The database engine the broker will actually load, resolved from the broker entry itself so the probe
 *  exercises the same file — not some other copy hoisted elsewhere in the tree. */
export function resolveDatabaseModulePath(brokerPath: string): string {
  return createRequire(pathToFileURL(brokerPath)).resolve('better-sqlite3');
}

/**
 * Bounded ABI probe. It OPENS a database — `require()` of an ABI-mismatched native build SUCCEEDS and
 * yields a callable constructor; only `new Database()` throws. A probe that stopped at `typeof Database`
 * would report a false pass on exactly the runtime we are trying to reject.
 */
export function probeNodeRuntime(
  nodePath: string,
  databaseModulePath: string,
  opts: { execFileSyncFn?: ExecFileSyncFn; timeoutMs?: number } = {},
): { ok: true; abi: string } | { ok: false; reason: string } {
  const exec = opts.execFileSyncFn ?? (nodeExecFileSync as unknown as ExecFileSyncFn);
  const script =
    `const D=require(${JSON.stringify(databaseModulePath)});` +
    `const d=new D(":memory:");d.close();` +
    `process.stdout.write(${JSON.stringify(PROBE_SENTINEL)}+process.versions.modules);`;
  let out: string;
  try {
    out = exec(nodePath, ['-e', script], {
      timeout: opts.timeoutMs ?? 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, reason: describeProbeFailure(err) };
  }
  const at = String(out ?? '').indexOf(PROBE_SENTINEL);
  if (at < 0) return { ok: false, reason: 'the runtime did not report a working database engine' };
  return { ok: true, abi: String(out).slice(at + PROBE_SENTINEL.length).trim() };
}

function describeProbeFailure(err: unknown): string {
  const e = err as { code?: string; signal?: string | null; stderr?: string | Buffer; message?: string };
  if (e?.code === 'ENOENT') return 'not found (no such executable)';
  if (e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM') return 'the runtime did not answer the database probe in time';
  const stderr = typeof e?.stderr === 'string' ? e.stderr : e?.stderr?.toString('utf8') ?? '';
  const detail = stderr.trim() || e?.message?.trim() || 'unknown error';
  return `the database engine refused this runtime — ${collapse(detail)}`;
}

/**
 * A native-loader failure arrives as a code frame, then the message, then a stack. Only the message says
 * anything a reader can act on, so keep that and drop the rest — an error nobody finishes reading is the
 * inscrutable failure this slice exists to stop producing.
 */
function collapse(text: string): string {
  const start = text.search(/^[A-Za-z]*Error: /m);
  const body = start >= 0 ? text.slice(start) : text;
  const stackAt = body.search(/\n\s+at /);
  const one = (stackAt >= 0 ? body.slice(0, stackAt) : body).replace(/\s+/g, ' ').trim();
  return one.length > 400 ? `${one.slice(0, 400)}…` : one;
}

/**
 * Resolve the Node runtime the broker will run on, and PROVE it can open the database before returning
 * it. Never returns a guess: a wrong-but-startable runtime surfaces later as an inscrutable native-module
 * error, which is strictly worse than refusing here with the cause and the remedy.
 */
export function resolveBrokerNodeRuntime(
  opts: { env?: NodeJS.ProcessEnv; brokerPath: string; execFileSyncFn?: ExecFileSyncFn; probeTimeoutMs?: number },
): NodeRuntimeResolution {
  let databaseModulePath: string;
  try {
    databaseModulePath = resolveDatabaseModulePath(opts.brokerPath);
  } catch {
    return {
      ok: false,
      rejected: [],
      message:
        'studio local database service cannot start: this install has no database engine next to the background ' +
        'service, so no Node runtime can be validated. Reinstall wigolo, then set WIGOLO_STUDIO_BROKER_NODE if you ' +
        'run the service on a specific Node binary.',
    };
  }

  const candidates = nodeRuntimeCandidates(opts.env ?? process.env).slice(0, MAX_NODE_RUNTIME_CANDIDATES);
  const rejected: NodeRuntimeRejection[] = [];
  for (const candidate of candidates) {
    const probe = probeNodeRuntime(candidate.path, databaseModulePath, {
      execFileSyncFn: opts.execFileSyncFn,
      timeoutMs: opts.probeTimeoutMs,
    });
    if (probe.ok) return { ok: true, path: candidate.path, source: candidate.source, abi: probe.abi };
    rejected.push({ candidate, reason: probe.reason });
  }
  return { ok: false, rejected, message: describeNoRuntime(rejected) };
}

function describeNoRuntime(rejected: readonly NodeRuntimeRejection[]): string {
  const tried = rejected.length
    ? rejected.map((r) => `  - ${r.candidate.label}: ${r.reason}`).join('\n')
    : '  - (no candidate runtime was available)';
  const overrode = rejected.some((r) => r.candidate.source === 'WIGOLO_STUDIO_BROKER_NODE');
  const remedy = overrode
    ? 'WIGOLO_STUDIO_BROKER_NODE names that binary, so no other runtime was tried. Point it at a Node ' +
      'binary that can open this install\'s database (matching build ABI), or unset it to search again.'
    : 'Set WIGOLO_STUDIO_BROKER_NODE to a Node binary that can open this install\'s database — it must ' +
      'match the ABI the database engine was built for, and loading the engine is not enough on its own.';
  return `studio local database service cannot start: no usable Node runtime.\nTried:\n${tried}\n${remedy}`;
}

/** A client that only ever reports why it is dead. Loud (the reason travels to every caller), not fatal. */
function deadClient(reason: string): BrokerClient {
  return {
    ready: () => Promise.reject(new Error(reason)),
    call: () => Promise.reject(new Error(reason)),
    onArtifact: () => { /* never fires */ },
    stop: async () => { /* nothing to stop */ },
  };
}

export function createBrokerClient(opts: BrokerClientOptions = {}): BrokerClient {
  const spawnFn = opts.spawnFn ?? (nodeSpawn as unknown as SpawnFn);
  const warn = opts.warn ?? ((line: string) => { process.stderr.write(line); });
  // Resolving the broker entry must NEVER crash app boot — a failure here degrades captures to
  // `capture_unavailable` (§11), it does not take down the human UI or the P1/P2 agent line.
  let brokerPath: string;
  try {
    brokerPath = opts.brokerPath ?? resolveBrokerPath();
  } catch {
    return deadClient('studio background service unavailable');
  }

  // The runtime is resolved and PROVEN, never guessed. Refusing here is deliberate: a broker started on
  // the wrong Node fails later as a native-module error nobody can act on.
  let nodePath: string;
  if (opts.nodePath) {
    nodePath = opts.nodePath;
  } else {
    const runtime = resolveBrokerNodeRuntime({ brokerPath, execFileSyncFn: opts.execFileSyncFn, probeTimeoutMs: opts.probeTimeoutMs });
    if (!runtime.ok) {
      warn(`[studio] ${runtime.message}\n`);
      return deadClient(runtime.message);
    }
    nodePath = runtime.path;
  }

  const callTimeoutMs = opts.callTimeoutMs ?? 15_000;
  const bootTimeoutMs = opts.bootTimeoutMs ?? 20_000;

  let child: ChildProcess | null = null;
  let nextId = 1;
  let buf = '';
  let stopped = false;
  let backoff = 250;
  let readyResolve: (() => void) | null = null;
  let readyPromise: Promise<void> = new Promise((r) => { readyResolve = r; });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const artifactHandlers: Array<(d: ArtifactDelta) => void> = [];

  const rejectAllPending = (reason: string): void => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
    pending.clear();
  };

  const onLine = (line: string): void => {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (msg.notify === 'ready') { readyResolve?.(); return; }
    if (msg.notify === 'artifact') { for (const h of artifactHandlers) h(msg.delta as ArtifactDelta); return; }
    const id = msg.id as number | undefined;
    if (id == null) return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error((msg.error as { message?: string })?.message ?? 'broker error'));
  };

  const scheduleRespawn = (): void => {
    if (!stopped) { setTimeout(() => { if (!stopped) start(); }, backoff); backoff = Math.min(backoff * 2, 5_000); }
  };

  const start = (): void => {
    try {
      child = spawnFn(nodePath, [brokerPath], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: { ...process.env, WIGOLO_STUDIO_BROKER_MAIN: '1', ...(opts.dataDir ? { WIGOLO_DATA_DIR: opts.dataDir } : {}) },
      });
    } catch {
      // A synchronous spawn throw (bad argument shape). ENOENT does NOT arrive here — see the 'error'
      // handler below.
      child = null;
      scheduleRespawn();
      return;
    }
    // `spawn` reports a missing/unexecutable binary ASYNCHRONOUSLY as an 'error' event, never as the
    // throw the catch above expects. With no handler, Node re-throws it as an unhandled 'error' and the
    // whole Electron main goes down — the one failure a background service must never cause. `gone`
    // keeps this idempotent: after 'error', 'exit' may or may not follow.
    let gone = false;
    const onGone = (reason: string): void => {
      if (gone) return;
      gone = true;
      rejectAllPending(reason);
      buf = ''; // drop any partial line from the dead child — else it corrupts the respawn's first frame (can eat `ready`)
      if (stopped) return;
      readyPromise = new Promise((r) => { readyResolve = r; });
      scheduleRespawn();
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); onLine(line); }
    });
    child.on('error', (err: unknown) => {
      warn(`[studio] background service failed to start on ${nodePath}: ${err instanceof Error ? err.message : String(err)}\n`);
      onGone('studio background service failed to start');
    });
    child.on('exit', () => { onGone('studio background service exited'); });
  };
  start();

  const bootGuard = <T>(pr: Promise<T>): Promise<T> =>
    Promise.race([pr, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('studio background service not ready')), bootTimeoutMs))]);

  return {
    ready: () => bootGuard(readyPromise),
    async call<T>(method: string, params?: unknown): Promise<T> {
      await this.ready();
      if (!child || child.exitCode != null) throw new Error('studio background service unavailable');
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('studio background service timed out')); }, callTimeoutMs);
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        child!.stdin?.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    onArtifact(handler) { artifactHandlers.push(handler); },
    async stop() { stopped = true; rejectAllPending('stopped'); child?.kill(); child = null; },
  };
}
