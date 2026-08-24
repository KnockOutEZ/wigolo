import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Runs against `dist/`, like the restart test: the claim is about a real process boundary. */
const EXIT_CHILD = fileURLToPath(new URL('./fixtures/run-store-exit-drain-child.mjs', import.meta.url));

/**
 * The one thing a behavioural test cannot see: how many syscalls an append costs. `mkdirSync` with
 * `recursive: true` is a no-op semantically and a stat-and-mkdir walk of every path segment in
 * practice, and the append path was paying it per event on a directory it had just created.
 *
 * Mocked at the module edge rather than measured, because a timing would be a flake and a spy on
 * the store would be a test of the test.
 */
const spy = vi.hoisted(() => ({ mkdirCalls: [] as string[], syncWriteCalls: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    mkdirSync: (path: Parameters<typeof real.mkdirSync>[0], options?: Parameters<typeof real.mkdirSync>[1]) => {
      spy.mkdirCalls.push(String(path));
      return real.mkdirSync(path, options);
    },
    // The other half of the same question: an append that no longer opens the file still blocks the
    // loop if it writes it some other way.
    appendFileSync: (...args: Parameters<typeof real.appendFileSync>) => {
      spy.syncWriteCalls.push(String(args[0]));
      return real.appendFileSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      spy.syncWriteCalls.push(String(args[0]));
      return real.writeFileSync(...args);
    },
  };
});

const { applyMigrations, _resetMigrationGuard } = await import('../../../src/cache/migrations/runner.js');
const { createRun, appendEvent, eventsSince, flushRunEventProjections, runDir, runEventsFile } = await import('../../../src/studio/run-store.js');

let dir: string;
let db: Database.Database;

beforeEach(() => {
  spy.mkdirCalls.length = 0;
  spy.syncWriteCalls.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'wigolo-run-disk-'));
  _resetMigrationGuard();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(async () => {
  // Before the tree goes: an in-flight batch landing in a directory this test is deleting would
  // re-create it under the next test's feet.
  await flushRunEventProjections();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ dataDir: dir });

describe('run-store — the disk projection creates a run directory once (SD1 exit review, perf #8b)', () => {
  it('does not re-create the directory on every append', async () => {
    const run = createRun(db, { task: 'memo' }, opts());
    await flushRunEventProjections();
    const afterCreate = spy.mkdirCalls.filter((p) => p.includes(run.id)).length;
    for (let i = 0; i < 25; i++) {
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: i } }, opts());
    }
    await flushRunEventProjections();

    // The control: the birth event really did create it, so the count below is a memo hit and not a
    // mock that never fired.
    expect(afterCreate).toBe(1);
    // 26 events, one directory. Before the memo this was 26 recursive mkdirs, synchronously, on the
    // path that runs after every single commit.
    expect(spy.mkdirCalls.filter((p) => p.includes(run.id))).toHaveLength(1);
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(26);
  });

  it('re-creates a directory that vanished under it, on the very NEXT append', async () => {
    const run = createRun(db, { task: 'vanished' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 1 } }, opts());
    // Flushed first so the removal below lands on a projection that is fully written and idle —
    // otherwise this is a test of what a batch still in the kernel does, not of the memo.
    await flushRunEventProjections();
    // The tree can be cleaned, moved or unmounted between two appends. A memo that believed itself
    // would drop the projection from there on, silently — the disk write is a warn, never a throw.
    rmSync(runDir(run.id, dir), { recursive: true, force: true });
    expect(existsSync(runEventsFile(run.id, dir))).toBe(false);

    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 2 } }, opts());
    await flushRunEventProjections();

    const lines = readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).payload).toEqual({ mark: 2 });
    // The database is the source of truth and never lost a thing.
    expect(eventsSince(db, run.id, 0)).toHaveLength(3);
  });

  it('still commits when the directory cannot be created at all', async () => {
    const run = createRun(db, { task: 'unwritable' }, opts());
    // A data dir whose path is a FILE: `mkdirSync` fails with ENOTDIR every time, so the retry
    // fails too and the append must still return its event.
    const blocked = join(dir, 'blocker');
    writeFileSync(blocked, 'not a directory');

    const event = appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 1 } }, { dataDir: blocked });
    expect(event.seq).toBe(2);
    expect(eventsSince(db, run.id, 1)).toHaveLength(1);
    // And the failure is absorbed asynchronously too — a rejected batch must never surface as an
    // unhandled rejection, which is a process-level fault in the daemon.
    await expect(flushRunEventProjections()).resolves.toBeUndefined();
  });
});

