import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { sqliteRunsStore } from '../../../src/daemon/rest/runs-store.js';
import { eventsSince } from '../../../src/studio/run-store.js';
import type { RunEvent } from '../../../src/studio/run-store.js';

/**
 * SD2 §2, the run-log half: attaching to a run records WHAT THE CLIENT COULD DO at that moment, in
 * the log, where a replay or an audit can read it back without re-deriving it from a mapping table
 * that will have moved on. The event has to reach the in-process bus too — an SSE tail opened on
 * this process is fanned out from the bus alone, so an append that skipped it would be invisible
 * to every watcher until they reconnected.
 */

const appendSpy = vi.fn();
vi.mock('../../../src/studio/run-bus.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/studio/run-bus.js')>();
  return {
    ...real,
    appendRunEventWithTail: (...args: Parameters<typeof real.appendRunEventWithTail>) => {
      appendSpy(...args);
      return real.appendRunEventWithTail(...args);
    },
  };
});

let dir: string;
let db: Database.Database;

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-attach-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
  appendSpy.mockClear();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function log(runId: string): RunEvent[] {
  return eventsSince(db, runId, 0, 100);
}

describe('a client that creates a run attaches to it, and the log says so', () => {
  it('writes `client.attached` right after the birth event, carrying the capability profile', async () => {
    const store = sqliteRunsStore(db);
    const run = await store.create({ task: 'compare two monitors', driver: { kind: 'cli', client: { name: 'claude-code', version: '1.2.3' } } });

    const events = log(run.id);
    expect(events.map((e) => e.type)).toEqual(['run.created', 'client.attached']);
    expect(events[1].payload).toEqual({
      tier: 'detected',
      phrasing: 'mcp-tools',
      capabilities: [],
      client: { name: 'claude-code', version: '1.2.3' },
    });
  });

  it('gives a harness nobody has mapped the same record, at the safe default', async () => {
    // Law 5 in the log: the two payloads differ in the badge and the phrasing key. Nothing else —
    // and above all not `capabilities`, which is the only field anything is allowed to branch on.
    const store = sqliteRunsStore(db);
    const known = await store.create({ task: 'a', driver: { kind: 'cli', client: { name: 'cursor', version: '2.0' } } });
    const fabricated = await store.create({ task: 'b', driver: { kind: 'cli', client: { name: 'foo-agent', version: '0.3' } } });

    const k = log(known.id)[1].payload as Record<string, unknown>;
    const f = log(fabricated.id)[1].payload as Record<string, unknown>;
    expect(f.capabilities).toEqual(k.capabilities);
    expect(f.tier).toEqual(k.tier);
    expect(f.phrasing).not.toEqual(k.phrasing);
  });

  it('records nothing extra when the creator named no client — there is no profile to record', async () => {
    // `driver` defaults to `{kind:'api'}` with no badge, and the birth event already carries that.
    // A second event asserting "an unidentified client attached" would be noise in an append-only log.
    const store = sqliteRunsStore(db);
    const run = await store.create({ task: 'anonymous' });
    expect(log(run.id).map((e) => e.type)).toEqual(['run.created']);
    expect(run.lastSeq).toBe(1);
  });

  it('reports the attach in `lastSeq` so the create response is not a seq behind its own log', async () => {
    // The response's `lastSeq` is what a client resumes an SSE tail from. Left at the birth seq it
    // would promise a replay that starts one event too early — or, read as "nothing since", hide it.
    const store = sqliteRunsStore(db);
    const run = await store.create({ task: 'resume me', driver: { kind: 'sdk', client: { name: 'foo-agent', version: '1' } } });
    expect(run.lastSeq).toBe(2);
    expect(log(run.id)).toHaveLength(2);
  });

  it('names the client as the actor and claims no driver kind of its own', async () => {
    const store = sqliteRunsStore(db);
    const run = await store.create({ task: 'who', driver: { kind: 'studio', client: { name: 'cline', version: '9' } } });
    expect(log(run.id)[1].actor).toEqual({ kind: 'agent', client: { name: 'cline', version: '9' } });
  });
});

describe('the attach reaches the live tail, not just the table', () => {
  it('appends through the bus-publishing helper, so an open SSE tail sees it without reconnecting', async () => {
    // The store owns the only SQLite handle, and an SSE tail on this process is fanned out from the
    // in-process bus alone. An attach written with the bare `appendEvent` would be durable and
    // invisible — correct in the table, missing from every watcher until they dropped and resumed.
    const store = sqliteRunsStore(db);
    await store.create({ task: 'watched', driver: { kind: 'cli', client: { name: 'gemini', version: '1' } } });
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy.mock.calls[0][2]).toMatchObject({ type: 'client.attached' });
  });
});
