import { describe, it, expect, afterAll } from 'vitest';
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ElectronApplication } from 'playwright';
import { launchStudio } from './launch';
import { readHandle, DaemonProxy } from 'wigolo/studio';

/**
 * The ordinary end of a run, asserted the only way it can be: from outside the process that wrote it.
 *
 * `before-quit` used to be fire-and-forget, so Electron tore the process down while `shutdown()` was
 * still awaiting its `endRun` append. The loss is silent and permanent — the run is `running` in the
 * durable log forever, boot `reconcile()` rewrites visibility and never status, and every projection
 * of that log agrees with each other and with nothing that happened (law 1).
 *
 * Both arms read the log back through a daemon that has never seen these runs, so nothing here can be
 * answered out of the writer's own memory. The SIGKILL arm is not decoration: it is the outside signal
 * that makes the graceful arm mean something. If a terminal event appeared for both, the append would
 * be coming from somewhere other than the quit path — a boot reconciler, a store default — and the
 * graceful arm would pass while proving nothing.
 */

// GATED (RUN_STUDIO_E2E) — launches the real Electron app twice AND a real daemon twice, so it runs on
// the ubuntu CI lane under xvfb alongside the other studio e2e specs.
const RUN = !!process.env.RUN_STUDIO_E2E;
const APP_MAIN = join(import.meta.dirname, '../../out/main/index.js');
const DAEMON_CHILD = join(import.meta.dirname, 'run-daemon-child.mjs');

interface ToolResult { content: Array<{ type: string; text: string }>; isError: boolean }
const body = (r: unknown): Record<string, unknown> => JSON.parse((r as ToolResult).content[0].text) as Record<string, unknown>;

interface RunBody {
  id: string;
  task: string;
  status: string;
  visibility: 'hidden' | 'visible';
  lastSeq: number;
}

/** One-shot JSON request. Buffers to `end`, so it must never be pointed at the SSE route. */
const request = (port: number, path: string): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method: 'GET', path, headers: { Connection: 'close' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* leave as text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
    req.end();
  });

/** Spawn a daemon child and wait for the one JSON line it prints once both its servers are listening. */
async function startDaemon(dataDir: string): Promise<{ proc: ChildProcess; rest: number }> {
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
    proc.stderr?.on('data', (c: Buffer) => { err += c.toString('utf-8'); });
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
  return { proc, rest: ports.rest };
}

/**
 * Every run in a data dir, read by a process that did not write any of them. The daemon is started
 * AFTER the app is gone and killed again immediately, so it holds neither the port nor the DB open for
 * the next arm.
 */
async function readRunsFromDisk(dataDir: string): Promise<RunBody[]> {
  const daemon = await startDaemon(dataDir);
  try {
    const res = await request(daemon.rest, '/v1/runs');
    expect(res.status).toBe(200);
    return (res.body as { runs: RunBody[] }).runs;
  } finally {
    const exited = new Promise<void>((resolve) => daemon.proc.once('exit', () => resolve()));
    daemon.proc.kill('SIGKILL');
    await exited;
  }
}

/** A booted app with `count` live sessions on a data dir of its own. */
async function appWithLiveSessions(dataDir: string, count: number): Promise<{ app: ElectronApplication }> {
  // `--hidden` is the boot default (law 2); the quit path under test does not depend on a presented window.
  const app = await launchStudio({ args: [APP_MAIN, '--hidden'], env: { ...process.env, WIGOLO_DATA_DIR: dataDir } });
  await app.firstWindow();
  const started = Date.now();
  let handle = readHandle(dataDir);
  while (!handle && Date.now() - started < 30_000) {
    await new Promise((r) => setTimeout(r, 250));
    handle = readHandle(dataDir);
  }
  if (!handle) throw new Error('gateway handle never published');
  // A real agent client over the real gateway — the way a session is actually opened.
  const proxy = new DaemonProxy(handle.endpoint, handle.token);
  for (let i = 0; i < count; i++) {
    const opened = body(await proxy.callTool('studio_open', {}));
    expect(typeof opened.session_id).toBe('string');
  }
  return { app };
}

