import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import { sqliteRunsStore } from '../../../src/daemon/rest/runs-store.js';
import { createRunWithTail } from '../../../src/studio/run-bus.js';
import { eventsSince, getRun, type Driver, type Run } from '../../../src/studio/run-store.js';
import {
  denyWheel,
  formatDriver,
  grantWheel,
  notDriving,
  releaseWheel,
  requestWheel,
  takeWheel,
} from '../../../src/daemon/driver-baton.js';

/**
 * SD2 §1 — the driver baton. Law 3: one driver at a time, explicit gestures, request-the-wheel is
 * never a race. The point of every row here is that the answer is a PROJECTION: nothing stores who
 * drives, so the only way the wheel can move is an event, and the only way an event lands is a
 * gesture that was allowed to make it.
 */

let dir: string;
let db: Database.Database;

const A: Driver = { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } };
const B: Driver = { kind: 'sdk', client: { name: 'wigolo-sdk', version: '0.4.0' } };
const C: Driver = { kind: 'api', client: { name: 'curl', version: '8.4.0' } };
const HUMAN: Driver = { kind: 'human' };

beforeEach(() => {
  _resetMigrationGuard();
  dir = mkdtempSync(join(tmpdir(), 'wigolo-baton-'));
  db = new Database(join(dir, 'w.db'));
  db.pragma('foreign_keys = ON');
  applyMigrations(db, { vecLoaded: false });
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function newRun(driver: Driver = A): Run {
  return createRunWithTail(db, { task: 'compare two monitors', driver });
}

function types(runId: string): string[] {
  return eventsSince(db, runId, 0, 100).map((e) => e.type);
}

function payloads(runId: string, type: string): Record<string, unknown>[] {
  return eventsSince(db, runId, 0, 100).filter((e) => e.type === type).map((e) => e.payload);
}

describe('the baton is a projection, never a stored field', () => {
  it('starts at the creating driver with an empty queue', () => {
    const run = newRun();
    expect(run.driver).toEqual(A);
    expect(run.wheelRequests).toEqual([]);
  });

  it('rebuilds the whole baton by replaying the log — the run object holds no other memory of it', () => {
    const run = newRun();
    const asked = requestWheel(db, run.id, { by: B });
    expect(asked.ok).toBe(true);
    grantWheel(db, run.id, { by: A, requestId: asked.ok ? asked.requestId : undefined });

    // Nothing but the log has been consulted: a fresh read of the same rows lands on the same answer.
    expect(getRun(db, run.id)!.driver).toEqual(B);
    expect(getRun(db, run.id)!.wheelRequests).toEqual([]);
    expect(types(run.id)).toEqual(['run.created', 'driver.wheel_requested', 'driver.changed']);
  });

  it('ignores a driver payload it cannot rebuild rather than projecting a half-badge', () => {
    const run = newRun();
    // A writer that puts a nonsense kind in the log must not be able to move the wheel with it —
    // the store polices envelope mechanics, and the PROJECTION polices the shape it will believe.
    db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.id, 99, new Date().toISOString(), JSON.stringify({ kind: 'daemon' }), 'driver.changed',
        JSON.stringify({ to: { kind: 'root' }, cause: 'grant' }));
    expect(getRun(db, run.id)!.driver).toEqual(A);
  });
});

describe('request-the-wheel is an explicit, idempotent gesture', () => {
  it('queues the request and leaves the driver exactly where it was', () => {
    const run = newRun();
    const asked = requestWheel(db, run.id, { by: B, reason: 'I have the checkout step' });
    expect(asked.ok).toBe(true);
    const after = getRun(db, run.id)!;
    expect(after.driver).toEqual(A);
    expect(after.wheelRequests).toHaveLength(1);
    expect(after.wheelRequests[0]).toMatchObject({ by: B, reason: 'I have the checkout step' });
    expect(after.wheelRequests[0].requestId).toBe(asked.ok ? asked.requestId : '');
  });

  it('returns the ORIGINAL id on a repeat and appends nothing — a retrying client cannot flood the queue', () => {
    const run = newRun();
    const first = requestWheel(db, run.id, { by: B });
    const second = requestWheel(db, run.id, { by: B });
    expect(second.ok && second.requestId).toBe(first.ok && first.requestId);
    expect(second.ok && second.events).toEqual([]);
    expect(getRun(db, run.id)!.wheelRequests).toHaveLength(1);
  });

  it('a denied request leaves the queue, and the driver never moved', () => {
    const run = newRun();
    const asked = requestWheel(db, run.id, { by: B });
    const requestId = asked.ok ? asked.requestId! : '';
    expect(denyWheel(db, run.id, { by: A, requestId }).ok).toBe(true);
    expect(getRun(db, run.id)!.wheelRequests).toEqual([]);
    expect(getRun(db, run.id)!.driver).toEqual(A);
  });

  it('lets a requester withdraw its own request even though it is not the driver', () => {
    const run = newRun();
    const asked = requestWheel(db, run.id, { by: B });
    const requestId = asked.ok ? asked.requestId! : '';
    expect(denyWheel(db, run.id, { by: B, requestId }).ok).toBe(true);
    expect(getRun(db, run.id)!.wheelRequests).toEqual([]);
  });

  it('refuses a deny by an unrelated observer, naming who drives', () => {
    const run = newRun();
    const asked = requestWheel(db, run.id, { by: B });
    const refused = denyWheel(db, run.id, { by: C, requestId: asked.ok ? asked.requestId! : '' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error_reason).toBe('not_the_driver');
    expect(!refused.ok && refused.driverName).toBe('cli (claude-code)');
    expect(getRun(db, run.id)!.wheelRequests).toHaveLength(1);
  });
});

describe('two wheel requests in the same tick serialize by store append order', () => {
  it('grants in seq order on release — the queue is FIFO on the log, not on arrival luck', async () => {
    const run = newRun();
    // FORCE the race: both gestures are issued before either is awaited, so nothing about the test
    // orders them except the store's own single-writer append. N clean runs of a sequential fixture
    // would prove nothing here.
    const store = sqliteRunsStore(db);
    const [second, first] = await Promise.all([
      // Deliberately started in the OPPOSITE order to the assertion below, so an implementation that
      // happened to honour call order rather than seq order would still have to get this right.
      store.driver!(run.id, { gesture: 'request', by: C }),
      store.driver!(run.id, { gesture: 'request', by: B }),
    ]);
    expect(first.ok && second.ok).toBe(true);

    const queued = getRun(db, run.id)!.wheelRequests;
    const seqs = payloads(run.id, 'driver.wheel_requested').map((p) => (p.by as { kind: string }).kind);
    const rows = eventsSince(db, run.id, 0, 100).filter((e) => e.type === 'driver.wheel_requested');
    // The two appends have a total order, and the queue is that order.
    expect(rows[0].seq).toBeLessThan(rows[1].seq);
    expect(queued.map((r) => r.requestId)).toEqual(rows.map((e) => e.payload.requestId));
    expect(queued.map((r) => r.by.kind)).toEqual(seqs);

    // And the release hands the wheel to the HEAD of that order, not to whoever asked last.
    const released = releaseWheel(db, run.id, { by: A });
    expect(released.ok).toBe(true);
    expect(getRun(db, run.id)!.driver.kind).toBe(queued[0].by.kind);
    expect(payloads(run.id, 'driver.changed')[0]).toMatchObject({ cause: 'release', requestId: queued[0].requestId });
  });
});

describe('transitions (§1.3)', () => {
  it('grant-by-requestId answers THAT request, and retires it', () => {
    const run = newRun();
    const b = requestWheel(db, run.id, { by: B });
    const c = requestWheel(db, run.id, { by: C });
    const granted = grantWheel(db, run.id, { by: A, requestId: c.ok ? c.requestId : undefined });
    expect(granted.ok).toBe(true);

    const after = getRun(db, run.id)!;
    expect(after.driver).toEqual(C);
    // B is still waiting — a grant answers one request, it does not empty the queue.
    expect(after.wheelRequests.map((r) => r.requestId)).toEqual([b.ok ? b.requestId : '']);
    expect(payloads(run.id, 'driver.changed')[0]).toMatchObject({ cause: 'grant', requestId: c.ok ? c.requestId : '' });
  });

  it('refuses a grant naming a request that is not queued', () => {
    const run = newRun();
    const refused = grantWheel(db, run.id, { by: A, requestId: 'wr_nope' });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error_reason).toBe('unknown_request');
    expect(getRun(db, run.id)!.driver).toEqual(A);
  });

  it('refuses a grant that names no successor at all', () => {
    const run = newRun();
    const refused = grantWheel(db, run.id, { by: A });
    expect(!refused.ok && refused.error_reason).toBe('no_successor');
  });

  it('drops the new driver’s own pending request — a gesture nobody can answer is not left standing', () => {
    const run = newRun();
    requestWheel(db, run.id, { by: B });
    grantWheel(db, run.id, { by: A, to: B });
    expect(getRun(db, run.id)!.driver).toEqual(B);
    expect(getRun(db, run.id)!.wheelRequests).toEqual([]);
  });

  it('release into an EMPTY queue lands on human and pauses the run (A-51-10)', () => {
    const run = newRun();
    const released = releaseWheel(db, run.id, { by: A });
    expect(released.ok).toBe(true);
    const after = getRun(db, run.id)!;
    expect(after.driver).toEqual(HUMAN);
    // Paused rather than silently idle: the tray has to be able to say the run needs someone.
    expect(after.status).toBe('paused');
    expect(types(run.id)).toEqual(['run.created', 'driver.changed', 'run.paused']);
    expect(payloads(run.id, 'run.paused')[0]).toEqual({ reason: 'agent', detail: 'driver released' });
  });

  it('a human takeover is absolute — instant, unqueued, and it does not wait for the queue', () => {
    const run = newRun();
    requestWheel(db, run.id, { by: B });
    const took = takeWheel(db, run.id, { by: HUMAN, reason: 'sign-in needs you' });
    expect(took.ok).toBe(true);
    const after = getRun(db, run.id)!;
    expect(after.driver).toEqual(HUMAN);
    // B is still in the queue: a takeover answers nobody's request, it overrides everybody's.
    expect(after.wheelRequests).toHaveLength(1);
    expect(payloads(run.id, 'driver.changed')[0]).toMatchObject({ cause: 'takeover', reason: 'sign-in needs you' });
  });

  it('refuses a takeover by a machine driver — the agent never seizes', () => {
    const run = newRun();
    const refused = takeWheel(db, run.id, { by: B });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error_reason).toBe('not_the_driver');
    expect(getRun(db, run.id)!.driver).toEqual(A);
  });

  it('lets a human hand the wheel on even though it is not the driver — a human outranks the driver', () => {
    const run = newRun();
    expect(grantWheel(db, run.id, { by: HUMAN, to: B }).ok).toBe(true);
    expect(getRun(db, run.id)!.driver).toEqual(B);
  });

  it('refuses a grant or a release by an observer, naming who drives', () => {
    const run = newRun();
    for (const refused of [grantWheel(db, run.id, { by: C, to: C }), releaseWheel(db, run.id, { by: C })]) {
      expect(refused.ok).toBe(false);
      expect(!refused.ok && refused.error_reason).toBe('not_the_driver');
      expect(!refused.ok && refused.driver).toEqual(A);
    }
    expect(types(run.id)).toEqual(['run.created']);
  });

  it('emits NOTHING when the wheel would not actually move', () => {
    const run = newRun();
    const granted = grantWheel(db, run.id, { by: A, to: { kind: 'cli', client: { name: 'claude-code', version: '2.1.0' } } });
    expect(granted.ok && granted.events).toEqual([]);
    expect(types(run.id)).toEqual(['run.created']);
  });

  it('refuses every gesture on a run that does not exist', () => {
    const refused = requestWheel(db, 'zzzz', { by: B });
    expect(!refused.ok && refused.error_reason).toBe('run_not_found');
  });
});

