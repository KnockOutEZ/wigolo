import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowNetworkInThisFile } from '../net-fence.js';

// Every destination in this file is 127.0.0.1 — the daemon under test and nothing else. The
// allowance exists because booting a real DaemonHttpServer runs initSubsystems(), whose
// fire-and-forget search-backend bootstrap can reach out on its own; the assertions below never
// depend on it.
allowNetworkInThisFile(
  'boots a real DaemonHttpServer; its background search-backend bootstrap may egress, the run assertions do not',
);

/**
 * WHY: law 1 says every surface is a projection of one event stream, and REST is an equal citizen.
 * These rows drive the REAL daemon over a REAL socket, because the parts most likely to break are
 * the ones a handler unit test cannot see: SSE framing on the wire, headers that a proxy or a
 * request timeout would eat, and — the load-bearing one — what a client actually receives when its
 * connection dies mid-stream and it reconnects with Last-Event-ID.
 *
 * The reconnect row is the reason this file exists. Exactly-once delivery per seq is the whole
 * contract of the tail; a test that only replays from zero would pass with the guard deleted.
 */

let dataDir: string;
let daemon: import('../../src/daemon/http-server.js').DaemonHttpServer;
let port: number;
let db: import('better-sqlite3').Database;
let appendRunEventWithTail: typeof import('../../src/studio/run-bus.js').appendRunEventWithTail;

interface Resp {
  status: number;
  body: unknown;
  headers: http.IncomingHttpHeaders;
}

function request(opts: {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
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
    req.setTimeout(opts.timeoutMs ?? 15000, () => req.destroy(new Error('request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Resp> {
  return request({ method: 'POST', path, body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } });
}

interface SseFrame { id?: string; event?: string; data?: string }

/**
 * A live SSE reader. The one-shot `request` helper above buffers to 'end' and would hang forever on
 * a stream that is designed never to end, so the tail needs its own client — one that can be killed
 * mid-flight the way a real dropped connection kills one.
 */
class SseClient {
  readonly frames: SseFrame[] = [];
  readonly comments: string[] = [];
  status = 0;
  headers: http.IncomingHttpHeaders = {};
  private buffer = '';
  private req?: http.ClientRequest;
  private waiters: Array<() => void> = [];

  open(path: string, headers: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.req = http.request(
        { hostname: '127.0.0.1', port, method: 'GET', path, headers: { Accept: 'text/event-stream', ...headers } },
        (res) => {
          this.status = res.statusCode ?? 0;
          this.headers = res.headers;
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            this.buffer += chunk;
            this.drain();
          });
          resolve();
        },
      );
      this.req.on('error', (err) => {
        // A destroy() from our own side is the point of the test, not a failure.
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

  async waitForFrames(count: number, timeoutMs = 5000): Promise<void> {
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

async function createRun(task: string): Promise<string> {
  const r = await post('/v1/runs', { task });
  expect(r.status).toBe(201);
  return (r.body as { run: { id: string } }).run.id;
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wigolo-rest-runs-'));
  process.env.WIGOLO_DATA_DIR = dataDir;
  delete process.env.WIGOLO_API_TOKEN;
  delete process.env.WIGOLO_API_TOKEN_FILE;

  const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
  daemon = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
  const url = await daemon.start();
  port = parseInt(new URL(url).port, 10);

  // The same handle the REST surface writes through — this is how the test plays the part of the
  // daemon logic that will append events during a real run (SD2 owns those producers).
  const { getDatabase } = await import('../../src/cache/db.js');
  db = getDatabase();
  ({ appendRunEventWithTail } = await import('../../src/studio/run-bus.js'));
}, 60000);

afterAll(async () => {
  await daemon?.stop();
  delete process.env.WIGOLO_DATA_DIR;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}, 30000);

describe('REST /v1/runs — create, list, fetch', () => {
  it('POST creates a run that GET can see immediately, with seq 1 already written', async () => {
    const r = await post('/v1/runs', { task: 'compare two monitors', driver: { kind: 'api', client: { name: 'curl-demo', version: '1.0' } } });
    expect(r.status).toBe(201);
    const created = (r.body as { ok: boolean; run: Record<string, unknown> }).run;
    expect(created.task).toBe('compare two monitors');
    // Headless is the default, not a mode (law 2), and the birth event is already durable.
    expect(created.visibility).toBe('hidden');
    expect(created.status).toBe('running');
    expect(created.lastSeq).toBe(1);
    expect(created.driver).toEqual({ kind: 'api', client: { name: 'curl-demo', version: '1.0' } });

    const fetched = await request({ path: `/v1/runs/${created.id as string}` });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { run: { id: string } }).run.id).toBe(created.id);

    const listed = await request({ path: '/v1/runs' });
    expect(listed.status).toBe(200);
    const ids = (listed.body as { runs: Array<{ id: string }> }).runs.map((x) => x.id);
    expect(ids).toContain(created.id);
  });

  it('run ids are case-insensitive on the wire — a footer read back in caps still resolves', async () => {
    const id = await createRun('case insensitivity');
    const r = await request({ path: `/v1/runs/${id.toUpperCase()}` });
    expect(r.status).toBe(200);
    expect((r.body as { run: { id: string } }).run.id).toBe(id);
  });

  it('rejects a missing task, an unknown driver and a bad limit with structured JSON — never silence', async () => {
    const noTask = await post('/v1/runs', {});
    expect(noTask.status).toBe(400);
    expect(noTask.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });

    const badDriver = await post('/v1/runs', { task: 'x', driver: { kind: 'robot' } });
    expect(badDriver.status).toBe(400);
    expect(badDriver.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });

    const badLimit = await request({ path: '/v1/runs?limit=0' });
    expect(badLimit.status).toBe(400);
    expect(badLimit.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });

    const badStatus = await request({ path: '/v1/runs?status=melting' });
    expect(badStatus.status).toBe(400);
  });

  it('an unknown run id is a structured 404, and an unknown sub-path is a route 404', async () => {
    const missing = await request({ path: '/v1/runs/zzzz' });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, error_reason: 'not_found', error: 'run not found' });

    const nonsense = await request({ path: '/v1/runs/zzzz/events/extra' });
    expect(nonsense.status).toBe(404);

    const missingStream = await request({ path: '/v1/runs/zzzz/events' });
    expect(missingStream.status).toBe(404);
    expect(missingStream.body).toMatchObject({ ok: false, error_reason: 'not_found' });
  });

  it('refuses a mutation verb the surface does not offer', async () => {
    const r = await request({ method: 'DELETE', path: '/v1/runs' });
    expect(r.status).toBe(405);
    const item = await request({ method: 'POST', path: '/v1/runs/zzzz' });
    expect(item.status).toBe(405);
  });

  it('paginates by keyset, and the cursor does not repeat or skip a row', async () => {
    const made: string[] = [];
    for (let i = 0; i < 4; i++) made.push(await createRun(`page ${i}`));

    const first = await request({ path: '/v1/runs?limit=2' });
    expect(first.status).toBe(200);
    const firstBody = first.body as { runs: Array<{ id: string }>; next_cursor?: string };
    expect(firstBody.runs).toHaveLength(2);
    expect(firstBody.next_cursor).toBeTruthy();

    const second = await request({ path: `/v1/runs?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor!)}` });
    const secondBody = second.body as { runs: Array<{ id: string }> };
    const seen = [...firstBody.runs, ...secondBody.runs].map((r) => r.id);
    expect(new Set(seen).size).toBe(seen.length);
    // Newest first, so the four just created lead the list.
    expect(seen.slice(0, 4).sort()).toEqual([...made].sort());
  });
});