describe.skipIf(!RUN)('a graceful quit lands the terminal event before the process exits (e2e, real app)', () => {
  const dirs: string[] = [];
  const makeDir = (tag: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `wigolo-studio-quit-${tag}-`));
    dirs.push(dir);
    return dir;
  };

  afterAll(() => {
    for (const dir of dirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  /**
   * The bug is a RACE, and one session does not force it: on a warm broker a single `run.cancelled`
   * lands inside the window Electron's own teardown leaves open, so a one-session arm passes on the
   * broken build and proves nothing. Every live session is a detach and a terminal append, so the
   * number of sessions is the amount of work the quit has to outlive — that stays true now that
   * `shutdown()` ends them concurrently rather than one after another (SD1 exit-9): the fleet's
   * appends still have to land, they just no longer land in series.
   * Measured against the fire-and-forget tip, by reverting `preventDefault()` and rebuilding: one
   * session still lands and the arm passes; at eight, all eight come back `running`.
   *
   * Eight is also an ordinary state, not a stress test: law 4 is one run per task, and a fleet of
   * eight is smaller than the cockpit is designed to show.
   */
  const LIVE_SESSIONS = 8;

  it('quits gracefully with live sessions, and every run is terminal in a log read by another process', async () => {
    const dataDir = makeDir('graceful');
    const { app } = await appWithLiveSessions(dataDir, LIVE_SESSIONS);

    // `ElectronApplication.close()` evaluates `app.quit()` in the main process, so this is the same
    // door Cmd-Q and the last-window-close come through — not a kill, and not a private test path.
    //
    // Bounded and asserted rather than silently escalated to SIGKILL: an app that declines to quit is
    // the OTHER failure this issue's timeout exists to prevent, and a fallback kill would hide it here
    // AND leave the log looking exactly like the bug we are fixing.
    let quitTimedOut = false;
    try {
      await Promise.race([
        app.close(),
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 30_000)),
      ]);
    } catch {
      quitTimedOut = true;
      try { app.process().kill('SIGKILL'); } catch { /* already gone */ }
    }
    expect(quitTimedOut).toBe(false);

    const runs = await readRunsFromDisk(dataDir);
    expect(runs).toHaveLength(LIVE_SESSIONS);
    // `shutdown()` cancels rather than completes: the host is going away, the work is not finished.
    // EVERY run, not "at least one" — a partial flush is the exact shape of the bug, and the runs that
    // lose their append are the ones at the tail of the walk.
    expect(runs.map((r) => r.status)).toEqual(Array<string>(LIVE_SESSIONS).fill('cancelled'));

    // Law 11 — the same fact as lines in files on disk, at paths the run ids name. Asserted as well as
    // the projection because the projection is derived from it: if only the projection said
    // `cancelled`, the append never landed and the next boot would disagree with this read.
    for (const run of runs) {
      const eventsFile = join(dataDir, 'studio', 'runs', run.id, 'events.jsonl');
      expect(existsSync(eventsFile)).toBe(true);
      const types = readFileSync(eventsFile, 'utf-8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => (JSON.parse(l) as { type: string }).type);
      expect(types.at(-1)).toBe('run.cancelled');
    }
  }, 300_000);

  it('a hard crash still leaves the runs running — the graceful arm above is not measuring the store', async () => {
    const dataDir = makeDir('crash');
    const { app } = await appWithLiveSessions(dataDir, LIVE_SESSIONS);

    // SIGKILL is what a crash is, and no quit handler can run. This arm must keep failing to produce a
    // terminal event: crash-orphaned runs are explicitly out of scope for this issue (no boot status
    // reconciler), so a `cancelled` here would mean the graceful arm is reading something other than
    // the quit path — and that this change had quietly grown a reconciler nobody reviewed.
    const exited = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    app.process().kill('SIGKILL');
    await exited;

    const runs = await readRunsFromDisk(dataDir);
    expect(runs).toHaveLength(LIVE_SESSIONS);
    expect(runs.map((r) => r.status)).toEqual(Array<string>(LIVE_SESSIONS).fill('running'));
  }, 300_000);
});
