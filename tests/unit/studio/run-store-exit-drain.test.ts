import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The one state a child process cannot be steered into on demand: a batch the kernel has already
 * written whose completion the exit beat.
 *
 * The sibling child-process specs prove the exit drain runs and that the queued tail survives
 * `process.exit`. Neither can prove the OTHER half — that the drain does not re-write a batch that
 * already landed — because getting there means blocking the loop between a write completing and its
 * callback running, which is a race, not a fixture. So the write is made to land synchronously and
 * its promise made never to settle: on disk, still `inFlight`, exactly the ambiguous state.
 *
 * Duplicating a line here is not cosmetic. `events.jsonl` is the append-only log a person reads when
 * they want to know what a run did (law 11), and a repeated `seq` in it is a fabricated event.
 */
const stall = vi.hoisted(() => ({ on: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const { appendFileSync: realAppendSync } = await import('node:fs');
  return {
    ...real,
    appendFile: async (file: string, data: string, options?: { mode?: number }) => {
      realAppendSync(file, data, options);
      if (stall.on) await new Promise(() => { /* the completion that never arrives */ });
    },
  };
});

const { applyMigrations, _resetMigrationGuard } = await import('../../../src/cache/migrations/runner.js');
const { createRun, appendEvent, flushRunEventProjections, runEventsFile } = await import('../../../src/studio/run-store.js');

let dir: string;
let db: Database.Database;

beforeEach(() => {
  stall.on = false;
  dir = mkdtempSync(join(tmpdir(), 'wigolo-run-exitdrain-'));
  _resetMigrationGuard();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  stall.on = false;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('run-store — the exit drain writes the tail exactly once (wigolo-studio-run#118)', () => {
  it('does not re-write a batch that already reached disk, and does write the one that did not', async () => {
    const run = createRun(db, { task: 'exit' }, { dataDir: dir });
    await flushRunEventProjections();

    stall.on = true;
    // Landed, but its promise never settles — so the store still believes this batch is in flight.
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 'landed' } }, { dataDir: dir });
    // Queued behind the stalled batch: never handed to the kernel at all.
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 'queued' } }, { dataDir: dir });

    // The control, before the drain: two of the three lines are on disk.
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(2);

    // What `process.exit(0)` does to the listener the store armed, without ending this test's process.
    process.emit('exit', 0);

    const seqs = readFileSync(runEventsFile(run.id, dir), 'utf8')
      .trimEnd()
      .split('\n')
      .map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([1, 2, 3]);
  });

  it('writes nothing at all when every batch has settled', async () => {
    const run = createRun(db, { task: 'quiet' }, { dataDir: dir });
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 1 } }, { dataDir: dir });
    await flushRunEventProjections();
    const before = readFileSync(runEventsFile(run.id, dir), 'utf8');

    process.emit('exit', 0);

    // A drain that fired on an empty queue would still be correct; one that re-wrote a settled batch
    // would not, and this is the arm that says which happened.
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8')).toBe(before);
  });
});
