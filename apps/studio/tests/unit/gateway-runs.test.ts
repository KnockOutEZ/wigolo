import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setMyInstanceId, type StudioHostHandlers, type StudioSessionsAccessor } from 'wigolo/studio';
import { startGateway, type Gateway } from '../../src/main/gateway';
import { bridgeRunEventsToBus, createBrokerRunsStore } from '../../src/main/run-rest-store';
import { FakeRunStore } from '../helpers/fake-run-store';

/**
 * SD1 mini-spec §6 (A-43-5) — the app is the ONE live run-store owner while it is running, so its
 * embedded gateway has to actually serve `/v1/runs*`. It used to answer a structured `503
 * store_unavailable`, and once a standalone daemon started deferring to the live owner
 * (`wigolo-studio-run#70`) that refusal became the answer for the whole machine.
 *
 * These rows drive the REAL gateway over a REAL socket, because the claim is about a wire contract
 * that a handler unit test cannot see: SSE framing, `Last-Event-ID` on reconnect, and the status
 * codes a client branches on.
 *
 * The load-bearing instrument is that the bound store is the ONLY store holding these runs. This
 * process can open a native SQLite handle perfectly well — the Electron main it stands in for cannot
 * — so a gateway that ignored the binding would fall back to its own data dir and answer `200` with
 * an empty list. Every row therefore asserts against the BOUND store's own contents, never merely
 * against "the request did not fail". That is the difference between proving WHICH store served and
 * proving that SOME store did.
 */

const hostHandlers = (): StudioHostHandlers => ({
  observe: async () => ({ id: 's', kind: 'full', trusted: false, untrusted_notice: 'x', elements: [], events: [], eventCursor: 0, eventsDropped: 0, domTruncated: false }),
  act: async (i) => ({ ok: true, action: i.action }),
  marks: async () => ({ marks: [], untrusted_notice: 'x' }),
  capture: async () => ({ artifact_id: 1, inserted: true, content_hash: 'h' }),
  spawn: async () => ({ session_id: 's1' }),
  close: async (i) => ({ closed: true as const, session_id: i.session_id ?? '' }),
  list: async () => ({ sessions: [] }),
  say: async () => ({ posted: true, posted_at: 0 }),
  extractSet: async () => ({ columns: [], rows: [], pages_followed: 0 }),
});
const sessionsAccessor: StudioSessionsAccessor = { getSessionDrive: () => undefined };

interface Resp { status: number; body: unknown }

let port = 0;
let token = '';

