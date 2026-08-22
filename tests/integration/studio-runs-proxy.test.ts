import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowNetworkInThisFile } from '../net-fence.js';

allowNetworkInThisFile(
  'boots a real DaemonHttpServer and a real daemon child on loopback; their background search-backend bootstrap may egress, the run assertions do not',
);

/**
 * WHY: SD1 mini-spec §6 (A-43-5) gives the run store exactly ONE live owner — the process hosting
 * the studio gateway when the app is running, else the daemon. SQLite serializes writers, so the
 * defect two owners cause is not corruption; it is that a live tail is fed by an in-process bus, so
 * a client attached to the daemon would learn about the host's events on RECONNECT instead of live.
 *
 * That claim is about PROCESS BOUNDARIES, so this file spends a real second process on it. Anything
 * in-process would be self-refuting twice over: `getMyInstanceId()` is per-process state, so both
 * halves would take the same branch; and an append made in the test process would publish to the
 * test process's own bus, proving replay and never streaming (the reasoning A-50-1 records).
 *
 * The reconnect row is the one that earns the file. `Last-Event-ID` resume already works in-process
 * (#46 pins it); what is unproven until here is that it survives a hop — a proxy that parsed and
 * re-emitted the frames would pass "the events arrived" and still lose the `id:` line that makes a
 * resume possible.
 *
 * THE CHILD RUNS `dist/`, and that was measured the hard way: with a stale build, removing the
 * self-reference guard left the host-side row green because the child was still running the code
 * from before the change. CI builds before the suite, so the rows there are honest; locally, run
 * `npm run build` after touching `src/daemon/rest/` or the host half of this file tests yesterday.
 */

/** `stdio: ['ignore', 'pipe', 'pipe']` — no stdin, both output streams readable. */
type HostChild = ChildProcessByStdio<null, Readable, Readable>;

const HOST_TOKEN = 'host-secret-token';

/**
 * THE TWO DATA DIRS ARE THE INSTRUMENT, and they were arrived at by measurement rather than design.
 *
 * With ONE shared dir — the real topology — deleting the ownership branch entirely left "a run
 * created on the daemon is the run the host reports" GREEN, because both processes open the same
 * SQLite file and `BEGIN IMMEDIATE` keeps the log correct either way. That is the issue's own
 * statement of the defect: durability is shared, only the LIVE FAN-OUT splits. So a shared-dir
 * version of that row asserts something true of the broken build too.
 *
 * Giving each process its own store separates "which file is on disk" from "which process handled
 * the request": a locally-served create lands somewhere the host cannot see, and the row reds. The
 * handle — the thing the rule actually keys on — is published into BOTH dirs, so the daemon reads a
 * foreign live host and the child still reads itself.
 */
let daemonDataDir: string;
let hostDataDir: string;
let hostInstanceId = '';
let child: HostChild | undefined;
let hostRestPort = 0;
let hostControlPort = 0;
let daemon: import('../../src/daemon/http-server.js').DaemonHttpServer;
let daemonPort = 0;

interface Resp {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

function request(opts: {
  method?: string;
  path: string;
  port: number;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: { Connection: 'close', ...(opts.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 15_000, () => req.destroy(new Error('request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function postJson(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  return request({
    method: 'POST',
    port,
    path,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

interface SseFrame { id?: string; event?: string; data?: string }

/** A live SSE reader that can be killed mid-flight the way a real dropped connection kills one. */
class SseClient {
  readonly frames: SseFrame[] = [];
  readonly comments: string[] = [];
  status = 0;
  headers: http.IncomingHttpHeaders = {};
  /** Every byte the client received, so framing can be compared rather than inferred from parses. */
  raw = '';
  private buffer = '';
  private req?: http.ClientRequest;
  private waiters: Array<() => void> = [];

  open(port: number, path: string, headers: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path, headers: { Accept: 'text/event-stream', ...headers } },
        (res) => {
          this.status = res.statusCode ?? 0;
          this.headers = res.headers;
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            this.raw += chunk;
            this.buffer += chunk;
            this.drain();
          });
          res.on('error', () => { /* our own destroy */ });
          resolve();
        },
      );
      this.req.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(err);
      });
      this.req.end();
    });
  }

  private drain(): void {
    let idx = this.buffer.indexOf('\n\n');
    while (idx !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      if (raw.startsWith(':')) this.comments.push(raw.slice(1).trim());
      else {
        const frame: SseFrame = {};
        for (const line of raw.split('\n')) {
          const sep = line.indexOf(':');
          if (sep === -1) continue;
          const key = line.slice(0, sep);
          const value = line.slice(sep + 1).replace(/^ /, '');
          if (key === 'id') frame.id = value;
          else if (key === 'event') frame.event = value;
          else if (key === 'data') frame.data = value;
        }
        if (frame.id !== undefined || frame.data !== undefined) this.frames.push(frame);
      }
      idx = this.buffer.indexOf('\n\n');
    }
    for (const w of this.waiters.splice(0)) w();
  }

  async waitForFrames(count: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${count} SSE frames; have ${this.frames.length}: ${JSON.stringify(this.frames.map((f) => f.id))}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 25);
        this.waiters.push(() => { clearTimeout(t); r(); });
      });
    }
  }

  kill(): void {
    this.req?.destroy();
  }

  seqs(): number[] {
    return this.frames.map((f) => Number(f.id));
  }
}

