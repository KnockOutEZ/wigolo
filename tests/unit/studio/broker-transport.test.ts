import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * EXTRACT C3 — rows written through the broker outlive the process that wrote them.
 *
 * Law 1: a run is append-only, lives in the daemon and outlives every UI. At this seam that reduces to one
 * checkable claim — what the broker wrote is still there when the writer is gone — and it can only be made
 * across a REAL process boundary. An in-process version would pass with the whole thing in a Map.
 *
 * Two short-lived children share one on-disk database: the first pairs-equivalent (mints a grant), writes
 * a run and two events, and exits; the second opens the same file, mints its OWN grant — the first child's
 * died with it, which is the design — and reads the rows back.
 *
 * It runs against `dist/` deliberately: this is also the check that the published module still loads in a
 * plain Node process with no bundler, no test transform and no vitest globals.
 */
const DIST = fileURLToPath(new URL('../../../dist/', import.meta.url));

describe('companion broker — the shared cache outlives the writing process', () => {
  let dir: string;
  let dbPath: string;

  function runChild(name: string, source: string): unknown {
    const file = join(dir, name);
    writeFileSync(file, source, 'utf8');
    const stdout = execFileSync(process.execPath, [file], {
      env: { ...process.env, WIGOLO_DATA_DIR: dir, LOG_LEVEL: 'error' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const line = stdout.trim().split('\n').at(-1) ?? '';
    return JSON.parse(line);
  }

  const preamble = `
import { initDatabase, closeDatabase } from ${JSON.stringify(pathToFileURL(join(DIST, 'cache/db.js')).href)};
import { BrokerGrantStore, executeBrokerOp, schemaHead } from ${JSON.stringify(pathToFileURL(join(DIST, 'daemon/studio-db-broker.js')).href)};
import { BROKER_TABLES } from ${JSON.stringify(pathToFileURL(join(DIST, 'companion-contract/index.js')).href)};
`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-durability-'));
    dbPath = join(dir, 'shared.db');
  });

  afterAll(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* the OS owns the temp dir */ }
  });

  it('writes in one process and reads back in another, with a grant that did not survive the crossing', () => {
    const writer = runChild('writer.mjs', `${preamble}
const db = initDatabase(${JSON.stringify(dbPath)});
const grants = new BrokerGrantStore();
const grant = grants.issue({ mode: 'readwrite', tables: BROKER_TABLES, schemaHead: schemaHead(db) });
executeBrokerOp(db, grants, { grant: grant.token, kind: 'insert', table: 'studio_runs',
  row: { id: 'run-durable', task: 'outlive me', created_at: '2026-09-03T00:00:00.000Z' } });
for (const seq of [1, 2]) {
  executeBrokerOp(db, grants, { grant: grant.token, kind: 'insert', table: 'studio_run_events',
    row: { run_id: 'run-durable', seq, ts: 't', actor: 'agent', type: 'step', payload: '{}' } });
}
closeDatabase();
console.log(JSON.stringify({ token: grant.token, head: grant.schemaHead }));
`) as { token: string; head: number };

    expect(writer.head).toBeGreaterThan(0);

    const reader = runChild('reader.mjs', `${preamble}
const db = initDatabase(${JSON.stringify(dbPath)});
const grants = new BrokerGrantStore();
// The writer's token is meaningless here: grants live in the process that issued them, so a companion
// that outlives a daemon restart must re-pair rather than keep using a token nothing can revoke.
const stale = executeBrokerOp(db, grants, { grant: ${JSON.stringify(writer.token)}, kind: 'read', table: 'studio_runs', limit: 10 });
const grant = grants.issue({ mode: 'read', tables: BROKER_TABLES, schemaHead: schemaHead(db) });
const runs = executeBrokerOp(db, grants, { grant: grant.token, kind: 'read', table: 'studio_runs', limit: 10 });
const events = executeBrokerOp(db, grants, { grant: grant.token, kind: 'read', table: 'studio_run_events', limit: 10 });
closeDatabase();
console.log(JSON.stringify({ stale, runs, events, head: grant.schemaHead }));
`) as {
      stale: { ok: boolean; reason?: string };
      runs: { ok: boolean; rows: Array<Record<string, unknown>> };
      events: { ok: boolean; rows: Array<Record<string, unknown>> };
      head: number;
    };

    expect(reader.stale).toEqual({ ok: false, reason: 'no_grant', table: 'studio_runs' });
    expect(reader.runs.rows).toHaveLength(1);
    expect(reader.runs.rows[0]).toMatchObject({ id: 'run-durable', task: 'outlive me' });
    expect(reader.events.rows.map((e) => e.seq)).toEqual([1, 2]);
    // The head is a property of the FILE, so both processes read the same one — which is what makes it
    // safe to compare against a companion's declared minimum at pairing time.
    expect(reader.head).toBe(writer.head);
  }, 120_000);
});
