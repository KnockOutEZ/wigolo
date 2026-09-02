import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import Database from 'better-sqlite3';
import { applyMigrations, _resetMigrationGuard } from '../../src/cache/migrations/runner.js';
import { handleRunsRequest } from '../../src/daemon/rest/runs.js';
import { sqliteRunsStore, type RunsStore } from '../../src/daemon/rest/runs-store.js';
import { createRun } from '../../src/studio/run-store.js';

/**
 * #334 demo — SD2's three REST routes answered identically by the two store bindings.
 *
 * `POST /v1/runs/:id/driver`, `POST /v1/runs/:id/messages` and `GET /v1/runs/:id/messages` are the
 * routes that answered `503 store_unavailable` on the launched app, because the store the app binds
 * lives behind a plain-Node child that had no method for any of them. This drives all three — plus
 * `GET /v1/runs/:id` — twice over one run: once through `sqliteRunsStore` on a native handle, once
 * through a store bound to a REALLY SPAWNED broker child, and asserts the answers match.
 *
 * WHY IT IS HERE AND NOT IN THE APP. The app-side binding of these members is the next issue's
 * work. The binding below is therefore a TEST binding — the smallest thing that turns the child's
 * six new methods into the port — and its whole job is to make the sufficiency claim checkable in
 * core: if the routes can be served from these methods alone, the app's binding has everything it
 * needs, and if a method is missing or misnamed the route reds here rather than in another repo.
 *
 * WHAT IS NORMALIZED, AND NOTHING ELSE. The two sides run in different processes against different
 * files, so the wall clock and the minted ids cannot agree. Every id a caller can pin IS pinned —
 * the run id is minted into the native handle from the broker's answer, message ids are supplied —
 * and only ISO timestamps are scrubbed. Statuses, `error_reason`s, event types, seqs, step numbers,
 * driver lines and state lines are compared verbatim, which is where a divergence would live.
 */
const BROKER = fileURLToPath(new URL('../../dist/daemon/studio-db-broker.js', import.meta.url));

const CLI = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const SDK = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };
const HUMAN = { kind: 'human' };
const ABSENT = 'zzzzzzz';

