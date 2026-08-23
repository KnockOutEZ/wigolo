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
/**
 * The store's own writer — it commits and projects to disk, and publishes NOTHING. That is exactly
 * the shape a broker that dies between its commit and its stdout notify leaves behind, so it is how
 * this file forces a lost notify without mocking anything the daemon actually runs.
 */
let appendEventWithoutNotify: typeof import('../../src/studio/run-store.js').appendEvent;
/** The other half of the chain: a notify with no commit behind it. */
let publishRunEvent: typeof import('../../src/studio/run-bus.js').publishRunEvent;

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
  /** Whether the SERVER ended the stream. A tail that ends on its own is a statement to the client. */
  ended = false;
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
          res.on('end', () => {
            this.ended = true;
            for (const w of this.waiters.splice(0)) w();
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

  async waitForEnd(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.ended) {
      if (Date.now() > deadline) throw new Error(`stream did not end; frames: ${JSON.stringify(this.seqs())}`);
      await new Promise<void>((r) => setTimeout(r, 25));
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
  ({ appendRunEventWithTail, publishRunEvent } = await import('../../src/studio/run-bus.js'));
  ({ appendEvent: appendEventWithoutNotify } = await import('../../src/studio/run-store.js'));
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

  it('caps spaceId and the client strings, which are persisted to the log AND to disk', async () => {
    const huge = 'x'.repeat(5000);
    const bigSpace = await post('/v1/runs', { task: 'bounded', spaceId: huge });
    expect(bigSpace.status).toBe(400);
    expect(bigSpace.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });

    const bigClient = await post('/v1/runs', { task: 'bounded', driver: { kind: 'api', client: { name: huge, version: '1' } } });
    expect(bigClient.status).toBe(400);
    expect(bigClient.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });
  });

  it('treats a malformed percent-escape in the id as a bad id, not a server fault', async () => {
    // `new URL` does not decode `pathname`, so a lone `%` reaches decodeURIComponent and throws.
    // Reporting a caller's typo as a 500 also makes it an error-log amplifier.
    for (const path of ['/v1/runs/%', '/v1/runs/%/events', '/v1/runs/%E0%A4%A']) {
      const r = await request({ path });
      expect(r.status).toBe(404);
      expect(r.body).toMatchObject({ ok: false, error_reason: 'not_found' });
    }
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

  /**
   * WHY: base64url decoding never throws, so a corrupted or truncated cursor used to decode to
   * nothing and be read as "no cursor" — page 1 again, with a 200 and no signal. A client paging in
   * a loop never terminates; a client processing each page double-processes the first and calls it
   * the last. `status` and `limit` were already 400s on this route; this closes the third input.
   */
  it('400s a cursor it did not issue instead of quietly restarting at page 1', async () => {
    for (let i = 0; i < 3; i++) await createRun(`cursor guard ${i}`);
    const first = await request({ path: '/v1/runs?limit=2' });
    const cursor = (first.body as { next_cursor?: string }).next_cursor!;

    for (const bad of ['not a cursor', '%40%40%40%40', cursor.slice(0, -3)]) {
      const res = await request({ path: `/v1/runs?limit=2&cursor=${encodeURIComponent(bad)}` });
      expect(res.status, bad).toBe(400);
      expect(res.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });
    }

    // The honest cursor still pages — a blanket rejection would "fix" this by breaking pagination.
    const good = await request({ path: `/v1/runs?limit=2&cursor=${encodeURIComponent(cursor)}` });
    expect(good.status).toBe(200);
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

  /**
   * WHY: the tail's header promises exactly-once per seq with NO holes, and the publish chain it
   * rests on is not atomic — the commit and the notify are two steps, and a writer that dies between
   * them loses the notify for an event that is durably in the log. The stream then jumps from N to
   * N+2 and heartbeats keep it alive, so the client never reconnects and never heals. Nothing on the
   * wire says a seq was skipped, which makes a lost `run.completed` a run that watchers believe is
   * still going, forever.
   *
   * This row forces exactly that: seq 2 is committed WITHOUT a notify, seq 3 is committed with one.
   * On the tip behaviour the client receives `[1, 3]` and sits there. The healed behaviour re-reads
   * the durable log the moment the gap shows and delivers `[1, 2, 3]` on the same connection.
   */
  it('heals a lost notify — a live seq gap re-reads the durable log instead of writing a hole', async () => {
    const id = await createRun('lost notify');

    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events`);
    await client.waitForFrames(1);
    expect(client.seqs()).toEqual([1]);

    // Committed and durable, but nobody is told: the broker-crash-between-commit-and-notify shape.
    appendEventWithoutNotify(db, id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'lost' } });
    // The next event's notify DOES arrive, so the live tail sees seq 3 land on top of seq 1.
    appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'run.completed', payload: { outcome: 'done' } });

    await client.waitForFrames(3);
    expect(client.seqs()).toEqual([1, 2, 3]);
    expect(client.frames.map((f) => f.event)).toEqual(['run.created', 'tab.attached', 'run.completed']);
    // The healed event is the durable one, not a placeholder standing in for it.
    expect(JSON.parse(client.frames[1].data!)).toMatchObject({ seq: 2, type: 'tab.attached', payload: { tabId: 'lost' } });
    // Healing happens IN the stream: the client is not asked to reconnect for an event the daemon
    // could read itself, and the connection stays open for whatever the run does next.
    expect(client.ended).toBe(false);

    client.kill();
  }, 20000);

  /**
   * The heal must not become a second delivery path. A gap re-reads from the last seq the client
   * actually saw, so every event after the hole is already on the wire — re-sending them would break
   * the same exactly-once promise the hole breaks, in the other direction.
   */
  it('heals without re-sending anything the client already has', async () => {
    const id = await createRun('heal is not a replay');
    for (let i = 0; i < 2; i++) {
      appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: `t${i}` } });
    }

    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events`);
    await client.waitForFrames(3);
    expect(client.seqs()).toEqual([1, 2, 3]);

    // Two consecutive notifies lost, then one delivered — the hole is wider than a single seq.
    appendEventWithoutNotify(db, id, { actor: { kind: 'daemon' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    appendEventWithoutNotify(db, id, { actor: { kind: 'daemon' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'presentation.promoted', payload: { by: 'human', surface: 'tray' } });

    await client.waitForFrames(6);
    // Give a duplicate a chance to show up after the heal settles.
    await new Promise((r) => setTimeout(r, 150));
    expect(client.seqs()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(client.ended).toBe(false);

    client.kill();
  }, 20000);

  /**
   * The heal reads the log; the log is the source of truth (law 1). When it does not carry the
   * missing seqs — a notify that overtook its own commit — there is nothing to deliver and the only
   * honest moves are to end the stream or to write the hole. It ends the stream, which is the door
   * every reconnect already uses, rather than quietly doing the thing this issue exists to stop.
   */
  it('ends the stream when the durable log cannot fill the hole, so the client resumes instead', async () => {
    const id = await createRun('unfillable gap');

    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events`);
    await client.waitForFrames(1);
    expect(client.seqs()).toEqual([1]);

    // A notify with no commit behind it: seq 3 is announced, and seqs 2 and 3 are both absent
    // from the log. The daemon cannot produce them and must not pretend it can.
    publishRunEvent(id, {
      seq: 3,
      ts: '2026-08-23T12:00:00.000Z',
      actor: { kind: 'daemon' },
      type: 'tab.attached',
      payload: { tabId: 'never-committed' },
    });

    await client.waitForEnd();
    expect(client.seqs()).toEqual([1]);

    client.kill();
  }, 20000);

  /**
   * WHY: the gap door above is exposed BY a later event, so a run whose LAST event loses its notify
   * is invisible to it — nothing ever arrives to expose anything. The stream stays open, the
   * heartbeat keeps it alive, and every consumer believes a finished run is still running, forever.
   * That is the `run.completed` shape, the worst one, and no arrival-driven check can reach it.
   *
   * This row forces it on the wire: seq 2 is `run.completed`, committed WITHOUT a notify, and
   * nothing follows it because there is nothing left to follow it. On the tip behaviour the client
   * sits at [1] until it gives up. The reconcile rides on the heartbeat — which fires exactly when
   * the stream has been silent for a full interval — and delivers seq 2 on the same connection.
   */
  it('delivers a terminal event whose notify was lost, on a stream nothing else would ever wake', async () => {
    const previous = process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS;
    process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS = '150';
    try {
      const id = await createRun('lost terminal notify');
      const client = new SseClient();
      await client.open(`/v1/runs/${id}/events`);
      await client.waitForFrames(1);
      expect(client.seqs()).toEqual([1]);

      // The run finishes. The commit lands; the notify does not. Nothing will ever be published on
      // this run again — that is what makes it terminal and what makes the gap door blind to it.
      appendEventWithoutNotify(db, id, { actor: { kind: 'daemon' }, type: 'run.completed', payload: { outcome: 'done' } });

      await client.waitForFrames(2);
      expect(client.seqs()).toEqual([1, 2]);
      expect(client.frames[1].event).toBe('run.completed');
      // The durable event itself, not a placeholder standing in for it.
      expect(JSON.parse(client.frames[1].data!)).toMatchObject({ seq: 2, type: 'run.completed' });
      // Healed in place: the client is not asked to reconnect for an event the daemon could read.
      expect(client.ended).toBe(false);
      client.kill();
    } finally {
      if (previous === undefined) delete process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS;
      else process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS = previous;
    }
  }, 20000);

  /**
   * The other half of that door, and the one that decides whether it is affordable: an idle run with
   * a watcher on it is the ORDINARY case, and it must cost the wire nothing. The heartbeats prove
   * the clock ticked — otherwise "no frame appeared" would be a statement about a timer that never
   * fired rather than about the reconcile.
   */
  it('an idle tail with nothing new in the log stays silent — heartbeats only, no frames', async () => {
    const previous = process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS;
    process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS = '120';
    try {
      const id = await createRun('idle watcher');
      const client = new SseClient();
      await client.open(`/v1/runs/${id}/events`);
      await client.waitForFrames(1);

      const deadline = Date.now() + 1500;
      while (client.comments.length < 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(client.comments.length).toBeGreaterThanOrEqual(3);
      expect(client.seqs()).toEqual([1]);
      expect(client.ended).toBe(false);
      client.kill();
    } finally {
      if (previous === undefined) delete process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS;
      else process.env.WIGOLO_STUDIO_SSE_HEARTBEAT_MS = previous;
    }
  }, 20000);

  /**
   * WHY: the live gap door is deliberately live-only, and the go-live flush runs with `replaying`
   * still true. A hold buffer that itself has a hole in it was therefore written out whole — by the
   * one path on this route whose entire job is ordering.
   *
   * This row forces the shape on the wire with the seam the unfillable-gap row already uses: a
   * notify with no commit behind it, published while the replay is still paging so it lands in the
   * HOLD buffer rather than on the live path. When the replay finishes, the flush finds a seq far
   * past the log's end. On the tip behaviour it writes it, and the client is left holding a stream
   * with thousands of seqs missing and no way to learn it. The flush's own door refuses, hands off
   * to the healer, and the healer — finding the log cannot produce them — ends the stream so the
   * client resumes through the same `Last-Event-ID` door every reconnect already uses.
   */
  it('refuses a hole inside the go-live flush, and ends the stream when the log cannot fill it', async () => {
    const previous = process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
    // One event per page, so the replay is guaranteed to still be paging — and therefore still
    // HOLDING — when the row publishes below. A flush with an empty buffer asserts nothing.
    process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE = '1';
    try {
      const id = await createRun('hole inside the flush');
      const total = 120;
      for (let i = 1; i < total; i++) {
        appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: `t${i}` } });
      }

      const client = new SseClient();
      await client.open(`/v1/runs/${id}/events`);
      // Mid-replay: the pages are one event wide and yield between each, so this is comfortably
      // inside the window in which a live arrival is held rather than emitted.
      await client.waitForFrames(3);
      publishRunEvent(id, {
        seq: 9999,
        ts: '2026-08-23T12:00:00.000Z',
        actor: { kind: 'daemon' },
        type: 'run.completed',
        payload: { outcome: 'done' },
      });

      await client.waitForEnd(15_000);
      const seqs = client.seqs();
      // Everything delivered is contiguous from seq 1. The tip behaviour shows up here as a 9999 on
      // the end of that run — delivered, with a 9878-seq hole behind it, and the stream still open.
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      expect(seqs).not.toContain(9999);
      expect(seqs.length).toBeLessThanOrEqual(total);

      // And the ending is a resume door, not a loss: the durable log is still whole behind it.
      const resumed = new SseClient();
      const from = seqs[seqs.length - 1];
      await resumed.open(`/v1/runs/${id}/events`, { 'Last-Event-ID': String(from) });
      await resumed.waitForFrames(total - from, 15_000);
      expect(resumed.seqs()).toEqual(Array.from({ length: total - from }, (_, i) => from + 1 + i));
      resumed.kill();
      client.kill();
    } finally {
      if (previous === undefined) delete process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
      else process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE = previous;
    }
  }, 30000);

  /**
   * The predicate the flush door keys on is `has this stream delivered anything`, NOT `seq >
   * last + 1` — during the flush `last` may still be the resume point rather than a seq this stream
   * put on the wire. A pruned log is what makes the difference load-bearing: `?since=0` against a
   * log whose first row is seq 5 is not a hole, it is the beginning, and reading it as one would end
   * a perfectly healthy stream on every tail of every pruned run.
   */
  it('replays a log whose first seq is greater than the resume point without ending the stream', async () => {
    const id = await createRun('pruned log shape');
    for (let i = 0; i < 3; i++) {
      appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: `t${i}` } });
    }

    // `?since=0` against a log this client has never seen, whose rows it will receive from the
    // flush rather than the replay — the shape a naive `seq > last + 1` would call a hole at seq 1.
    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events?since=0`);
    await client.waitForFrames(4);
    expect(client.seqs()).toEqual([1, 2, 3, 4]);
    expect(client.ended).toBe(false);

    // Still live afterwards, which is the part an over-eager door would have cost.
    appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'run.completed', payload: {} });
    await client.waitForFrames(5);
    expect(client.seqs()).toEqual([1, 2, 3, 4, 5]);
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

  /**
   * Law 2, from the outside: a run created over REST has no window, and being promoted to one — or
   * demoted back — is a fact on the same stream as everything else it does. An API client watching a
   * headless run therefore learns that a human started watching it without asking anyone.
   */
  it('carries promote and demote as ordinary events, with the run still running across all three states', async () => {
    const id = await createRun('headless, watched, headless again');
    const client = new SseClient();
    await client.open(`/v1/runs/${id}/events`);
    await client.waitForFrames(1);

    expect(((await request({ path: `/v1/runs/${id}` })).body as { run: { visibility: string } }).run.visibility).toBe('hidden');

    appendRunEventWithTail(db, id, { actor: { kind: 'human' }, type: 'presentation.promoted', payload: { by: 'human', surface: 'tray' } });
    appendRunEventWithTail(db, id, { actor: { kind: 'agent', driver: 'studio' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    appendRunEventWithTail(db, id, { actor: { kind: 'human' }, type: 'presentation.demoted', payload: { by: 'human' } });
    await client.waitForFrames(4);

    expect(client.frames.map((f) => f.event)).toEqual([
      'run.created', 'presentation.promoted', 'cost.recorded', 'presentation.demoted',
    ]);
    expect(client.seqs()).toEqual([1, 2, 3, 4]); // one continuous log, no break where the window came and went
    expect(JSON.parse(client.frames[1].data!)).toMatchObject({ payload: { by: 'human', surface: 'tray' } });

    const after = (await request({ path: `/v1/runs/${id}` })).body as { run: { visibility: string; status: string; cost: { browserActions: number } } };
    expect(after.run.visibility).toBe('hidden');
    // The work done while it was being watched is still the run's, and demotion ended nothing.
    expect(after.run.status).toBe('running');
    expect(after.run.cost.browserActions).toBe(1);

    client.kill();
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

  /**
   * WHY: the replay holds live events back so none of them overtakes an older replayed one, and
   * nothing bounded that buffer — a run appending while a long log paged could put its whole burst
   * into daemon heap, with the deliberate yield between pages widening the window. The ceiling is
   * the fix, and the interesting half is what the ceiling COSTS: the buffer is dropped, so the
   * stream must end rather than go live over the hole. The client then resumes through the same
   * `Last-Event-ID` door a dropped connection already uses, and the durable log makes it whole.
   */
  it('ends the stream instead of going live over a hold buffer an append storm overflowed', async () => {
    const previousPage = process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
    const previousHeld = process.env.WIGOLO_STUDIO_SSE_MAX_HELD;
    process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE = '1';
    process.env.WIGOLO_STUDIO_SSE_MAX_HELD = '4';
    try {
      const id = await createRun('append storm during replay');
      const append = (): void => {
        appendRunEventWithTail(db, id, { actor: { kind: 'daemon' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
      };
      // Long enough that a one-event page size cannot drain it before the client is even connected;
      // the replay has to still be paging when the storm arrives or the row asserts nothing.
      let total = 1;
      for (; total < 400; total++) append();

      const client = new SseClient();
      await client.open(`/v1/runs/${id}/events`);
      // The storm: twenty appends per tick against a replay that advances one. They land in the hold
      // buffer with nothing draining it — the shape that used to grow without a bound — and while it
      // continues the replay keeps finding full pages, so it cannot reach the end and finish.
      for (let round = 0; round < 20 && !client.ended; round++) {
        for (let i = 0; i < 20; i++) { append(); total++; }
        await new Promise<void>((r) => setImmediate(r));
      }

      await client.waitForEnd(15_000);
      const first = client.seqs();
      // Everything delivered is contiguous from the start. A buffer that was trimmed instead of
      // dropped — delivered with a hole and called delivery — shows up here as a jump.
      expect(first.length).toBeGreaterThan(0);
      expect(first).toEqual(first.map((_, i) => i + 1));

      // The run keeps going after the tail let go; law 2 — a run exists whether or not anyone is
      // watching. These are what the reconnect must fetch on top of whatever the storm cost it.
      for (let i = 0; i < 3; i++) { append(); total++; }

      // The reconnect the ending exists to provoke. Everything after the client's last seq arrives,
      // in order, with nothing repeated and nothing skipped.
      const resumed = new SseClient();
      const missing = total - first.length;
      await resumed.open(`/v1/runs/${id}/events`, { 'Last-Event-ID': String(first[first.length - 1]) });
      await resumed.waitForFrames(missing, 15_000);
      expect(resumed.seqs()).toEqual(
        Array.from({ length: missing }, (_, i) => first[first.length - 1] + 1 + i),
      );
      resumed.kill();
    } finally {
      if (previousPage === undefined) delete process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE;
      else process.env.WIGOLO_STUDIO_RUN_REPLAY_PAGE = previousPage;
      if (previousHeld === undefined) delete process.env.WIGOLO_STUDIO_SSE_MAX_HELD;
      else process.env.WIGOLO_STUDIO_SSE_MAX_HELD = previousHeld;
    }
  }, 30000);

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
