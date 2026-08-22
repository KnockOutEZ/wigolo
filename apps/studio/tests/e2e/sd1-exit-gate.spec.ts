// MUST stay first: it claims WIGOLO_DATA_DIR before any wigolo module can cache the config. See the
// module's own header — in `beforeAll` this is too late and the daemon opens the real ~/.wigolo DB.
import { ISOLATED_DATA_DIR } from './isolated-data-dir';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type ElectronApplication } from 'playwright';
import { launchStudio } from './launch';

/**
 * SD1's phase-exit gate, as one sentence: **a run created via REST survives app restart, is
 * promotable, streams events; its id is visible everywhere.**
 *
 * The slices each proved a clause — `#45` the durable store, `#46` the REST/SSE surface, `#48`
 * promote/demote, `#49` the id in the chrome. None of them crossed a process death, because each
 * owned one side of it. This spec is the join, and the only thing it adds is the boundary: every
 * claim below is read back by a process that did not write it.
 *
 * Two processes die and are replaced mid-journey:
 *
 *   - the **app** — killed with SIGKILL, the way a crash kills it, and relaunched on the same data dir;
 *   - the **daemon** — spawned as a child (`run-daemon-child.mjs`) rather than booted in this test
 *     process, because a daemon that created the run and never restarted cannot witness survival. It
 *     would be answering from the handle it opened, which proves it remembers, not that the log is on
 *     disk. The second daemon has never seen this run before it reads it.
 *
 * A-46-2 is the reason the live tail and the app's writes are asserted through different doors: SD1's
 * REST surface serves the in-process store, so a live SSE tail only receives events appended in the
 * daemon's own process. Events the APP writes (promote, the boot demote) reach this tail on reconnect,
 * off the durable log — which is exactly the gapless-resume contract, so it is asserted as such rather
 * than worked around.
 */

// GATED (RUN_STUDIO_E2E) — launches the real Electron app twice AND a real daemon twice, so it runs on
// the ubuntu CI lane under xvfb alongside the other studio e2e specs.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');
const DAEMON_CHILD = join(import.meta.dirname, 'run-daemon-child.mjs');

/**
 * X11 honours per-window opacity only under a compositing WM, and the CI lane is bare xvfb — the same
 * ceiling `headless-promote.spec.ts` records. The window is asserted on macOS; the LOG and the REST
 * projection are asserted everywhere, and they are the authoritative half (law 1).
 */
const OPACITY_HONOURED = process.platform === 'darwin';

const TASK = 'sd1 exit gate — a run made over REST';

interface Daemon {
  proc: ChildProcess;
  rest: number;
  control: number;
}