describe('run-store — the disk projection is off the shared loop (wigolo-studio-run#118)', () => {
  it('makes no synchronous filesystem write while appending', async () => {
    const run = createRun(db, { task: 'off-loop' }, opts());
    await flushRunEventProjections();
    spy.syncWriteCalls.length = 0;

    for (let i = 0; i < 50; i++) {
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1, note: 'x'.repeat(200) } }, opts());
    }

    // The whole point of the change: `appendFileSync` was an open/write/close per event on whichever
    // loop the append is on — the daemon's REST loop, or the broker child's, where it serialises
    // every other DB call the app makes. Zero, not "fewer".
    expect(spy.syncWriteCalls).toEqual([]);
    await flushRunEventProjections();
    // The control: the lines really are being written, just not by the caller.
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(51);
  });

  it('coalesces a burst raised in one tick into one batch', async () => {
    const run = createRun(db, { task: 'burst' }, opts());
    await flushRunEventProjections();

    for (let i = 0; i < 40; i++) {
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: i } }, opts());
    }
    // Still one line on disk — the birth event. All 40 returned without touching the filesystem and
    // share a single queued batch, where the old path paid 40 separate open/write/close rounds.
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(1);

    await flushRunEventProjections();
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(41);
  });

  it('keeps on-disk line order equal to seq order across interleaved appends', async () => {
    const run = createRun(db, { task: 'ordered' }, opts());

    // Interleaved on purpose: each yield lets a batch start draining while the next appends pile up
    // behind it, which is the only way the queue can be caught reordering. A single straight-line
    // loop would all land in one batch and prove nothing.
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 5; i++) {
        appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { round, i } }, opts());
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    await flushRunEventProjections();

    const seqs = readFileSync(runEventsFile(run.id, dir), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toHaveLength(201);
    expect(seqs).toEqual(eventsSince(db, run.id, 0).map((e) => e.seq));
  });

  it.each(['immediate', 'raced'])('lands the queued tail when the process exits (%s)', async (mode) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'wigolo-run-exit-'));
    const idFile = join(dataDir, 'run-id');
    try {
      const child = spawn(process.execPath, [EXIT_CHILD, dataDir, idFile, mode], { stdio: ['ignore', 'ignore', 'inherit'] });
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
      expect(code).toBe(0);

      const runId = readFileSync(idFile, 'utf8');
      const lines = readFileSync(join(dataDir, 'studio', 'runs', runId, 'events.jsonl'), 'utf8').trimEnd().split('\n');
      // Six events, once each, in order. The graceful-quit tail — the `run.cancelled` every live run
      // gets on the way out — is exactly this batch, and a queue that dies with the process would
      // drop it. `raced` holds the loop shut first, so the drain runs against a queue the kernel has
      // been chewing on rather than one it has not started; whether a batch landed under it is a race
      // by nature, and `run-store-exit-drain.test.ts` pins that half deterministically.
      expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([1, 2, 3, 4, 5, 6]);
      if (process.platform !== 'win32') {
        expect(statSync(join(dataDir, 'studio', 'runs', runId, 'events.jsonl')).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps the event file owner-only when the stream creates it', async () => {
    if (process.platform === 'win32') return;
    const run = createRun(db, { task: 'mode' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'card number?' } }, opts());
    await flushRunEventProjections();
    // Unchanged by the move off the loop: the file carries prompts, task text and attached URLs that
    // can hold a query-string token, and it outlives the 0700 directory the moment the tree is copied.
    expect(statSync(runEventsFile(run.id, dir)).mode & 0o777).toBe(0o600);
    expect(statSync(runDir(run.id, dir)).mode & 0o777).toBe(0o700);
  });
});
