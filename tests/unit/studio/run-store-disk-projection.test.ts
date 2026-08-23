import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The one thing a behavioural test cannot see: how many syscalls an append costs. `mkdirSync` with
 * `recursive: true` is a no-op semantically and a stat-and-mkdir walk of every path segment in
 * practice, and the append path was paying it per event on a directory it had just created.
 *
 * Mocked at the module edge rather than measured, because a timing would be a flake and a spy on
 * the store would be a test of the test.
 */
const spy = vi.hoisted(() => ({ mkdirCalls: [] as string[] }));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    mkdirSync: (path: Parameters<typeof real.mkdirSync>[0], options?: Parameters<typeof real.mkdirSync>[1]) => {
      spy.mkdirCalls.push(String(path));
      return real.mkdirSync(path, options);
    },
  };
});

const { applyMigrations, _resetMigrationGuard } = await import('../../../src/cache/migrations/runner.js');
const { createRun, appendEvent, eventsSince, runDir, runEventsFile } = await import('../../../src/studio/run-store.js');

let dir: string;
let db: Database.Database;

beforeEach(() => {
  spy.mkdirCalls.length = 0;
  dir = mkdtempSync(join(tmpdir(), 'wigolo-run-disk-'));
  _resetMigrationGuard();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ dataDir: dir });

describe('run-store — the disk projection creates a run directory once (SD1 exit review, perf #8b)', () => {
  it('does not re-create the directory on every append', () => {
    const run = createRun(db, { task: 'memo' }, opts());
    const afterCreate = spy.mkdirCalls.filter((p) => p.includes(run.id)).length;
    for (let i = 0; i < 25; i++) {
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: i } }, opts());
    }

    // The control: the birth event really did create it, so the count below is a memo hit and not a
    // mock that never fired.
    expect(afterCreate).toBe(1);
    // 26 events, one directory. Before the memo this was 26 recursive mkdirs, synchronously, on the
    // path that runs after every single commit.
    expect(spy.mkdirCalls.filter((p) => p.includes(run.id))).toHaveLength(1);
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(26);
  });

  it('re-creates a directory that vanished under it, on the very NEXT append', () => {
    const run = createRun(db, { task: 'vanished' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 1 } }, opts());
    // The tree can be cleaned, moved or unmounted between two appends. A memo that believed itself
    // would drop the projection from there on, silently — the disk write is a warn, never a throw.
    rmSync(runDir(run.id, dir), { recursive: true, force: true });
    expect(existsSync(runEventsFile(run.id, dir))).toBe(false);

    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 2 } }, opts());

    const lines = readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).payload).toEqual({ mark: 2 });
    // The database is the source of truth and never lost a thing.
    expect(eventsSince(db, run.id, 0)).toHaveLength(3);
  });

  it('still commits when the directory cannot be created at all', () => {
    const run = createRun(db, { task: 'unwritable' }, opts());
    // A data dir whose path is a FILE: `mkdirSync` fails with ENOTDIR every time, so the retry
    // fails too and the append must still return its event.
    const blocked = join(dir, 'blocker');
    writeFileSync(blocked, 'not a directory');

    const event = appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 1 } }, { dataDir: blocked });
    expect(event.seq).toBe(2);
    expect(eventsSince(db, run.id, 1)).toHaveLength(1);
  });
});