/** Append an event INSIDE the host process — the only way to prove live fan-out across the hop. */
async function appendOnHost(runId: string, type: string): Promise<number> {
  const r = await postJson(hostControlPort, '/append', {
    runId,
    actor: { kind: 'daemon' },
    type,
    payload: {},
  });
  expect(r.status).toBe(200);
  return (r.body as { seq: number }).seq;
}

function startHostChild(): Promise<{ rest: number; control: number; instanceId: string }> {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [join(process.cwd(), 'tests/integration/studio-runs-host-child.mjs')], {
      env: { ...process.env, WIGOLO_DATA_DIR: hostDataDir, WIGOLO_TEST_HOST_TOKEN: HOST_TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`host child never reported its ports. stderr:\n${stderr}`)), 60_000);
    child.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf-8');
      const line = out.split('\n').find((l) => l.trim().startsWith('{'));
      if (!line) return;
      clearTimeout(timer);
      resolve(JSON.parse(line) as { rest: number; control: number; instanceId: string });
    });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf-8'); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`host child exited early with ${code}. stderr:\n${stderr}`));
    });
  });
}

beforeAll(async () => {
  // The child imports the BUILT tree, which is also the only way it can be a real second process.
  // Failing loudly here beats a skip: a silently skipped cross-process row is indistinguishable
  // from a passing one in CI output.
  if (!existsSync(join(process.cwd(), 'dist/daemon/http-server.js'))) {
    throw new Error('dist/ is not built — run `npm run build` before this suite (the host child imports it).');
  }

  daemonDataDir = mkdtempSync(join(tmpdir(), 'wigolo-runs-proxy-daemon-'));
  hostDataDir = mkdtempSync(join(tmpdir(), 'wigolo-runs-proxy-host-'));
  process.env.WIGOLO_DATA_DIR = daemonDataDir;
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;

  const ports = await startHostChild();
  hostRestPort = ports.rest;
  hostControlPort = ports.control;
  hostInstanceId = ports.instanceId;

  // The daemon's own view of who is live. Same content as the handle the child wrote for itself —
  // the child reads it as SELF (its instance id), this process reads it as a foreign live host.
  const { writeHandle } = await import('../../src/studio/handle.js');
  writeHandle({
    id: 'integration-session',
    endpoint: `http://127.0.0.1:${hostRestPort}`,
    token: HOST_TOKEN,
    pid: child?.pid ?? 0,
    instanceId: hostInstanceId,
  }, daemonDataDir);

  // The standalone daemon, in THIS process. It holds no instance id, so the handle above reads as a
  // foreign live host and every `/v1/runs*` request here proxies there.
  const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
  daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
  const url = await daemon.start();
  daemonPort = parseInt(new URL(url).port, 10);
}, 120_000);

afterAll(async () => {
  await daemon?.stop();
  child?.kill('SIGKILL');
  delete process.env.WIGOLO_DATA_DIR;
  for (const dir of [daemonDataDir, hostDataDir]) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}, 30_000);

