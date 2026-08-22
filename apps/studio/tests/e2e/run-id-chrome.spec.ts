// MUST stay first: it claims WIGOLO_DATA_DIR before any wigolo module can cache the config. See the
// module's own header — in `beforeAll` this is too late and the daemon opens the real ~/.wigolo DB.
import { ISOLATED_DATA_DIR } from './isolated-data-dir';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { type ElectronApplication, type Page } from 'playwright';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy, DaemonHttpServer } from 'wigolo/studio';

// GATED (RUN_STUDIO_E2E) — launches the real Electron app AND a real daemon, so it runs on the ubuntu
// CI lane under xvfb alongside the other studio e2e specs.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');

interface ToolResult { content: Array<{ text: string }> }
const body = (r: unknown): Record<string, unknown> => JSON.parse((r as ToolResult).content[0].text) as Record<string, unknown>;

/**
 * The run id in the window chrome is the SAME STRING the REST surface reports (law 8's spirit — one
 * shared address space; marks arrive in SD4, the run id starts now).
 *
 * The load-bearing choice here is that the id is compared across a PROCESS BOUNDARY and a transport
 * boundary. Both halves are read off real surfaces: the chrome id out of the live DOM of the built
 * Electron app, the REST id off a real socket into a real `DaemonHttpServer`. A test that asked the
 * app for both would prove the app is self-consistent and nothing about whether the two surfaces
 * agree — which is the entire claim.
 *
 * The two processes are joined by `WIGOLO_DATA_DIR`: the app writes runs through its broker into that
 * data dir's store, and the daemon serves `/v1/runs` off the same one. The app's OWN embedded gateway
 * now serves that surface too (SD1 §6 / A-43-5 — while the app runs it is the live store owner), and
 * the last four rows assert it: same runs both ways, and a live tail carrying what the APP appends.
 */