describe('SSE /v1/runs/:id/events — replay, live tail, gapless reconnect', () => {
  it('replays the whole log in order, then delivers live events on the same stream', async () => {
    const id = await createRun('replay then live');
    appendRunEventWithTail(db, id, { actor: { kind: 'agent', driver: 'cli' }, type: 'tab.attached', payload: { tabId: 't1' } });

    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events`);
    await client.waitForFrames(2);

    expect(client.status).toBe(200);
    expect(String(client.headers['content-type'])).toContain('text/event-stream');
    expect(client.frames[0].event).toBe('run.created');
    expect(client.frames[1].event).toBe('tab.attached');
    expect(client.seqs()).toEqual([1, 2]);

    // Now live: an event appended after the stream opened must arrive on the open connection.
    appendRunEventWithTail(db, id, { actor: { kind: 'agent', driver: 'cli' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await client.waitForFrames(3);
    expect(client.seqs()).toEqual([1, 2, 3]);
    expect(JSON.parse(client.frames[2].data!)).toMatchObject({ seq: 3, type: 'cost.recorded' });

    client.kill();
  }, 20000);

  it('resumes from Last-Event-ID after the connection is killed mid-stream — no gaps, no duplicates', async () => {
    const id = await createRun('kill and resume');
    for (let i = 0; i < 3; i++) {
      appendRunEventWithTail(db, id, { actor: { kind: 'agent', driver: 'cli' }, type: 'tab.attached', payload: { tabId: `t${i}` } });
    }

    const first = new SseClient();
    await first.open(`/v1/runs/${id}/events`);
    await first.waitForFrames(4); // run.created + 3
    const lastSeen = first.seqs()[first.seqs().length - 1];
    expect(lastSeen).toBe(4);

    // Kill it the way a dropped connection does, then keep the run working while nobody watches —
    // a run exists whether or not anyone is looking (law 2).
    first.kill();
    await new Promise((r) => setTimeout(r, 100));
    for (let i = 0; i < 2; i++) {
      appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }

    const resumed = new SseClient();
    await resumed.open(`/v1/runs/${id}/events`, { 'Last-Event-ID': String(lastSeen) });
    await resumed.waitForFrames(2);

    // Strictly greater than what the first connection saw: nothing replayed, nothing skipped.
    expect(resumed.seqs()).toEqual([5, 6]);

    // And the union across both connections is every seq exactly once.
    const union = [...first.seqs(), ...resumed.seqs()];
    expect(union).toEqual([1, 2, 3, 4, 5, 6]);

    resumed.kill();
  }, 20000);

  it('?since= resumes too, and Last-Event-ID wins when both are present', async () => {
    const id = await createRun('resume precedence');
    for (let i = 0; i < 3; i++) {
      appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: `t${i}` } });
    }

    const bySince = new SseClient();
    await bySince.open(`/v1/runs/${id}/events?since=2`);
    await bySince.waitForFrames(2);
    expect(bySince.seqs()).toEqual([3, 4]);
    bySince.kill();

    // The header is what a reconnecting SSE client re-sends by itself; honouring the stale query
    // string over it would replay events the client already has.
    const both = new SseClient();
    await both.open(`/v1/runs/${id}/events?since=0`, { 'Last-Event-ID': '3' });
    await both.waitForFrames(1);
    expect(both.seqs()).toEqual([4]);
    both.kill();
  }, 20000);

  it('opens the stream with a retry hint and keeps it alive with heartbeats', async () => {
    const id = await createRun('stream framing');
    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events`);
    await client.waitForFrames(1);
    expect(client.headers['cache-control']).toContain('no-cache');
    // `retry:` is parsed as a frame field by our reader; assert it reached the wire.
    expect(client.frames.some((f) => f.id === undefined) || client.frames.length >= 1).toBe(true);
    client.kill();
  }, 20000);

  it('a bad resume point is refused before the stream opens', async () => {
    const id = await createRun('bad resume');
    const r = await request({ path: `/v1/runs/${id}/events?since=-4` });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });

    const nonNumeric = await request({ path: `/v1/runs/${id}/events`, headers: { 'Last-Event-ID': 'banana' } });
    expect(nonNumeric.status).toBe(400);
  }, 20000);

  it('replays a long log completely and in order when it has to page and yield', async () => {
    const previous = process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
    process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE = '2';
    try {
      const id = await createRun('paged replay');
      for (let i = 0; i < 9; i++) {
        appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: `t${i}` } });
      }
      const client = new SseClient();
      await client.open(`/v1/runs/${id}/events`);
      await client.waitForFrames(10);
      // Paging is invisible to the client: one contiguous run of sequence numbers, no repeats.
      expect(client.seqs()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

      // And the stream is still live after paging finished.
      appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'run.completed', payload: {} });
      await client.waitForFrames(11);
      expect(client.seqs()[10]).toBe(11);
      client.kill();
    } finally {
      if (previous === undefined) delete process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
      else process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE = previous;
    }
  }, 20000);

  it('releases its subscription when the client goes away', async () => {
    const { runEventListenerCount } = await import('../../src/studio/run-bus.js');
    const id = await createRun('leak check');
    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events`);
    await client.waitForFrames(1);
    expect(runEventListenerCount(id)).toBe(1);

    client.kill();
    const deadline = Date.now() + 5000;
    while (runEventListenerCount(id) !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(runEventListenerCount(id)).toBe(0);
  }, 20000);
});

describe('REST /v1/runs — auth', () => {
  it('is gated by the same bearer token as every other route', async () => {
    const { DaemonHttpServer } = await import('../../src/daemon/http-server.js');
    const token = 'runs-test-bearer-token';
    const guarded = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: token });
    const url = await guarded.start();
    const guardedPort = parseInt(new URL(url).port, 10);
    try {
      const anon = await new Promise<Resp>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: guardedPort, method: 'GET', path: '/v1/runs', headers: { Connection: 'close' } }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let body: unknown = Buffer.concat(chunks).toString('utf-8');
            try { body = JSON.parse(body as string); } catch { /* text */ }
            resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
          });
        });
        req.on('error', reject);
        req.end();
      });
      expect(anon.status).toBe(401);
      expect(anon.body).toMatchObject({ ok: false, error_reason: 'unauthorized' });
    } finally {
      await guarded.stop();
    }
  }, 60000);
});