describe('formatDriver is the one name (law 3: shown identically everywhere)', () => {
  it('renders kind and client, and kind alone when there is no badge', () => {
    expect(formatDriver(A)).toBe('cli (claude-code)');
    expect(formatDriver(HUMAN)).toBe('human');
    expect(formatDriver({ kind: 'studio' })).toBe('studio');
  });

  it('names no engine, library or model — only the product vocabulary and what the client called itself', () => {
    expect(formatDriver(A)).not.toMatch(/playwright|chromium|cdp|electron/i);
  });
});

describe('observers (§7 row 12) — the read half', () => {
  function run(driver: Driver): Run {
    return { ...newRun(driver), id: 'r' } as Run;
  }

  it('refuses a client that is not the driver, naming who is', () => {
    const refused = notDriving(run(A), { name: 'other-harness', version: '1.0.0' });
    expect(refused?.error_reason).toBe('not_the_driver');
    expect(refused?.driverName).toBe('cli (claude-code)');
    expect(refused?.hint).toContain('Request the wheel');
  });

  it('lets the driver through — same name, same version', () => {
    expect(notDriving(run(A), { name: 'claude-code', version: '2.1.0' })).toBeUndefined();
  });

  it('refuses every machine client while a HUMAN drives — no badge can ever match that one', () => {
    expect(notDriving(run(HUMAN), { name: 'claude-code', version: '2.1.0' })?.driverName).toBe('human');
    expect(notDriving(run(HUMAN), undefined)?.error_reason).toBe('not_the_driver');
  });

  it('allows on an ABSENCE of information rather than refusing on one', () => {
    // Self-reported identity (A-51-9) coordinates cooperating clients; it does not fence a lying
    // one. A gate that refused when it could not tell WHO was calling would be pretending to.
    expect(notDriving(run({ kind: 'cli' }), { name: 'claude-code', version: '2.1.0' })).toBeUndefined();
    expect(notDriving(run(A), undefined)).toBeUndefined();
  });
});
