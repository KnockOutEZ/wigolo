/**
 * Minimal stdio MCP client used by the profiling spike.
 *
 * Deliberately hand-rolled rather than using the SDK client: the spike needs a
 * timestamp taken the instant BEFORE spawn and the instant a specific frame
 * lands, on the same `performance.timeOrigin + performance.now()` epoch clock
 * the in-child probe uses. An SDK client hides the spawn boundary.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

export function nowEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

export interface ProbeInterval {
  kind: string;
  t0: number;
  t1: number;
  host?: string;
  status?: number;
  failed?: boolean;
}

export interface ProbeSample {
  t: number;
  rss: number;
  cpu_user_us: number;
  cpu_system_us: number;
}

export interface ProbePayload {
  pid: number;
  node: string;
  time_origin: number;
  exit_t?: number;
  max_rss_raw: number;
  intervals: ProbeInterval[];
  marks: { name: string; t: number }[];
  samples: ProbeSample[];
}

export interface SpawnOpts {
  distEntry: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
  /** Absolute path the in-child probe flushes to; omit to run uninstrumented. */
  probeOut?: string;
  hookPath?: string;
  nodeArgs?: string[];
}

export class McpChild {
  readonly proc: ChildProcessWithoutNullStreams;
  readonly spawnedAt: number;
  private buf = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; sentAt: number }
  >();
  private readonly resultTimes = new Map<number, number>();
  stderr = '';

  constructor(private opts: SpawnOpts) {
    const nodeArgs = [...(opts.nodeArgs ?? [])];
    if (opts.probeOut) {
      nodeArgs.push('--import', opts.hookPath ?? '');
    }
    this.spawnedAt = nowEpochMs();
    this.proc = spawn(
      process.execPath,
      [...nodeArgs, opts.distEntry, ...(opts.args ?? ['mcp'])],
      {
        env: { ...opts.env, ...(opts.probeOut ? { WIGOLO_PROFILE_OUT: opts.probeOut } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ) as ChildProcessWithoutNullStreams;

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (c: string) => {
      this.stderr += c;
    });
  }

  private onStdout(chunk: string): void {
    // Timestamp taken before any parsing so the number is arrival, not decode.
    const arrived = nowEpochMs();
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof msg.id !== 'number') continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      this.resultTimes.set(msg.id, arrived);
      if (msg.error) p.reject(new Error(msg.error.message ?? 'mcp error'));
      else p.resolve(msg.result);
    }
  }

  send(method: string, params?: unknown): { id: number; sentAt: number; done: Promise<unknown> } {
    const id = this.nextId++;
    const sentAt = nowEpochMs();
    const done = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, sentAt });
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return { id, sentAt, done };
  }

  notify(method: string, params?: unknown): void {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  arrivalOf(id: number): number | undefined {
    return this.resultTimes.get(id);
  }

  /** Full MCP handshake. Resolves when `initialize` returns — "ready". */
  async handshake(): Promise<{ id: number; sentAt: number; readyAt: number }> {
    const { id, sentAt, done } = this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wigolo-profile', version: '0' },
    });
    await done;
    this.notify('notifications/initialized');
    return { id, sentAt, readyAt: this.arrivalOf(id)! };
  }

  async callTool(name: string, args: Record<string, unknown>) {
    const { id, sentAt, done } = this.send('tools/call', { name, arguments: args });
    const result = await done;
    return { id, sentAt, doneAt: this.arrivalOf(id)!, result };
  }

  /** SIGTERM (the server handles it and exits cleanly, which flushes the probe). */
  async stop(timeoutMs = 15_000): Promise<number | null> {
    if (this.proc.exitCode !== null) return this.proc.exitCode;
    const exited = new Promise<number | null>((resolve) => {
      this.proc.once('exit', (code) => resolve(code));
    });
    this.proc.kill('SIGTERM');
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref());
    const outcome = await Promise.race([exited, timer]);
    if (outcome === 'timeout') {
      this.proc.kill('SIGKILL');
      return exited;
    }
    return outcome;
  }

  /**
   * Read the probe flush. Refuses a file without `exit_t` — a partial log reads
   * exactly like a finished result and would silently under-report.
   */
  readProbe(): ProbePayload {
    const out = this.opts.probeOut;
    if (!out) throw new Error('child was spawned without a probe');
    if (!existsSync(out)) throw new Error(`probe never flushed: ${out}`);
    const payload = JSON.parse(readFileSync(out, 'utf8')) as ProbePayload;
    if (typeof payload.exit_t !== 'number') {
      throw new Error(`probe log is partial (no exit_t) — rerun: ${out}`);
    }
    return payload;
  }
}

// --- interval maths ---------------------------------------------------------

/** Clip intervals to a window, then return the UNION length in ms. */
export function unionMs(intervals: { t0: number; t1: number }[], from: number, to: number): number {
  const clipped = intervals
    .map((i) => ({ t0: Math.max(i.t0, from), t1: Math.min(i.t1, to) }))
    .filter((i) => i.t1 > i.t0)
    .sort((a, b) => a.t0 - b.t0);
  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const i of clipped) {
    if (curEnd < i.t0) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = i.t0;
      curEnd = i.t1;
    } else {
      curEnd = Math.max(curEnd, i.t1);
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

/** Sum of clipped durations — exceeds wall-clock when calls run concurrently. */
export function sumMs(intervals: { t0: number; t1: number }[], from: number, to: number): number {
  return intervals.reduce(
    (acc, i) => acc + Math.max(0, Math.min(i.t1, to) - Math.max(i.t0, from)),
    0,
  );
}

export function stats(values: number[]) {
  if (values.length === 0) return { n: 0, min: 0, median: 0, max: 0 };
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    n: s.length,
    min: round(s[0]),
    median: round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2),
    max: round(s[s.length - 1]),
  };
}

export function round(n: number): number {
  return Number(n.toFixed(1));
}

/** CPU microseconds consumed inside [from, to], interpolated from the samples. */
export function cpuUsInWindow(samples: ProbeSample[], from: number, to: number): number {
  const inWin = samples.filter((s) => s.t >= from && s.t <= to);
  if (inWin.length < 2) return 0;
  const first = inWin[0];
  const last = inWin[inWin.length - 1];
  return last.cpu_user_us + last.cpu_system_us - (first.cpu_user_us + first.cpu_system_us);
}

export function peakRssInWindow(samples: ProbeSample[], from: number, to: number): number {
  const inWin = samples.filter((s) => s.t >= from && s.t <= to);
  return inWin.length ? Math.max(...inWin.map((s) => s.rss)) : 0;
}