/** Spawn a daemon child and wait for the one JSON line it prints once both its servers are listening. */
async function startDaemon(dataDir: string): Promise<Daemon> {
  const proc = spawn(process.execPath, [DAEMON_CHILD], {
    env: { ...process.env, WIGOLO_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ports = await new Promise<{ rest: number; control: number }>((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(
      () => reject(new Error(`daemon child never reported its ports; stderr tail: ${err.slice(-800)}`)),
      60_000,
    );
    proc.stderr?.on('data', (c: Buffer) => {
      err += c.toString('utf-8');
    });
    proc.stdout?.on('data', (c: Buffer) => {
      out += c.toString('utf-8');
      const nl = out.indexOf('\n');
      if (nl === -1) return;
      clearTimeout(timer);
      resolve(JSON.parse(out.slice(0, nl)) as { rest: number; control: number });
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`daemon child exited with ${String(code)} before listening; stderr tail: ${err.slice(-800)}`));
    });
  });
  return { proc, ...ports };
}

/** SIGKILL, then wait for the OS to actually reap it — a port still held is a port the next one cannot bind. */
async function killDaemon(daemon: Daemon | undefined): Promise<void> {
  if (!daemon || daemon.proc.exitCode !== null || daemon.proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => daemon.proc.once('exit', () => resolve()));
  daemon.proc.kill('SIGKILL');
  await exited;
}

/** One-shot JSON request. Buffers to `end`, so it must never be pointed at the SSE route. */
const request = (
  port: number,
  opts: { method?: string; path: string; body?: string },
): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: opts.method ?? 'GET',
        path: opts.path,
        headers: {
          Connection: 'close',
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let body: unknown = text;
          try {
            body = JSON.parse(text);
          } catch {
            /* leave as text */
          }
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

interface SseFrame {
  id?: string;
  event?: string;
  data?: string;
}

/**
 * A live SSE reader. The one-shot `request` above buffers to 'end' and would hang forever on a stream
 * designed never to end, so the tail needs its own client — one that survives its server being killed
 * out from under it, which is the whole point here. Ported from `tests/integration/rest-runs.test.ts`,
 * with the port passed in because this spec talks to two different daemons.
 */
class SseClient {
  readonly frames: SseFrame[] = [];
  status = 0;
  private buffer = '';
  private req?: http.ClientRequest;
  private waiters: Array<() => void> = [];

  constructor(private readonly port: number) {}

  open(path: string, headers: Record<string, string> = {}): Promise<void> {
    return new Promise((resolve, reject) => {
      this.req = http.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          method: 'GET',
          path,
          headers: { Accept: 'text/event-stream', ...headers },
        },
        (res) => {
          this.status = res.statusCode ?? 0;
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            this.buffer += chunk;
            this.drain();
          });
          resolve();
        },
      );
      this.req.on('error', (err) => {
        // The server being SIGKILLed is the test, not a failure; so is our own destroy().
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ECONNRESET' && code !== 'ECONNREFUSED') reject(err);
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

  async waitForFrames(count: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.frames.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${count} SSE frames; have ${this.frames.length}: ${JSON.stringify(this.seqs())}`,
        );
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 25);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  kill(): void {
    this.req?.destroy();
  }

  seqs(): number[] {
    return this.frames.map((f) => Number(f.id));
  }

  types(): string[] {
    return this.frames.map((f) => f.event ?? '');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll until `predicate` holds, so a row waits on the fact it needs rather than on a fixed sleep.
 *
 * A read that THROWS counts as "not yet": the main-process seams this spec reads are mounted during
 * boot, so asking for one a frame early is an ordinary not-ready, not a failure. The last error is
 * carried into the timeout message so a genuinely broken read still says what broke.
 */
async function until<T>(what: string, read: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await read();
      last = value;
      if (predicate(value)) return value;
    } catch (err) {
      last = String(err);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
    await sleep(200);
  }
}

interface RunBody {
  id: string;
  task: string;
  createdAt: string;
  status: string;
  visibility: 'hidden' | 'visible';
  lastSeq: number;
  tabIds: string[];
  cost: { browserActions: number };
}

const getRun = async (port: number, id: string): Promise<RunBody> => {
  const res = await request(port, { path: `/v1/runs/${id}` });
  expect(res.status).toBe(200);
  return (res.body as { run: RunBody }).run;
};

/** Every envelope in the durable log, read back over SSE as a full replay (`since=0`). */
async function fullReplay(port: number, id: string, atLeast: number): Promise<SseFrame[]> {
  const client = new SseClient(port);
  await client.open(`/v1/runs/${id}/events`);
  try {
    await client.waitForFrames(atLeast);
    return [...client.frames];
  } finally {
    client.kill();
  }
}

const appendEvent = (
  daemon: Daemon,
  id: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> =>
  request(daemon.control, {
    method: 'POST',
    path: '/append',
    body: JSON.stringify({ runId: id, actor: { kind: 'daemon' }, type, payload }),
  });

describe.skipIf(!RUN)('SD1 exit gate — a REST-created run survives restart, promotes, streams (e2e)', () => {
  const dataDir = ISOLATED_DATA_DIR;

  let daemon: Daemon | undefined;
  let app: ElectronApplication | undefined;
  let runId = '';
  let createdAt = '';
  /** The tail opened before the restart; its last seq is the resume point afterwards. */
  let tail: SseClient | undefined;
  let seqsBeforeRestart: number[] = [];
  let seqAtRestart = 0;

  /** The menu-bar item's menu, over the main-process seam `#48` parks on dev builds (A-48-4). */
  const menuLabels = (): Promise<string[]> =>
    app!.evaluate(() => (globalThis as never as { __wigoloRunMenu: { labels(): string[] } }).__wigoloRunMenu.labels());
  const clickMenu = (index: number): Promise<void> =>
    app!.evaluate(
      (_e, i) => (globalThis as never as { __wigoloRunMenu: { click(n: number): void } }).__wigoloRunMenu.click(i),
      index,
    );
  const windowState = (): Promise<{ opacity: number; visible: boolean; minimized: boolean }> =>
    app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      return { opacity: win.getOpacity(), visible: win.isVisible(), minimized: win.isMinimized() };
    });

  /** The index of this run's row in the menu — located by its LABEL, which starts with the id verbatim. */
  const runMenuIndex = async (id: string): Promise<number> => {
    const labels = await until(
      'the menu-bar item to list the run',
      () => menuLabels(),
      (ls) => ls.some((l) => l.startsWith(`${id} `)),
    );
    return labels.findIndex((l) => l.startsWith(`${id} `));
  };

  /** `--hidden` is the boot default this gate is about: no window is presented at launch (law 2). */
  const launchApp = async (dir: string): Promise<ElectronApplication> => {
    const launched = await launchStudio({ args: [APP_MAIN, '--hidden'], env: { ...process.env, WIGOLO_DATA_DIR: dir } });
    // The main-process seams below are mounted around window creation; evaluating before it lands
    // inside `createWindow` and reads a global that does not exist yet.
    await launched.firstWindow();
    return launched;
  };

  /** Bounded quit, then SIGKILL — an app that declines to quit must not starve every spec after this one. */
  const closeApp = async (target: ElectronApplication | undefined): Promise<void> => {
    if (!target) return;
    try {
      await Promise.race([
        target.close(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('the app did not quit')), 15_000)),
      ]);
    } catch {
      try {
        target.process().kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };

  beforeAll(async () => {
    daemon = await startDaemon(dataDir);
  }, 120_000);

  afterAll(async () => {
    tail?.kill();
    await closeApp(app);
    await killDaemon(daemon);
    delete process.env.WIGOLO_DATA_DIR;
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }, 60_000);

  it('POST /v1/runs mints a headless run — no window, no tab, law 2', async () => {
    const created = await request(daemon!.rest, {
      method: 'POST',
      path: '/v1/runs',
      body: JSON.stringify({ task: TASK }),
    });
    expect(created.status).toBe(201);
    const run = (created.body as { run: RunBody }).run;
    runId = run.id;
    createdAt = run.createdAt;

    expect(run.id).toMatch(/^[23456789abcdefghjkmnpqrstvwxyz]{4,}$/);
    expect(run.task).toBe(TASK);
    expect(run.visibility).toBe('hidden');
    expect(run.status).toBe('running');
    expect(run.tabIds).toEqual([]);
    expect(run.lastSeq).toBe(1);

    // The load-bearing isolation guard: the daemon's write landed inside the temp dir, not the
    // developer's real library. "The list starts empty" would pass on any machine that never made a
    // run — which is every CI runner — so it is not the guard.
    expect(existsSync(join(dataDir, 'wigolo.db'))).toBe(true);
  });

  it('the SSE tail streams events live as they are appended, replay first, no gaps', async () => {
    tail = new SseClient(daemon!.rest);
    await tail.open(`/v1/runs/${runId}/events`);
    // Replay half: the birth event, off the durable log.
    await tail.waitForFrames(1);
    expect(tail.seqs()).toEqual([1]);
    expect(tail.types()).toEqual(['run.created']);

    // Live half. These are appended in the DAEMON's process, which is the only place a live fan-out
    // can reach this stream (A-46-2) — an append made from the test process would prove replay.
    for (let i = 0; i < 2; i++) {
      const res = await appendEvent(daemon!, runId, 'cost.recorded', { kind: 'browser_action', amount: 1 });
      expect(res.status).toBe(200);
    }
    await tail.waitForFrames(3);
    expect(tail.seqs()).toEqual([1, 2, 3]);
    expect(tail.types()).toEqual(['run.created', 'cost.recorded', 'cost.recorded']);

    // The projection moved with the log, so the events are facts and not just frames.
    const run = await getRun(daemon!.rest, runId);
    expect(run.cost.browserActions).toBe(2);
    expect(run.lastSeq).toBe(3);
  }, 60_000);

  it('the app hydrates a run it never created and offers it in the menu-bar item, id verbatim', async () => {
    app = await launchApp(dataDir);
    const index = await runMenuIndex(runId);
    expect(index).toBeGreaterThan(0);

    const labels = await menuLabels();
    // Law 8 — the id the menu paints is the id REST minted, byte for byte and as the first token.
    expect(labels[index].startsWith(`${runId} · `)).toBe(true);
    expect(labels[index]).toContain(TASK);

    // Law 2 — hydrating a run does not present it.
    if (OPACITY_HONOURED) expect((await windowState()).opacity).toBe(0);
    expect((await getRun(daemon!.rest, runId)).visibility).toBe('hidden');
  }, 180_000);

  it('promoting from the menu-bar item writes presentation.promoted and presents the window', async () => {
    await clickMenu(await runMenuIndex(runId));

    const run = await until(
      'the promote to reach the REST projection',
      () => getRun(daemon!.rest, runId),
      (r) => r.visibility === 'visible',
    );
    expect(run.lastSeq).toBe(4);
    if (OPACITY_HONOURED) {
      const state = await until('the window to be presented', () => windowState(), (s) => s.opacity === 1);
      expect(state.minimized).toBe(false);
    }

    // The transition is an event in the run's own log, written by the app and read here by the daemon —
    // two processes, one source of truth (law 1).
    const frames = await fullReplay(daemon!.rest, runId, 4);
    const promoted = frames.map((f) => JSON.parse(f.data ?? '{}') as { type: string; actor: { kind: string }; payload: Record<string, unknown> }).at(-1);
    expect(promoted?.type).toBe('presentation.promoted');
    expect(promoted?.actor.kind).toBe('human');
    expect(promoted?.payload).toMatchObject({ by: 'human', surface: 'tray' });
  }, 120_000);

  it('the run survives the app being killed and the daemon being replaced — log intact', async () => {
    seqsBeforeRestart = tail!.seqs();
    seqAtRestart = seqsBeforeRestart[seqsBeforeRestart.length - 1];
    tail!.kill();

    // SIGKILL, not close(): a crash is the restart this gate is about, and a graceful quit could
    // flush something a crash would not.
    app!.process().kill('SIGKILL');
    await sleep(1_000);
    await killDaemon(daemon);
    app = undefined;

    // A daemon that has never seen this run, reading it off the disk the last one left behind.
    daemon = await startDaemon(dataDir);

    const listed = await request(daemon.rest, { path: '/v1/runs' });
    expect(listed.status).toBe(200);
    const runs = (listed.body as { runs: RunBody[] }).runs;
    expect(runs.map((r) => r.id)).toContain(runId);

    const run = await getRun(daemon.rest, runId);
    expect(run.id).toBe(runId);
    expect(run.task).toBe(TASK);
    expect(run.createdAt).toBe(createdAt);
    // Projections, not stored columns — the log replayed correctly or these are wrong.
    expect(run.cost.browserActions).toBe(2);
    expect(run.visibility).toBe('visible');
    expect(run.lastSeq).toBe(4);

    const frames = await fullReplay(daemon.rest, runId, 4);
    expect(frames.map((f) => Number(f.id))).toEqual([1, 2, 3, 4]);
    expect(frames.map((f) => f.event)).toEqual([
      'run.created',
      'cost.recorded',
      'cost.recorded',
      'presentation.promoted',
    ]);
  }, 120_000);

  it('the relaunched app writes the restart into the log rather than contradicting it (A-48-2)', async () => {
    app = await launchApp(dataDir);
    await runMenuIndex(runId);

    // A-43-2: presentation is per-app-lifetime. The correction is an event, so every other surface
    // sees the same restart this window does.
    const run = await until(
      'the boot reconcile to demote the run left visible',
      () => getRun(daemon!.rest, runId),
      (r) => r.visibility === 'hidden',
    );
    expect(run.lastSeq).toBe(5);

    const frames = await fullReplay(daemon!.rest, runId, 5);
    const demoted = JSON.parse(frames[4].data ?? '{}') as { type: string; actor: { kind: string }; payload: Record<string, unknown> };
    expect(demoted.type).toBe('presentation.demoted');
    expect(demoted.actor.kind).toBe('system');
    expect(demoted.payload).toMatchObject({ by: 'system' });
  }, 180_000);

  it('SSE resumes across the restart from Last-Event-ID with no gaps and no duplicates', async () => {
    const resumed = new SseClient(daemon!.rest);
    await resumed.open(`/v1/runs/${runId}/events`, { 'Last-Event-ID': String(seqAtRestart) });
    try {
      await resumed.waitForFrames(2);
      // Strictly greater than what the first connection had — the resume contract, across a server
      // that no longer exists and a client that reconnected to its replacement.
      expect(resumed.seqs()).toEqual([4, 5]);

      const seen = [...seqsBeforeRestart, ...resumed.seqs()];
      expect(seen).toEqual([1, 2, 3, 4, 5]);
      expect(new Set(seen).size).toBe(seen.length);
    } finally {
      resumed.kill();
    }
  }, 60_000);

  it('promoted again after the restart, the id is the same string on every surface', async () => {
    await clickMenu(await runMenuIndex(runId));
    const rest = await until(
      'the second promote to reach the REST projection',
      () => getRun(daemon!.rest, runId),
      (r) => r.visibility === 'visible',
    );
    if (OPACITY_HONOURED) {
      expect((await until('the window to be presented again', () => windowState(), (s) => s.opacity === 1)).opacity).toBe(1);
    }

    // Law 8 — the same number, everywhere. Four surfaces, three process boundaries: REST over a real
    // socket into the second daemon, the menu of the second app, the SQLite primary key, and the
    // human-readable log on disk. Compared byte for byte, because anything prettier — a truncation, a
    // case change — breaks the shared address space SILENTLY, both strings still looking like an id.
    expect(rest.id).toBe(runId);

    const labels = await menuLabels();
    const menuRow = labels.find((l) => l.startsWith(`${runId} `));
    expect(menuRow).toBeDefined();
    expect(menuRow!.slice(0, runId.length)).toBe(runId);

    const BetterSqlite3 = (await import('better-sqlite3')).default;
    const db = new BetterSqlite3(join(dataDir, 'wigolo.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT id FROM studio_runs WHERE id = ?').get(runId) as { id: string } | undefined;
      expect(row?.id).toBe(runId);
      const seqs = db
        .prepare('SELECT seq FROM studio_run_events WHERE run_id = ? ORDER BY seq')
        .all(runId) as Array<{ seq: number }>;
      expect(seqs.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    } finally {
      db.close();
    }

    // Law 11 — the log is a file on disk, at a path the id names.
    const eventsFile = join(dataDir, 'studio', 'runs', runId, 'events.jsonl');
    expect(existsSync(eventsFile)).toBe(true);
    const first = JSON.parse(readFileSync(eventsFile, 'utf-8').split('\n')[0]) as { seq: number; payload: { task: string } };
    expect(first.seq).toBe(1);
    expect(first.payload.task).toBe(TASK);
  }, 120_000);

  it('the window chrome paints no id for a run that owns no tab — the gap this gate exposes', async () => {
    // `#49` labels TAB GROUPS with their owning run's id, and nothing on the tip attaches a tab to an
    // existing run: `studio_open` always mints a fresh one and takes no run id. So a REST-created run
    // is promotable and named in the menu-bar item, but its id cannot reach the tab strip — recorded
    // as decision A-50-2 and filed, not patched here. Asserted so the day it changes, this reds.
    const chrome = await app!.firstWindow();
    const painted = await chrome.evaluate(
      (id) => document.querySelector(`[data-testid="run-id-${id}"]`)?.textContent ?? null,
      runId,
    );
    expect(painted).toBeNull();
    const groups = await chrome.evaluate(() =>
      Array.from(document.querySelectorAll('.tab-group')).map((el) => el.getAttribute('data-testid')),
    );
    expect(groups).not.toContain(`run-group-${runId}`);
  }, 60_000);
});