describe('one live run-store owner across two processes', () => {
  it('a run created on the daemon is the run the live host reports', async () => {
    const created = await postJson(daemonPort, '/v1/runs', { task: 'proxied create' });
    expect(created.status).toBe(201);
    const id = (created.body as { run: { id: string } }).run.id;

    // Asked of the HOST directly, with the host's own credential. The two processes hold SEPARATE
    // stores here (see the note on the data dirs), so a create the daemon served itself would land
    // where the host cannot see it and this read would 404.
    const onHost = await request({
      port: hostRestPort,
      path: `/v1/runs/${id}`,
      headers: { Authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(onHost.status).toBe(200);
    expect((onHost.body as { run: { id: string; task: string } }).run.task).toBe('proxied create');

    // And back through the hop, so the daemon's own read is the host's answer too.
    const onDaemon = await request({ port: daemonPort, path: `/v1/runs/${id}` });
    expect(onDaemon.status).toBe(200);
    expect((onDaemon.body as { run: { id: string } }).run.id).toBe(id);
  }, 30_000);

  it('the hop carries the handle token — the daemon client never has to hold the host’s credential', async () => {
    // The host refuses an unauthenticated caller; the daemon does not require one.
    const unauthenticated = await request({ port: hostRestPort, path: '/v1/runs' });
    expect(unauthenticated.status).toBe(401);

    const created = await postJson(daemonPort, '/v1/runs', { task: 'token check' });
    expect(created.status).toBe(201);
    const id = (created.body as { run: { id: string } }).run.id;

    // Decisive in BOTH directions, which a bare 201 is not: a hop that forgot the token would have
    // been 401'd by the host and never written this run, and no hop at all would have written it
    // into the daemon's own store where the host cannot see it.
    const onHost = await request({
      port: hostRestPort,
      path: `/v1/runs/${id}`,
      headers: { Authorization: `Bearer ${HOST_TOKEN}` },
    });
    expect(onHost.status).toBe(200);
  }, 30_000);

  it('an SSE tail on the daemon receives the host’s events LIVE, not on reconnect', async () => {
    const created = await postJson(daemonPort, '/v1/runs', { task: 'live tail' });
    const id = (created.body as { run: { id: string } }).run.id;

    const tail = new SseClient();
    await tail.open(daemonPort, `/v1/runs/${id}/events`);
    // seq 1 is the birth event, replayed from the log.
    await tail.waitForFrames(1);
    expect(tail.status).toBe(200);
    expect(tail.headers['content-type']).toBe('text/event-stream; charset=utf-8');

    const before = tail.frames.length;
    // Appended INSIDE the host process. Its bus has no reach into this one, so a frame arriving on
    // this socket can only have come down the pipe.
    await appendOnHost(id, 'tab.attached');
    await appendOnHost(id, 'run.completed');
    await tail.waitForFrames(before + 2);

    expect(tail.seqs()).toEqual([1, 2, 3]);
    expect(tail.frames[1].event).toBe('tab.attached');
    expect(tail.frames[2].event).toBe('run.completed');
    tail.kill();
  }, 30_000);

  it('killing the proxied stream and reconnecting with Last-Event-ID resumes with no gap and no duplicate', async () => {
    const created = await postJson(daemonPort, '/v1/runs', { task: 'resume across the hop' });
    const id = (created.body as { run: { id: string } }).run.id;

    const first = new SseClient();
    await first.open(daemonPort, `/v1/runs/${id}/events`);
    await first.waitForFrames(1);
    await appendOnHost(id, 'tab.attached');
    await appendOnHost(id, 'run.note');
    await first.waitForFrames(3);
    const seenBefore = first.seqs();
    expect(seenBefore).toEqual([1, 2, 3]);

    // A real dropped connection, not a polite close.
    first.kill();

    // Events the client missed entirely while disconnected.
    await appendOnHost(id, 'run.note');
    await appendOnHost(id, 'run.completed');

    const second = new SseClient();
    await second.open(daemonPort, `/v1/runs/${id}/events`, { 'Last-Event-ID': String(seenBefore[seenBefore.length - 1]) });
    await second.waitForFrames(2);

    // Exactly the missed events, in order, and nothing the first connection already had.
    expect(second.seqs()).toEqual([4, 5]);
    const union = [...seenBefore, ...second.seqs()];
    expect(union).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(union).size).toBe(union.length);
    second.kill();
  }, 30_000);

  it('the id/event/data framing crosses the hop byte-for-byte', async () => {
    const created = await postJson(daemonPort, '/v1/runs', { task: 'framing' });
    const id = (created.body as { run: { id: string } }).run.id;

    const tail = new SseClient();
    await tail.open(daemonPort, `/v1/runs/${id}/events`);
    await tail.waitForFrames(1);

    // The retry directive the host writes at stream open is what governs a browser client's own
    // reconnect backoff; a proxy that re-emitted parsed frames would drop it silently.
    expect(tail.raw.startsWith('retry: 3000\n\n')).toBe(true);
    // `id:` is the line `Last-Event-ID` is built from. Its exact spelling is the resume contract.
    expect(tail.raw).toContain('\nid: 1\nevent: run.created\ndata: {');
    expect(tail.raw.endsWith('\n\n')).toBe(true);
    tail.kill();
  }, 30_000);

  it('the host serves its own store rather than proxying to itself', async () => {
    // The child published a handle naming ITSELF. Asked directly, it must answer from its own store
    // — a self-reference that proxied would loop until a socket ran out, and one that REFUSED would
    // 5xx the host's own REST surface.
    const created = await postJson(hostRestPort, '/v1/runs', { task: 'served by the owner' }, { Authorization: `Bearer ${HOST_TOKEN}` });
    expect(created.status).toBe(201);
    const id = (created.body as { run: { id: string } }).run.id;

    const list = await request({ port: hostRestPort, path: '/v1/runs', headers: { Authorization: `Bearer ${HOST_TOKEN}` } });
    expect(list.status).toBe(200);
    expect((list.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toContain(id);
  }, 30_000);
});

describe('the owner goes away', () => {
  /**
   * Two different situations that a single "the host stopped answering" row would have conflated,
   * and they get opposite answers:
   *
   *   - the host PROCESS is gone — a killed app leaves its handle behind, nothing removes it, and
   *     the run log outlives it. There is no live owner, so this daemon is the owner.
   *   - the host process is ALIVE but its endpoint does not answer — indistinguishable from busy,
   *     so taking the wheel would be a guess that splits the live tail. Fail loud instead.
   */
  it('takes ownership back when the published host process is gone', async () => {
    child?.kill('SIGKILL');
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    const r = await postJson(daemonPort, '/v1/runs', { task: 'the daemon is the owner again' });
    expect(r.status).toBe(201);
    const id = (r.body as { run: { id: string } }).run.id;

    // Served from the daemon's OWN store, which the separate data dirs make checkable.
    const listed = await request({ port: daemonPort, path: '/v1/runs' });
    expect((listed.body as { runs: Array<{ id: string }> }).runs.map((x) => x.id)).toContain(id);
  }, 30_000);

  it('answers with structured JSON rather than hanging when a LIVE host stops answering', async () => {
    // The handle now names a process that is definitely alive — this one — at an endpoint nothing
    // is listening on. That is the case liveness cannot resolve, and the one that must fail loud.
    const dead = await new Promise<number>((resolve) => {
      const s = http.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as { port: number }).port;
        s.close(() => resolve(port));
      });
    });
    const { writeHandle } = await import('../../src/studio/handle.js');
    writeHandle({
      id: 'integration-session',
      endpoint: `http://127.0.0.1:${dead}`,
      token: HOST_TOKEN,
      pid: process.pid,
      instanceId: 'a-live-but-silent-host',
    }, daemonDataDir);

    const r = await request({ port: daemonPort, path: '/v1/runs', timeoutMs: 10_000 });
    expect(r.status).toBe(502);
    const body = r.body as { ok: boolean; error_reason: string; hint?: string };
    expect(body.ok).toBe(false);
    expect(body.error_reason).toBe('studio_host_unreachable');
    // Names the app, never the handle file: an operator told to delete the handle while the app is
    // still up ends up with two processes each believing they own the live fan-out.
    expect(body.hint).toContain('studio app');
    expect(body.hint).not.toContain('current.json');

    // The tail fails the same way — the shape that matters is that it ANSWERS. A stream that hung
    // here would look to a client exactly like a run that had gone quiet.
    const tail = await request({ port: daemonPort, path: '/v1/runs/c29x/events', timeoutMs: 10_000 });
    expect(tail.status).toBe(502);
    expect((tail.body as { error_reason: string }).error_reason).toBe('studio_host_unreachable');
  }, 30_000);
});