interface Answer { status: number; body: unknown }
interface Frame { id?: number; ok?: boolean; result?: unknown; error?: { message: string }; notify?: string }

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Replace every ISO timestamp with a marker, at any depth. Structure and every other value stay. */
function scrub(value: unknown): unknown {
  if (typeof value === 'string') return ISO.test(value) ? '<ts>' : value;
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

describe('SD2 REST routes — the native binding and a spawned-broker binding answer the same', () => {
  let child: ChildProcess;
  let dir: string;
  let buf = '';
  const frames: Frame[] = [];
  const waiters: Array<(f: Frame) => boolean> = [];
  const resolvers: Array<() => void> = [];
  let nextId = 1;

  let db: Database.Database;
  let nativeStore: RunsStore;
  let brokerStore: RunsStore;
  let runId = '';

  const pump = (): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (frames.find((f) => waiters[i](f))) { resolvers[i](); waiters.splice(i, 1); resolvers.splice(i, 1); }
    }
  };
  const waitFor = (pred: (f: Frame) => boolean): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const existing = frames.find(pred);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error('broker message timeout')), 30_000);
      waiters.push(pred);
      resolvers.push(() => { clearTimeout(timer); resolve(frames.find(pred)!); });
    });

  /** One JSON-RPC round-trip. A thrown transport error stays thrown — a refusal must not be one. */
  async function rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = nextId++;
    child.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    const frame = await waitFor((f) => f.id === id);
    if (frame.ok !== true) throw new Error(`broker ${method} failed: ${frame.error?.message ?? 'unknown'}`);
    return frame.result as T;
  }

  /**
   * The port, over the wire. Exactly the nine members `RunsStore` names, each one method of the
   * child — which is the point: no logic, no fold, no second grammar on this side of the pipe.
   */
  function brokerBoundStore(): RunsStore {
    return {
      create: (input) => rpc('runCreate', { input }),
      list: (opts) => rpc('runList', opts),
      get: (id) => rpc('runGet', { runId: id }),
      exists: (id) => rpc('runExists', { runId: id }),
      eventsSince: (id, since, limit) => rpc('runEventsSince', { runId: id, since, limit }),
      driver: (id, input) => rpc('runDriver', { runId: id, input }),
      sendMessage: (id, input) => rpc('runSendMessage', { runId: id, input }),
      messages: (id, limit) => rpc('runMessages', { runId: id, limit }),
      typedEvents: (id, query) => rpc('runTypedEvents', { runId: id, query }),
      unansweredEvents: (id, query) => rpc('runUnansweredEvents', { runId: id, query }),
      appendEvent: (id, event) => rpc('runAppend', { runId: id, event }),
      interruptTrigger: (id, caller) => rpc('runInterruptTrigger', { runId: id, caller }),
    };
  }

  async function rest(store: RunsStore, method: string, path: string, payload?: unknown): Promise<Answer> {
    const req = (payload === undefined
      ? Object.assign(Readable.from([]), { headers: {} })
      : Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), { headers: { 'content-type': 'application/json' } })
    ) as unknown as IncomingMessage;
    const res = { destroyed: false, headersSent: false, setTimeout: () => {}, writeHead: () => {}, end: () => {}, on: () => {}, off: () => {} } as unknown as ServerResponse;
    let answer: Answer = { status: 0, body: {} };
    const url = new URL(`http://127.0.0.1${path}`);
    await handleRunsRequest(req, res, {
      pathname: url.pathname,
      method,
      url,
      respond: (status, body) => { answer = { status, body }; },
      sendError: (e) => { answer = { status: e.status, body: e.body }; },
      store,
    });
    return answer;
  }

  /** The same request to both bindings. Returns the native answer; the equality IS the assertion. */
  async function both(method: string, path: string, payload?: unknown): Promise<Answer> {
    const native = await rest(nativeStore, method, path, payload);
    const broker = await rest(brokerStore, method, path, payload);
    expect(scrub(broker), `${method} ${path}`).toEqual(scrub(native));
    return native;
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-routes-'));
    child = spawn(process.execPath, [BROKER], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, WIGOLO_STUDIO_BROKER_MAIN: '1', WIGOLO_DATA_DIR: join(dir, 'child'), LOG_LEVEL: 'error' },
    });
    child.unref();
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (c: string) => {
      buf += c;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (line.trim()) { try { frames.push(JSON.parse(line) as Frame); } catch { /* stray */ } }
      }
      pump();
    });
    await waitFor((f) => f.notify === 'ready');
    brokerStore = brokerBoundStore();

    // The broker mints the id; the native handle is then seeded to mint the SAME one, so one id
    // names one run on both sides and no answer has to be normalized to compare.
    const created = await brokerStore.create({ task: 'compare two monitors', driver: CLI as never });
    runId = created.id;

    _resetMigrationGuard();
    db = new Database(join(dir, 'native.db'));
    db.pragma('foreign_keys = ON');
    applyMigrations(db, { vecLoaded: false });
    createRun(db, { task: 'compare two monitors', driver: CLI as never }, { mintId: () => runId, dataDir: join(dir, 'native') });
    nativeStore = sqliteRunsStore(db);
  }, 90_000);

  afterAll(() => {
    try { child.kill('SIGKILL'); } catch { /* ignore */ } // force — the child loads the local ML runtime
    try { db?.close(); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /v1/runs/:id — the run, the driver line, and the same projection from both', async () => {
    const answer = await both('GET', `/v1/runs/${runId}`);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ run: { id: runId, driverName: 'cli (claude-code)' } });
  }, 60_000);

  it('POST /v1/runs/:id/driver — a human takeover, and the events it was worth', async () => {
    const answer = await both('POST', `/v1/runs/${runId}/driver`, { gesture: 'takeover', by: HUMAN, reason: 'I will finish this' });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ ok: true, run: { driverName: 'human' } });
    expect((answer.body as { events: Array<{ type: string }> }).events.map((e) => e.type)).toEqual(['driver.changed']);
  }, 60_000);

  it('POST /v1/runs/:id/driver — the refusals, with the SAME status and the SAME error_reason', async () => {
    // The status line is the half a thrown refusal would get wrong: the transport flattens a throw,
    // and the route answers 500 for one. Every arm here is a documented 4xx on both bindings.
    const notDriver = await both('POST', `/v1/runs/${runId}/driver`, { gesture: 'release', by: SDK });
    expect(notDriver.status).not.toBe(500);
    expect(notDriver.body).toMatchObject({ ok: false, error_reason: 'not_the_driver' });

    const noSuccessor = await both('POST', `/v1/runs/${runId}/driver`, { gesture: 'grant', by: HUMAN });
    expect(noSuccessor.body).toMatchObject({ ok: false, error_reason: 'no_successor' });

    const absent = await both('POST', `/v1/runs/${ABSENT}/driver`, { gesture: 'takeover', by: HUMAN });
    expect(absent.status).toBe(404);
    expect(absent.body).toMatchObject({ ok: false, error_reason: 'run_not_found' });
  }, 60_000);

  it('POST /v1/runs/:id/messages — 202 accepted into the log, and the retry that replays it', async () => {
    const posted = await both('POST', `/v1/runs/${runId}/messages`, { text: 'stop before you pay', message_id: 'hm_demo' });
    // 202, not 200: law 7 says a pull transport queues and we say so, in the status line too.
    expect(posted.status).toBe(202);
    expect(posted.body).toMatchObject({
      message: { message_id: 'hm_demo', state: 'queued', state_line: 'queued — reaches the agent at its next tool call' },
    });

    const retry = await both('POST', `/v1/runs/${runId}/messages`, { text: 'stop before you pay', message_id: 'hm_demo' });
    expect(retry.status).toBe(202);
  }, 60_000);

  it('POST /v1/runs/:id/messages — the refusals match too, including the one that comes FROM the store', async () => {
    // Blank text never reaches the store: the route validates it and answers `invalid_input`. Kept
    // because it pins WHERE the refusal is made — a store binding that started answering this one
    // would mean the route stopped guarding it.
    const blank = await both('POST', `/v1/runs/${runId}/messages`, { text: '   ' });
    expect(blank.status).not.toBe(500);
    expect(blank.body).toMatchObject({ ok: false, error_reason: 'invalid_input' });

    // This one IS the store's. `zzzzzzz` is a well-formed run id, so it passes the route's decode
    // and the 404 is `MessageRefused` crossing the wire as a value — a thrown one would be a 500.
    const absent = await both('POST', `/v1/runs/${ABSENT}/messages`, { text: 'nobody home' });
    expect(absent.status).toBe(404);
    expect(absent.body).toMatchObject({ ok: false, error_reason: 'run_not_found' });
  }, 60_000);

  it('GET /v1/runs/:id/messages — the same queue, folded to the same states', async () => {
    const answer = await both('GET', `/v1/runs/${runId}/messages`);
    expect(answer.status).toBe(200);
    const messages = (answer.body as { messages: Array<{ message_id: string; state: string; queued_at_step: number }> }).messages;
    expect(messages.map((m) => m.message_id)).toEqual(['hm_demo']);
    expect(messages[0]).toMatchObject({ state: 'queued' });
    // The step number is a log seq, so it is only equal if both logs took the same shape.
    expect(messages[0].queued_at_step).toBeGreaterThan(0);
  }, 60_000);
});
