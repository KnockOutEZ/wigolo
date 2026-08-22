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

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const toolBody = (r: unknown) => JSON.parse((r as ToolResult).content[0].text) as Record<string, unknown>;

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
 * is studio-only and answers `/v1/runs` with a structured 503 (no native store in the Electron main) —
 * asserted below, because it is the reason this spec needs a second process at all, and it is what
 * `wigolo-studio-run#70` exists to close.
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

  it('says so with a structured 503 when the studio process is asked for runs it does not store', async () => {
    // Why this spec needs two processes: the app's embedded gateway is studio-only and has no native
    // store. It refuses in a shape a client can branch on rather than 500ing or, worse, answering with
    // an empty list that reads as "no runs". `wigolo-studio-run#70` is the issue that closes the gap.
    const base = new URL(endpoint);
    const res = await fetch(`${base.protocol}//${base.host}/v1/runs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(503);
    expect((await res.json() as { error_reason: string }).error_reason).toBe('store_unavailable');
  }, 60_000);
});