describe.skipIf(!RUN)('run id in the window chrome (e2e, real app + real daemon)', () => {
  const dataDir = ISOLATED_DATA_DIR;
  let app: ElectronApplication;
  let chrome: Page;
  let endpoint: string;
  let token: string;
  let daemon: { stop(): Promise<void> };
  let port: number;

  const request = (opts: { method?: string; path: string; body?: string }): Promise<{ status: number; body: unknown }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          method: opts.method ?? 'GET',
          path: opts.path,
          headers: { Connection: 'close', ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
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
      req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });

  /** The exact string the chrome paints for a run, read out of the live DOM. `null` when absent. */
  const chromeIdFor = (runId: string): Promise<string | null> =>
    chrome.evaluate(
      (id) => document.querySelector(`[data-testid="run-id-${id}"]`)?.textContent ?? null,
      runId,
    );

  /** Every run id the chrome is painting right now, in strip order. */
  const chromeIds = (): Promise<string[]> =>
    chrome.evaluate(() =>
      Array.from(document.querySelectorAll('.tab-group__id')).map((el) => el.textContent ?? ''),
    );

  /** The chrome repaints on an IPC broadcast, a frame after the tool call resolves. */
  const settle = async (want: number): Promise<string[]> => {
    for (let i = 0; i < 200; i++) {
      const ids = await chromeIds();
      if (ids.length >= want) return ids;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`chrome never painted ${want} run id(s); has ${JSON.stringify(await chromeIds())}`);
  };

  /** One JSON call against the APP's own gateway (a different process and port from `request`). */
  const gatewayJson = async (path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> => {
    const base = new URL(endpoint);
    const res = await fetch(`${base.protocol}//${base.host}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* leave as text */ }
    return { status: res.status, body: parsed };
  };

  /**
   * A live SSE reader for the app's gateway. `fetch` alone would resolve and leave the body unread on
   * a stream designed never to end, and the resume row needs a connection it can kill mid-flight the
   * way a closed terminal kills one.
   */
  class GatewaySse {
    readonly frames: Array<{ id?: string; event?: string; data?: string }> = [];
    status = 0;
    private buffer = '';
    private controller = new AbortController();

    async open(path: string, headers: Record<string, string> = {}): Promise<void> {
      const base = new URL(endpoint);
      const res = await fetch(`${base.protocol}//${base.host}${path}`, {
        headers: { authorization: `Bearer ${token}`, Accept: 'text/event-stream', ...headers },
        signal: this.controller.signal,
      });
      this.status = res.status;
      const stream = res.body;
      if (!stream) return;
      void (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            this.buffer += decoder.decode(value, { stream: true });
            this.drain();
          }
        } catch { /* our own abort, which is the point of the resume row */ }
      })();
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
    }

    async waitForFrames(count: number, timeoutMs = 20_000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (this.frames.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} SSE frames; have ${this.frames.map((f) => f.id).join(',')}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    seqs(): number[] { return this.frames.map((f) => Number(f.id)); }
    kill(): void { this.controller.abort(); }
  }

  beforeAll(async () => {
    // The full daemon — the one that owns a native store — on the data dir the app will use.
    const server = new DaemonHttpServer({ port: 0, host: '127.0.0.1', apiToken: null });
    port = parseInt(new URL(await server.start()).port, 10);
    daemon = server;

    // Secondary check only — a leak to `~/.wigolo` shows up here as the developer's own runs. It is
    // NOT the guard: on a machine that has never made a run (every CI runner) it passes whether the
    // isolation held or not. The load-bearing one is the `writes into the isolated data dir` row.
    const preexisting = await request({ path: '/v1/runs' });
    expect(preexisting.status).toBe(200);
    expect((preexisting.body as { runs: unknown[] }).runs).toEqual([]);

    app = await launchStudio({ args: [APP_MAIN], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
    chrome = await app.firstWindow();
    await chrome.waitForSelector('[data-testid="new-tab"]');

    const started = Date.now();
    let handle = readHandle(dataDir);
    while (!handle && Date.now() - started < 30_000) {
      await new Promise((r) => setTimeout(r, 250));
      handle = readHandle(dataDir);
    }
    if (!handle) throw new Error('gateway handle never published');
    endpoint = handle.endpoint;
    token = handle.token;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await daemon?.stop();
    delete process.env.WIGOLO_DATA_DIR;
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 60_000);

  it('paints the run id REST reports for that run, byte for byte', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    await proxy.callTool('studio_open', {});
    const [painted] = await settle(1);

    // The REST id for THAT run, off a real socket into a different process.
    const fetched = await request({ path: `/v1/runs/${painted}` });
    expect(fetched.status).toBe(200);
    const rest = (fetched.body as { run: { id: string } }).run;

    // Byte-identical — not "looks like", not case-insensitively. `GET /v1/runs/:id` is deliberately
    // case-insensitive on the way IN, so an id the chrome had upper-cased would still resolve here;
    // this compares the strings, which is the only thing that makes the two surfaces one address space.
    expect(rest.id).toBe(painted);
    expect(await chromeIdFor(rest.id)).toBe(rest.id);
  }, 120_000);

  it('gives every promoted run its own id, and no id at all to the human\'s tabs', async () => {
    const before = await chromeIds();
    const proxy = new DaemonProxy(endpoint, token);
    await proxy.callTool('studio_open', {});
    const ids = await settle(before.length + 1);

    // Two runs, two ids, both painted — the acceptance is "every promoted run", not "the focused one".
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      const r = await request({ path: `/v1/runs/${id}` });
      expect(r.status).toBe(200);
      expect((r.body as { run: { id: string } }).run.id).toBe(id);
    }

    // A tab the human opens joins the group defined by ABSENCE — it gets no run and so no id. A label
    // there would invent a run, and law 4 says the human's tabs are a separate group no agent can see.
    const groups = await chrome.evaluate(() =>
      Array.from(document.querySelectorAll('.tab-group')).map((el) => ({
        testid: el.getAttribute('data-testid'),
        ids: el.querySelectorAll('.tab-group__id').length,
      })),
    );
    const human = groups.find((g) => g.testid === 'run-group-human');
    if (human) expect(human.ids).toBe(0);
    expect(groups.filter((g) => g.testid !== 'run-group-human').every((g) => g.ids === 1)).toBe(true);
  }, 120_000);

  it('leaves a headless run out of the chrome — a run exists whether or not anyone is watching', async () => {
    // Law 2: `POST /v1/runs` creates a run with no window presence. The chrome is the PROMOTED
    // projection, so this id must NOT appear there — and it must still be a real run over REST.
    const created = await request({ method: 'POST', path: '/v1/runs', body: JSON.stringify({ task: 'a headless run' }) });
    expect(created.status).toBe(201);
    const id = (created.body as { run: { id: string } }).run.id;
    expect(typeof id).toBe('string');

    const fetched = await request({ path: `/v1/runs/${id}` });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { run: { id: string } }).run.id).toBe(id);

    // Give the chrome the same settling budget a promoted run gets, so this is "did not appear",
    // not "was not looked for yet".
    await new Promise((r) => setTimeout(r, 1000));
    expect(await chromeIds()).not.toContain(id);
  }, 120_000);

  it('writes into the isolated data dir, not the developer\'s own library', async () => {
    // The guard that does NOT depend on ambient state. A run created over REST must be readable in
    // the store file inside ISOLATED_DATA_DIR — which is only true if the daemon resolved its config
    // AFTER `isolated-data-dir` set WIGOLO_DATA_DIR. Move that import below `wigolo/studio` and this
    // reds on any machine, empty `~/.wigolo` or not, because the row lands somewhere else entirely.
    const created = await request({ method: 'POST', path: '/v1/runs', body: JSON.stringify({ task: 'isolation probe' }) });
    expect(created.status).toBe(201);
    const id = (created.body as { run: { id: string } }).run.id;

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const db = new BetterSqlite3(join(dataDir, 'wigolo.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT id FROM studio_runs WHERE id = ?').get(id) as { id: string } | undefined;
      expect(row?.id).toBe(id);
    } finally {
      db.close();
    }
  }, 120_000);

  it('serves runs on its OWN gateway, from the same store the daemon reads', async () => {
    // SD1 §6 (A-43-5): while the app runs it IS the live run-store owner, so its embedded gateway has
    // to serve rather than refuse. It used to answer `503 store_unavailable` here — no native store in
    // the Electron main — and once a standalone daemon began deferring to the live owner
    // (`wigolo-studio-run#70`) that refusal became the answer for the whole machine.
    const created = await request({ method: 'POST', path: '/v1/runs', body: JSON.stringify({ task: 'made on the daemon' }) });
    expect(created.status).toBe(201);
    const id = (created.body as { run: { id: string } }).run.id;

    // Two processes, one store, one projection. The app reaches it through its broker child, the
    // daemon through its own handle, and the run has to be the same run on both.
    const listed = await gatewayJson('/v1/runs');
    expect(listed.status).toBe(200);
    expect((listed.body as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toContain(id);

    const fetched = await gatewayJson(`/v1/runs/${id}`);
    expect(fetched.status).toBe(200);
    expect((fetched.body as { run: { id: string; task: string } }).run.task).toBe('made on the daemon');
  }, 120_000);

  it('creates a run on its own gateway that the daemon beside it then reports', async () => {
    const created = await gatewayJson('/v1/runs', { method: 'POST', body: JSON.stringify({ task: 'made on the app' }) });
    expect(created.status).toBe(201);
    const id = (created.body as { run: { id: string } }).run.id;

    // The direction that matters for the ownership rule: the APP was the writer.
    const fetched = await request({ path: `/v1/runs/${id}` });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { run: { task: string } }).run.task).toBe('made on the app');
  }, 120_000);

  it('tails events the APP appends, live on the app\'s own gateway', async () => {
    // The whole point of the one-owner rule: the owner's live tail IS the live tail. These events are
    // written by the Electron main through its broker, and reach the stream only through this
    // process's in-process bus — never through the reader's own store query.
    const proxy = new DaemonProxy(endpoint, token);
    const before = await chromeIds();
    const opened = body(await proxy.callTool('studio_open', {}));
    const ids = await settle(before.length + 1);
    const runId = ids.find((x) => !before.includes(x));
    expect(typeof runId).toBe('string');

    const tail = new GatewaySse();
    try {
      await tail.open(`/v1/runs/${runId}/events`);
      // run.created + tab.attached are already durable when the stream opens: that half is replay.
      await tail.waitForFrames(2);
      expect(tail.status).toBe(200);
      expect(tail.seqs()).toEqual([1, 2]);

      // Closing the session makes the app append again — tab.detached, then the terminal event.
      await proxy.callTool('studio_close', { session_id: opened.session_id });
      await tail.waitForFrames(4);
      expect(tail.seqs()).toEqual([1, 2, 3, 4]);
      expect(tail.frames.map((f) => f.event)).toEqual(['run.created', 'tab.attached', 'tab.detached', 'run.completed']);
    } finally {
      tail.kill();
    }
  }, 120_000);

  it('resumes that tail from Last-Event-ID with no gap and no duplicate', async () => {
    const proxy = new DaemonProxy(endpoint, token);
    const before = await chromeIds();
    const opened = body(await proxy.callTool('studio_open', {}));
    const ids = await settle(before.length + 1);
    const runId = ids.find((x) => !before.includes(x));

    const first = new GatewaySse();
    await first.open(`/v1/runs/${runId}/events`);
    await first.waitForFrames(2);
    expect(first.seqs()).toEqual([1, 2]);

    // Die mid-run, the way a closed terminal does — then let the app write while nobody is listening.
    first.kill();
    await new Promise((r) => setTimeout(r, 100));
    await proxy.callTool('studio_close', { session_id: opened.session_id });

    const second = new GatewaySse();
    try {
      await second.open(`/v1/runs/${runId}/events`, { 'Last-Event-ID': '2' });
      await second.waitForFrames(2);
      // No gap (3 and 4 both arrive) and no duplicate (1 and 2 do not come back).
      expect(second.seqs()).toEqual([3, 4]);
    } finally {
      second.kill();
    }
  }, 120_000);
});