function request(opts: { method?: string; path: string; body?: string }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          Connection: 'close',
          authorization: `Bearer ${token}`,
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * A live SSE reader. A buffered one-shot request would hang forever on a stream designed never to
 * end, and the reconnect row needs a connection it can kill mid-flight the way a real one dies.
 */
class SseClient {
  readonly frames: Array<{ id?: string; event?: string; data?: string }> = [];
  status = 0;
  private buffer = '';
  private req?: http.ClientRequest;
  private waiters: Array<() => void> = [];

  open(path: string, headers: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: 'GET',
          path,
          headers: { Accept: 'text/event-stream', authorization: `Bearer ${token}`, ...headers },
        },
        (res) => {
          this.status = res.statusCode ?? 0;
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => { this.buffer += chunk; this.drain(); });
          resolve();
        },
      );
      // A destroy() from our own side is the point of the reconnect row, not a failure.
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
      if (!raw.startsWith(':')) {
        const frame: { id?: string; event?: string; data?: string } = {};
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
        throw new Error(`timed out waiting for ${count} SSE frames; have ${this.frames.map((f) => f.id).join(',')}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 25);
        this.waiters.push(() => { clearTimeout(t); r(); });
      });
    }
  }

  seqs(): number[] { return this.frames.map((f) => Number(f.id)); }
  kill(): void { this.req?.destroy(); }
}

describe('the app gateway serves /v1/runs* from the bound store', () => {
  let dir: string;
  let gateway: Gateway;
  let store: FakeRunStore;
  const open: SseClient[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-gw-runs-'));
    store = new FakeRunStore();
    // Exactly the production wiring: the bridge first (a subscriber attached before any append cannot
    // miss one), then the port handed to the gateway.
    bridgeRunEventsToBus(store);
    gateway = await startGateway({
      host: hostHandlers(),
      sessions: sessionsAccessor,
      sessionId: 'sess-runs',
      dataDir: dir,
      runStore: createBrokerRunsStore(store),
    });
    port = parseInt(new URL(gateway.endpoint).port, 10);
    token = gateway.token;
  });

  afterEach(async () => {
    for (const c of open.splice(0)) c.kill();
    await gateway.stop();
    setMyInstanceId(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists runs out of the bound store instead of refusing with store_unavailable', async () => {
    await store.createRun({ task: 'a run the app owns' });

    const listed = await request({ path: '/v1/runs' });
    expect(listed.status).toBe(200);
    const runs = (listed.body as { runs: Array<{ id: string; task: string }> }).runs;
    // Identity, not just a 200: this run exists ONLY in the bound store, so a gateway that resolved
    // its own handle would answer 200 with an empty list and this is what catches it.
    expect(runs.map((r) => r.task)).toContain('a run the app owns');
    expect(runs.map((r) => r.id)).toEqual([...store.facts.keys()]);
  });

  it('creates a run IN the bound store, and reports back the run it created there', async () => {
    const created = await request({ method: 'POST', path: '/v1/runs', body: JSON.stringify({ task: 'created over REST' }) });
    expect(created.status).toBe(201);
    const run = (created.body as { run: { id: string; task: string; lastSeq: number } }).run;

    // The append landed in the bound store — the whole point of the ownership rule is that the owner
    // is the process that writes.
    expect(store.facts.get(run.id)?.task).toBe('created over REST');
    expect(run.lastSeq).toBe(1);

    const fetched = await request({ path: `/v1/runs/${run.id}` });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { run: { id: string } }).run.id).toBe(run.id);
  });

  it('404s a run the bound store has never heard of, rather than 503ing the whole surface', async () => {
    const missing = await request({ path: '/v1/runs/nosuchrun' });
    expect(missing.status).toBe(404);
    expect((missing.body as { error_reason: string }).error_reason).toBe('not_found');
  });

  // F6 — the SSE route checks the run exists before it replays. Answering that with `getRun` projects
  // the whole log, which is precisely the one-burst read the paged replay under it exists to avoid, and
  // `SSE_RETRY_MS` is 3s, so a client stuck reconnecting pays it against a log that only grows. The
  // instrument is which store method the connect reached, not how long it took.
  it('probes existence for an SSE connect instead of projecting the whole log', async () => {
    const run = await store.createRun({ task: 'a long-running one' });
    for (let i = 0; i < 60; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'run.progress', payload: { i } });
    }
    store.reads.length = 0;

    const client = new SseClient();
    open.push(client);
    await client.open(`/v1/runs/${run.id}/events`);
    await client.waitForFrames(61);

    expect(client.status).toBe(200);
    expect(store.reads).toContain('runExists');
    // A projection here would replay all 61 envelopes to answer a yes/no the key index already knows.
    expect(store.reads, 'the connect projected the run to ask whether it exists').not.toContain('getRun');
  });

  it('tails events THIS process appends, live — replay first, then the bus', async () => {
    const run = await store.createRun({ task: 'tailed' });

    const client = new SseClient();
    open.push(client);
    await client.open(`/v1/runs/${run.id}/events`);
    // Seq 1 is the birth event, already durable when the stream opens: that half is replay.
    await client.waitForFrames(1);
    expect(client.status).toBe(200);
    expect(client.seqs()).toEqual([1]);

    // The live half, and the reason the bridge exists. This append happens in THIS process and never
    // touches the stream's own store read — it reaches the tail only through the in-process bus.
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 't1' } });
    await client.waitForFrames(2);
    expect(client.seqs()).toEqual([1, 2]);
    expect(client.frames[1].event).toBe('tab.attached');
  });

  it('resumes from Last-Event-ID with no gap and no duplicate after the stream dies', async () => {
    const run = await store.createRun({ task: 'resumed' });
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: {} });
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'run.progress', payload: {} });

    const first = new SseClient();
    open.push(first);
    await first.open(`/v1/runs/${run.id}/events`);
    await first.waitForFrames(3);
    expect(first.seqs()).toEqual([1, 2, 3]);

    // Die mid-run, the way a closed terminal or a dropped socket does.
    first.kill();
    await new Promise((r) => setTimeout(r, 50));

    // Appended while nobody was listening — these must arrive on the resume, from the durable log.
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'run.progress', payload: {} });
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'run.progress', payload: {} });

    const second = new SseClient();
    open.push(second);
    await second.open(`/v1/runs/${run.id}/events`, { 'Last-Event-ID': '3' });
    await second.waitForFrames(2);
    expect(second.seqs()).toEqual([4, 5]);

    // And live delivery survives the reconnect — a resumed stream that only ever replays is a
    // regression the two rows above would both miss.
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'run.progress', payload: {} });
    await second.waitForFrames(3);
    expect(second.seqs()).toEqual([4, 5, 6]);
  });
});
