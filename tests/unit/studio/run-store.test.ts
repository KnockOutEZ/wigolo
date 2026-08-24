import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations, _resetMigrationGuard } from '../../../src/cache/migrations/runner.js';
import {
  createRun,
  appendEvent,
  getRun,
  listRuns,
  eventsSince,
  runExists,
  projectRun,
  mintRunId,
  normalizeRunId,
  RUN_ID_ALPHABET,
  RUN_ID_MIN_LENGTH,
  MAX_TASK_CHARS,
  AUTO_DENY_MS,
  MAX_LIST_LIMIT,
  MAX_LIST_SCAN_PAGES,
  MAX_LIST_SCAN_ROWS,
  DEFAULT_SPACE_ID,
  isValidListCursor,
  MAX_EVENT_PAYLOAD_CHARS,
  runDir,
  runEventsFile,
  flushRunEventProjections,
  _resetPreparedStatements,
  type RunEvent,
  type Run,
  type RunStatus,
} from '../../../src/studio/run-store.js';

let dir: string;
let db: Database.Database;

function freshDb(): Database.Database {
  _resetMigrationGuard();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  applyMigrations(d, { vecLoaded: false });
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-run-store-'));
  db = freshDb();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ dataDir: dir });

/**
 * A handle whose event INSERT fails the way a full disk does — the only way to force the window
 * between the run row and its birth event deterministically. A SIGKILL cannot be aimed at it.
 *
 * Everything else forwards to the real database, including `transaction`, so the rollback under
 * test is SQLite's own and not the proxy's.
 */
function failEventInsert(real: Database.Database): Database.Database {
  const forward = (target: Database.Database, prop: string | symbol): unknown => {
    const value = Reflect.get(target, prop) as unknown;
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  };
  return new Proxy(real, {
    get(target, prop) {
      if (prop !== 'prepare') return forward(target, prop);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!/INSERT INTO studio_run_events/i.test(sql)) return stmt;
        return new Proxy(stmt, {
          get(s, p) {
            if (p !== 'run') {
              const value = Reflect.get(s, p) as unknown;
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(s) : value;
            }
            return () => {
              const err: Error & { code?: string } = new Error('database or disk is full');
              err.code = 'SQLITE_FULL';
              throw err;
            };
          },
        });
      };
    },
  });
}

describe('run-store — short ids (§2)', () => {
  it('mints ids only from the read-aloud alphabet, at the spec length', () => {
    for (let i = 0; i < 200; i++) {
      const id = mintRunId();
      expect(id).toHaveLength(RUN_ID_MIN_LENGTH);
      // The alphabet exists so an id survives being read aloud and typed from a result footer:
      // 0/1/i/l/o/u are the characters that do not survive that trip.
      for (const ch of id) expect(RUN_ID_ALPHABET).toContain(ch);
    }
  });

  it('excludes every character that a human confuses when reading an id aloud', () => {
    for (const banned of ['0', '1', 'i', 'l', 'o', 'u']) {
      expect(RUN_ID_ALPHABET).not.toContain(banned);
    }
    expect(new Set(RUN_ID_ALPHABET).size).toBe(RUN_ID_ALPHABET.length);
  });

  it('lowercases an id on input so a footer typed in caps still resolves', () => {
    const run = createRun(db, { task: 'a task' }, { ...opts(), mintId: () => '7fq2' });
    expect(normalizeRunId(' 7FQ2 ')).toBe('7fq2');
    expect(getRun(db, '7FQ2')?.id).toBe(run.id);
  });

  it('re-mints at the same length up to 3 times, then grows the id by one character', () => {
    createRun(db, { task: 'first' }, { ...opts(), mintId: () => 'aaaa' });
    const lengths: number[] = [];
    const run = createRun(db, { task: 'second' }, {
      ...opts(),
      mintId: (len) => { lengths.push(len); return len === RUN_ID_MIN_LENGTH ? 'aaaa' : 'bbbbb'; },
    });
    // Three collisions at length 4 — no more — then length 5. A fourth length-4 attempt would mean
    // the rule drifted to "retry forever at a saturating length", which is the hang this rule prevents.
    expect(lengths).toEqual([4, 4, 4, 5]);
    expect(run.id).toBe('bbbbb');
  });

  it('never reuses an id that is already stored', () => {
    createRun(db, { task: 'first' }, { ...opts(), mintId: () => 'aaaa' });
    expect(() => createRun(db, { task: 'clash' }, { ...opts(), mintId: () => 'aaaa' })).toThrow(/id/i);
    expect(db.prepare('SELECT COUNT(*) c FROM studio_runs').get()).toEqual({ c: 1 });
  });
});

describe('run-store — create (§1)', () => {
  it('writes run.created as seq 1 and returns the projection', () => {
    const run = createRun(db, { task: 'find a monitor', driver: { kind: 'api' } }, opts());
    expect(run.lastSeq).toBe(1);
    expect(run.status).toBe('running');
    expect(run.spaceId).toBe('default');
    expect(run.visibility).toBe('hidden');
    expect(run.driver).toEqual({ kind: 'api' });
    expect(run.cost).toEqual({ browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 });
    expect(run.tabIds).toEqual([]);
    expect(run.pendingDecisions).toEqual([]);
    const events = eventsSince(db, run.id, 0);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('run.created');
    expect(events[0].seq).toBe(1);
    expect(run.createdAt).toBe(events[0].ts);
  });

  it('defaults visibility to hidden — a run exists whether or not anyone is watching (law 2)', () => {
    expect(createRun(db, { task: 't' }, opts()).visibility).toBe('hidden');
  });

  it('records the linking session id on run.created when one spawned the run', () => {
    const run = createRun(db, { task: 't', sessionId: 'sess-1' }, opts());
    expect(eventsSince(db, run.id, 0)[0].payload).toMatchObject({ sessionId: 'sess-1' });
  });

  it('refuses an empty or oversize task', () => {
    expect(() => createRun(db, { task: '   ' }, opts())).toThrow(/task/i);
    expect(() => createRun(db, { task: 'x'.repeat(MAX_TASK_CHARS + 1) }, opts())).toThrow(/task/i);
    expect(() => createRun(db, { task: 'x'.repeat(MAX_TASK_CHARS) }, opts())).not.toThrow();
  });

  it('refuses a driver outside the law-3 vocabulary', () => {
    expect(() => createRun(db, { task: 't', driver: { kind: 'robot' } as never }, opts())).toThrow(/driver/i);
  });

  /**
   * WHY: law 1 says the event log is the single source of truth, so a `studio_runs` row whose
   * `run.created` never landed is a fact the log does not contain — and it is visible, because
   * `listRuns` reads the row directly. The mint and the birth event have to commit together or not
   * at all; otherwise a crash between them leaves an orphan running at last_seq 0, and the caller's
   * retry mints a SECOND run for one task.
   */
  it('leaves no run row behind when the birth event cannot be written', () => {
    const failing = failEventInsert(db);
    expect(() => createRun(failing, { task: 'find a monitor' }, { ...opts(), mintId: () => 'aaaa' }))
      .toThrow(/disk is full/i);

    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_run_events').get()).toEqual({ n: 0 });
    // The orphan's whole cost was that a surface could see it. Both surfaces stay clean.
    expect(listRuns(db).runs).toEqual([]);
    expect(runExists(db, 'aaaa')).toBe(false);
  });

  it('still mints a fresh id on the retry after a failed create — no half-run to collide with', () => {
    const failing = failEventInsert(db);
    expect(() => createRun(failing, { task: 't' }, { ...opts(), mintId: () => 'aaaa' })).toThrow();
    const run = createRun(db, { task: 't' }, { ...opts(), mintId: () => 'aaaa' });
    expect(run.id).toBe('aaaa');
    expect(run.lastSeq).toBe(1);
  });
});

describe('run-store — append-only event log (law 1)', () => {
  it('assigns seq itself, gap-free and monotonic, ignoring anything the caller supplies', () => {
    const run = createRun(db, { task: 't' }, opts());
    for (let i = 0; i < 5; i++) {
      // A caller handing us a seq must not be able to place an event: seq is the store's to assign.
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `t${i}`, seq: 99 } }, opts());
    }
    expect(eventsSince(db, run.id, 0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('exposes no update or delete path for an event', () => {
    // Append-only is a property of the seam, not a habit of its callers: there is no exported
    // function that could rewrite history even if a caller wanted to.
    const exported = Object.keys(store);
    for (const name of exported) {
      expect(name, `mutating export ${name}`).not.toMatch(/^(update|delete|remove|edit|rewrite|patch|prune|purge|truncate|clear)/i);
    }
  });

  it('has no UPDATE or DELETE against studio_run_events anywhere in src/', () => {
    const hits = scanSrc(/\b(update\s+studio_run_events|delete\s+from\s+studio_run_events)\b/i);
    expect(hits).toEqual([]);
    // Control: the same scan does find the INSERT that must exist, so an empty result above is
    // evidence rather than a broken scanner.
    expect(scanSrc(/insert\s+into\s+studio_run_events/i).length).toBeGreaterThan(0);
  });

  it('reads events strictly greater than the given seq, in order', () => {
    const run = createRun(db, { task: 't' }, opts());
    for (let i = 0; i < 4; i++) appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } }, opts());
    expect(eventsSince(db, run.id, 3).map((e) => e.seq)).toEqual([4, 5]);
    expect(eventsSince(db, run.id, 5)).toEqual([]);
  });

  it('refuses an event type outside the dot-namespaced grammar', () => {
    const run = createRun(db, { task: 't' }, opts());
    for (const bad of ['tabattached', 'Tab.Attached', 'tab.', '.attached', 'tab..attached', '1tab.attached', 'tab.attached;drop']) {
      expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: bad }, opts()), bad).toThrow(/type/i);
    }
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'driver.requested' }, opts())).not.toThrow();
  });

  it('accepts an unknown future event type — the store polices mechanics, never legality (A-43-6)', () => {
    const run = createRun(db, { task: 't' }, opts());
    // A terminal event followed by a tab attach is illegal run logic and legal store mechanics.
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'delivery.queued', payload: { future: true } }, opts())).not.toThrow();
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'x' } }, opts())).not.toThrow();
  });

  it('refuses a payload that is not a JSON object', () => {
    const run = createRun(db, { task: 't' }, opts());
    for (const bad of [[], 'text', 42, null]) {
      expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'x.y', payload: bad as never }, opts())).toThrow(/payload/i);
    }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'x.y', payload: cyclic }, opts())).toThrow(/payload/i);
  });

  it('refuses an actor outside the vocabulary and an append to an unknown run', () => {
    const run = createRun(db, { task: 't' }, opts());
    expect(() => appendEvent(db, run.id, { actor: { kind: 'ghost' } as never, type: 'x.y' }, opts())).toThrow(/actor/i);
    // A well-formed id nothing minted is "not found"; a string that could never BE an id is refused
    // before the lookup, because it is a caller bug rather than a miss.
    expect(() => appendEvent(db, 'zzzz', { actor: { kind: 'agent' }, type: 'x.y' }, opts())).toThrow(/not found/i);
    expect(() => appendEvent(db, 'nope', { actor: { kind: 'agent' }, type: 'x.y' }, opts())).toThrow(/invalid run id/i);
  });
});

describe('run-store — derived fields are projections of the log (law 1)', () => {
  function busyRun(): Run {
    const run = createRun(db, { task: 'busy', driver: { kind: 'cli', client: { name: 'a-harness', version: '2.1.0' } } }, opts());
    const a = (type: string, payload?: Record<string, unknown>) =>
      appendEvent(db, run.id, { actor: { kind: 'agent', driver: 'cli' }, type, payload }, opts());
    a('tab.attached', { tabId: 'tab-1', url: 'https://example.com' });
    a('tab.attached', { tabId: 'tab-2' });
    a('tab.detached', { tabId: 'tab-1', reason: 'closed' });
    a('cost.recorded', { kind: 'browser_action', amount: 3 });
    a('cost.recorded', { kind: 'browser_action', amount: 2 });
    a('cost.recorded', { kind: 'tokens_in', amount: 1200 });
    a('cost.recorded', { kind: 'tokens_out', amount: 340 });
    a('cost.recorded', { kind: 'spend_usd', amount: 0.25 });
    a('decision.requested', { decisionId: 'd1', kind: 'approval', prompt: 'sign in?', anchor: { tabId: 'tab-2', mark: 4 } });
    a('decision.requested', { decisionId: 'd2', kind: 'approval', prompt: 'pay?' });
    a('decision.resolved', { decisionId: 'd1', outcome: 'approved', by: 'human' });
    a('presentation.promoted', { by: 'human', surface: 'tray' });
    return getRun(db, run.id)!;
  }

  it('projects tabs, cost, decisions, driver and visibility from the events', () => {
    const run = busyRun();
    expect(run.tabIds).toEqual(['tab-2']);
    expect(run.cost).toEqual({ browserActions: 5, tokensIn: 1200, tokensOut: 340, spendUsd: 0.25 });
    expect(run.driver).toEqual({ kind: 'cli', client: { name: 'a-harness', version: '2.1.0' } });
    expect(run.visibility).toBe('visible');
    expect(run.pendingDecisions.map((d) => d.decisionId)).toEqual(['d2']);
    expect(run.pendingDecisions[0].autoDenyAt).toBe(
      new Date(new Date(run.pendingDecisions[0].requestedAt).getTime() + 120_000).toISOString(),
    );
  });

  it('a pending decision makes the run need you (pin 5)', () => {
    const run = busyRun();
    expect(run.status).toBe('needs_you');
  });

  it('rebuilding from the events alone reproduces every derived field — no second source of truth', () => {
    const run = busyRun();
    // Corrupt the projection cache on studio_runs. It is a cache; if anything downstream depended on
    // it as a second source of truth, this would change the answer.
    db.prepare(`UPDATE studio_runs SET status = 'done', last_seq = 0, updated_at = NULL WHERE id = ?`).run(run.id);
    const replayed = projectRun(
      { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt },
      eventsSince(db, run.id, 0),
    );
    expect(replayed).toEqual(run);
    expect(getRun(db, run.id)).toEqual(run);
  });

  it('projects each status rule (§1)', () => {
    const mk = (types: Array<[string, Record<string, unknown>?]>): Run => {
      const r = createRun(db, { task: 't' }, opts());
      for (const [type, payload] of types) appendEvent(db, r.id, { actor: { kind: 'agent' }, type, payload }, opts());
      return getRun(db, r.id)!;
    };
    expect(mk([]).status).toBe('running');
    expect(mk([['run.completed']]).status).toBe('done');
    expect(mk([['run.failed', { error: 'the page could not be reached' }]]).status).toBe('failed');
    expect(mk([['run.cancelled', { by: 'human' }]]).status).toBe('cancelled');
    // A cap or a decision pauses and ASKS — that is not the same state as an agent parking itself.
    expect(mk([['run.paused', { reason: 'cost_cap' }]]).status).toBe('needs_you');
    expect(mk([['run.paused', { reason: 'action_cap' }]]).status).toBe('needs_you');
    expect(mk([['run.paused', { reason: 'decision' }]]).status).toBe('needs_you');
    expect(mk([['run.paused', { reason: 'agent' }]]).status).toBe('paused');
    expect(mk([['run.paused', { reason: 'human' }]]).status).toBe('paused');
    expect(mk([['run.paused', { reason: 'agent' }], ['run.resumed', { by: 'human' }]]).status).toBe('running');
    // A terminal event outranks a pause: rule 1 is evaluated first.
    expect(mk([['run.paused', { reason: 'cost_cap' }], ['run.completed']]).status).toBe('done');
  });

  it('demote returns a run to hidden', () => {
    const run = createRun(db, { task: 't' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'human' }, type: 'presentation.promoted', payload: { by: 'human', surface: 'tray' } }, opts());
    appendEvent(db, run.id, { actor: { kind: 'human' }, type: 'presentation.demoted', payload: { by: 'human' } }, opts());
    expect(getRun(db, run.id)!.visibility).toBe('hidden');
  });

  it('ignores an event type it does not know when projecting, and keeps it in the log', () => {
    const run = createRun(db, { task: 't' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 3 } }, opts());
    const projected = getRun(db, run.id)!;
    expect(projected.status).toBe('running');
    expect(projected.lastSeq).toBe(2);
    // Forward compatibility is "ignore, preserve" — never "drop".
    expect(eventsSince(db, run.id, 0).map((e) => e.type)).toEqual(['run.created', 'mark.placed']);
  });
});

/**
 * WHY: `autoDenyAt` was durable state nothing read. The app's in-memory two-minute timer was the
 * ONLY writer of the resolving `decision.resolved`, so a crash after the broker auto-denied the
 * action and before that append left a log whose replay still says "a human is needed" — the dock
 * badge lit over a card that no longer exists, and no reconciler anywhere to put it out.
 *
 * Expiry is derived, like every other projected field (law 1). The log is not rewritten.
 */
describe('run-store — a pending decision expires on its own clock (pin 3)', () => {
  const t0 = new Date('2026-08-23T10:00:00.000Z');
  const at = (ms: number) => () => new Date(t0.getTime() + ms);

  function runNeedingADecision(payload: Record<string, unknown> = {}): string {
    const run = createRun(db, { task: 'sign in to the vendor portal' }, { ...opts(), now: () => t0 });
    appendEvent(db, run.id, {
      actor: { kind: 'agent' },
      type: 'decision.requested',
      payload: { decisionId: 'd1', kind: 'approval', prompt: 'sign in?', ...payload },
    }, { ...opts(), now: () => t0 });
    return run.id;
  }

  it('still needs you while the card can be answered', () => {
    const run = getRun(db, runNeedingADecision(), { now: at(AUTO_DENY_MS - 1) })!;
    expect(run.status).toBe('needs_you');
    expect(run.pendingDecisions.map((d) => d.decisionId)).toEqual(['d1']);
    expect(run.pendingDecisions[0].autoDenyAt).toBe(new Date(t0.getTime() + AUTO_DENY_MS).toISOString());
  });

  it('drops the card and the needs_you the instant autoDenyAt passes, with nothing appended', () => {
    const id = runNeedingADecision();
    const run = getRun(db, id, { now: at(AUTO_DENY_MS) })!;
    expect(run.status).toBe('running');
    expect(run.pendingDecisions).toEqual([]);
    expect(eventsSince(db, id).map((e) => e.type)).toEqual(['run.created', 'decision.requested']);
  });

  it('expires the same way in a list page — one projection, every surface', () => {
    const id = runNeedingADecision();
    const statusAt = (ms: number) => listRuns(db, { now: at(ms) }).runs.find((r) => r.id === id)!.status;
    expect(statusAt(AUTO_DENY_MS - 1)).toBe('needs_you');
    expect(statusAt(AUTO_DENY_MS)).toBe('running');
  });

  it('measures the deadline from the payload requestedAt when the caller supplied one', () => {
    // The card was raised a minute before the mirror got round to logging it; the clock the human
    // saw is the payload's, not the envelope's.
    const early = new Date(t0.getTime() - 60_000).toISOString();
    const id = runNeedingADecision({ requestedAt: early });
    expect(getRun(db, id, { now: at(-1) })!.status).toBe('needs_you');
    expect(getRun(db, id, { now: at(AUTO_DENY_MS - 60_000) })!.status).toBe('running');
  });

  it('falls back to the envelope ts when requestedAt is unparseable, instead of poisoning the run', () => {
    // A `new Date('later today').toISOString()` throws, and it threw inside the projection — which
    // made one bad payload enough to make the whole run unreadable on every surface.
    const id = runNeedingADecision({ requestedAt: 'later today' });
    expect(getRun(db, id, { now: at(0) })!.status).toBe('needs_you');
    expect(getRun(db, id, { now: at(AUTO_DENY_MS) })!.status).toBe('running');
  });

  it('lights again for a fresh decision raised after an expired one', () => {
    const id = runNeedingADecision();
    const later = new Date(t0.getTime() + AUTO_DENY_MS + 1_000);
    appendEvent(db, id, {
      actor: { kind: 'agent' },
      type: 'decision.requested',
      payload: { decisionId: 'd2', kind: 'approval', prompt: 'accept the cookie wall?' },
    }, { ...opts(), now: () => later });
    const run = getRun(db, id, { now: () => later })!;
    expect(run.status).toBe('needs_you');
    expect(run.pendingDecisions.map((d) => d.decisionId)).toEqual(['d2']);
  });

  it('refreshes the cached status column on the next append, so a filtered list agrees too', () => {
    const id = runNeedingADecision();
    const later = new Date(t0.getTime() + AUTO_DENY_MS + 1);
    appendEvent(db, id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 't1' } }, { ...opts(), now: () => later });
    expect(db.prepare('SELECT status FROM studio_runs WHERE id = ?').get(id)).toEqual({ status: 'running' });
    expect(listRuns(db, { status: ['needs_you'], now: () => later }).runs).toEqual([]);
  });

  /**
   * WHY (K7): the filter used to be answered by the cached `status` COLUMN while the rows were
   * answered by the projection, and nothing in `src/` writes that column except an append. So one
   * instant past a deadline, with nothing appended, `?status=running` EXCLUDED a run the projection
   * calls running, and `?status=needs_you` returned a row whose own body said `"status":"running"` —
   * a page contradicting its own filter, which is the badge nobody can clear all over again.
   *
   * Both sides of the deadline, zero appends: the column is deliberately asserted stale here, so
   * this test fails the moment the filter starts answering from it again.
   */
  it('agrees with its own filter on both sides of the deadline, with nothing appended (K7)', () => {
    const id = runNeedingADecision();
    const listed = (status: RunStatus[], ms: number) =>
      listRuns(db, { status, now: at(ms) }).runs.filter((r) => r.id === id).map((r) => r.status);

    expect(listed(['needs_you'], AUTO_DENY_MS - 1)).toEqual(['needs_you']);
    expect(listed(['running'], AUTO_DENY_MS - 1)).toEqual([]);

    // The column has not moved and cannot: no append, no writer, no sweeper (pin 3 keeps expiry
    // event-free by design).
    expect(db.prepare('SELECT status FROM studio_runs WHERE id = ?').get(id)).toEqual({ status: 'needs_you' });

    expect(listed(['needs_you'], AUTO_DENY_MS)).toEqual([]);
    expect(listed(['running'], AUTO_DENY_MS)).toEqual(['running']);
  });

  /**
   * The acceptance criterion stated as a property rather than as one instant: for every status, a
   * filtered page may only contain rows whose own projected status is one the caller asked for.
   */
  it('never returns a body disagreeing with the filter that selected it, at any instant', () => {
    const pending = runNeedingADecision();
    const done = createRun(db, { task: 'finished' }, { ...opts(), now: () => t0 }).id;
    appendEvent(db, done, { actor: { kind: 'agent' }, type: 'run.completed' }, { ...opts(), now: () => t0 });
    const paused = createRun(db, { task: 'paused' }, { ...opts(), now: () => t0 }).id;
    appendEvent(db, paused, { actor: { kind: 'agent' }, type: 'run.paused', payload: { reason: 'cap' } }, { ...opts(), now: () => t0 });

    const statuses: RunStatus[] = ['running', 'needs_you', 'paused', 'done', 'failed', 'cancelled'];
    for (const ms of [0, AUTO_DENY_MS - 1, AUTO_DENY_MS, AUTO_DENY_MS * 2]) {
      const seen = new Set<string>();
      for (const status of statuses) {
        for (const run of listRuns(db, { status: [status], now: at(ms) }).runs) {
          expect(run.status, `${status} @ ${ms}ms`).toBe(status);
          seen.add(run.id);
        }
      }
      // ...and the six filters between them still cover every run, so agreement was not bought by
      // dropping rows.
      expect([...seen].sort()).toEqual([pending, done, paused].sort());
    }
  });
});

describe('run-store — list (§5.3 semantics, in the store)', () => {
  it('orders newest first and pages by an opaque keyset cursor', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(createRun(db, { task: `task ${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, i)) }).id);
    }
    const first = listRuns(db, { limit: 2 });
    expect(first.runs.map((r) => r.id)).toEqual([ids[4], ids[3]]);
    expect(first.nextCursor).toBeTruthy();
    const second = listRuns(db, { limit: 2, cursor: first.nextCursor });
    expect(second.runs.map((r) => r.id)).toEqual([ids[2], ids[1]]);
    const third = listRuns(db, { limit: 2, cursor: second.nextCursor });
    expect(third.runs.map((r) => r.id)).toEqual([ids[0]]);
    expect(third.nextCursor).toBeUndefined();
  });

  /**
   * WHY: `Buffer.from(x, 'base64url')` never throws — it silently drops what it cannot read — and a
   * cursor that decoded to nothing was treated as "no cursor". So a corrupted or truncated cursor
   * restarted pagination from page 1 with no signal: a client paging in a loop never terminates,
   * and a client processing each page double-processes the first and stops.
   */
  it('refuses a cursor that does not decode rather than silently restarting page 1', () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(createRun(db, { task: `task ${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, i)) }).id);
    }
    const first = listRuns(db, { limit: 2 });
    const good = first.nextCursor!;

    for (const bad of [
      'not a cursor',                              // spaces are not in the alphabet
      '@@@@',                                      // nor is punctuation
      good.slice(0, -3),                           // truncated in transit
      Buffer.from('no newline here').toString('base64url'),   // decodes, but is not a keyset pair
      Buffer.from('not-a-date\nabcd').toString('base64url'),  // a pair whose left half is not a time
      Buffer.from('2026-08-22T00:00:00.000Z\n').toString('base64url'), // empty id half
    ]) {
      expect(() => listRuns(db, { limit: 2, cursor: bad }), bad).toThrow(/cursor/i);
      expect(isValidListCursor(bad)).toBe(false);
    }

    // ...and the honest one still pages, which is the half a blanket rejection would break.
    expect(isValidListCursor(good)).toBe(true);
    expect(listRuns(db, { limit: 2, cursor: good }).runs.map((r) => r.id)).toEqual([ids[2], ids[1]]);
  });

  it('filters by status and space', () => {
    const a = createRun(db, { task: 'a' }, opts());
    const b = createRun(db, { task: 'b', spaceId: 'other' }, opts());
    appendEvent(db, a.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());
    expect(listRuns(db, { status: ['done'] }).runs.map((r) => r.id)).toEqual([a.id]);
    expect(listRuns(db, { status: ['running'] }).runs.map((r) => r.id)).toEqual([b.id]);
    expect(listRuns(db, { spaceId: 'other' }).runs.map((r) => r.id)).toEqual([b.id]);
  });

  /**
   * WHY: the status filter is decided on the projection, AFTER the rows are read, so a page is only
   * full once enough matching rows have been found — which can take several reads when the matches
   * are sparse. A filtered page that stopped at the first read would come back short with no cursor
   * and read as "that was all".
   */
  it('fills a status-filtered page across non-matching rows, and pages through the matches', () => {
    const wanted: string[] = [];
    for (let i = 0; i < 12; i++) {
      const run = createRun(db, { task: `task ${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, i)) });
      // Every third run is the one being looked for; the other two are noise between the matches.
      if (i % 3 === 0) wanted.push(run.id);
      else appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());
    }
    const newestFirst = [...wanted].reverse();

    const first = listRuns(db, { status: ['running'], limit: 2 });
    expect(first.runs.map((r) => r.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.nextCursor).toBeTruthy();
    const second = listRuns(db, { status: ['running'], limit: 2, cursor: first.nextCursor });
    expect(second.runs.map((r) => r.id)).toEqual(newestFirst.slice(2, 4));
    expect(second.nextCursor).toBeUndefined();

    // The whole set in one page, and the complement, so the paging above is not hiding a dropped row.
    expect(listRuns(db, { status: ['running'] }).runs.map((r) => r.id)).toEqual(newestFirst);
    expect(listRuns(db, { status: ['done'] }).runs).toHaveLength(8);
    expect(listRuns(db, { status: ['running', 'done'] }).runs).toHaveLength(12);
  });

  /**
   * WHY: scanning forward for matches has to stop somewhere, or a filter matching nothing walks the
   * whole table on the event loop. It stops after a bounded number of reads — and when it stops
   * early it says so with a cursor, because a short page with no cursor is indistinguishable from
   * the end of the list and would have the client conclude there is nothing to find.
   */
  it('stops after a bounded number of reads and hands the rest back as a cursor', () => {
    const limit = 2;
    const scannable = MAX_LIST_SCAN_PAGES * (limit + 1);
    for (let i = 0; i < scannable + 10; i++) {
      const run = createRun(db, { task: `task ${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, 0, i)) });
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());
    }
    // Nothing is cancelled, so no read can match and the scan runs to its bound.
    const first = listRuns(db, { status: ['cancelled'], limit });
    expect(first.runs).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    // ...and the cursor is real: it resumes past everything already looked at, and the walk ends.
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor && pages < 20) {
      const next = listRuns(db, { status: ['cancelled'], limit, cursor });
      expect(next.runs).toEqual([]);
      cursor = next.nextCursor;
      pages++;
    }
    expect(cursor).toBeUndefined();
  });

  /**
   * WHY: bounding the READS was never a bound on the WORK. Every scanned row was fully projected,
   * so a filter matching nothing paid up to eight pages of projections — the unbounded per-run
   * reads over every event a run ever wrote — to return an empty page, synchronously, on the
   * daemon's event loop. Measured at 2000 runs x 122 events: 164 ms of blocked loop.
   *
   * A row that does not survive the filter must therefore cost its status and nothing else.
   */
  it('projects only the rows a filter admits, not every row it scans', () => {
    const limit = 2;
    for (let i = 0; i < MAX_LIST_SCAN_PAGES * (limit + 1) + 10; i++) {
      const run = createRun(db, { task: `task ${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, 0, i)) });
      // Events the PROJECTION reads and the status seeds do not, so the two phases are separable in
      // the read log: if a scanned row were still projected, these would show up.
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 't1' } }, opts());
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } }, opts());
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());
    }

    const seen = spyEventReads(db, () => listRuns(db, { status: ['cancelled'], limit }));
    expect(seen.result.runs).toEqual([]);
    // It really did walk to its bound — otherwise "no projections" would be true for trivial reasons.
    expect(seen.result.nextCursor).toBeTruthy();
    const statusHeads = seen.reads.filter((r) => /UNION ALL/i.test(r.sql));
    expect(statusHeads).toHaveLength(MAX_LIST_SCAN_PAGES * (limit + 1));

    // Not one projection read, and not one tail seek: both are per-survivor work and nothing survived.
    expect(seen.reads.filter((r) => /type IN/i.test(r.sql))).toHaveLength(0);
    expect(seen.reads.filter((r) => TAIL_READ.test(r.sql))).toHaveLength(0);
  });

  /**
   * WHY: a page COUNT is not a bound on work when the page is the caller's. At `MAX_LIST_LIMIT` the
   * same eight reads looked at 1608 rows rather than 408, so the ceiling belonged to the request
   * instead of to the store — and `listRuns` has no await in it, so all of it is one uninterruptible
   * block. The pages have to get shorter as the caller's page gets longer.
   */
  it('bounds the rows one call scans however large a page the caller asks for', () => {
    for (let i = 0; i < MAX_LIST_SCAN_ROWS + 12; i++) {
      const run = createRun(db, { task: `task ${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, 0, i)) });
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());
    }

    const seen = spyEventReads(db, () => listRuns(db, { status: ['cancelled'], limit: MAX_LIST_LIMIT }), /\bFROM studio_runs\b/i);
    const scanned = seen.reads.reduce((n, r) => n + r.rows, 0);
    expect(scanned).toBeLessThanOrEqual(MAX_LIST_SCAN_ROWS);
    // ...and it is a BOUND, not a short read: the scan went past the caller's own page.
    expect(scanned).toBeGreaterThan(MAX_LIST_LIMIT);
    expect(seen.reads.length).toBeLessThan(MAX_LIST_SCAN_PAGES);

    // The budget must not be paid for by pretending the table ended: a trimmed read still hands back
    // a cursor, and following it terminates rather than restarting.
    let cursor = seen.result.nextCursor;
    expect(cursor).toBeTruthy();
    let pages = 1;
    while (cursor && pages < 40) {
      const next = listRuns(db, { status: ['cancelled'], limit: MAX_LIST_LIMIT, cursor });
      expect(next.runs).toEqual([]);
      cursor = next.nextCursor;
      pages++;
    }
    expect(cursor).toBeUndefined();
  });

  /**
   * WHY: K7's guarantee is that the filter and the row it admits are ONE value. Deciding the filter
   * cheaply and projecting the survivor is only safe while both come from the same read — a second
   * status answer in front of the row is the exact defect K7 deleted. And a survivor must still be
   * whole: a row admitted by phase one and never projected would list with no tabs and no cost.
   */
  it('projects a survivor in full, with the status that admitted it', () => {
    let wanted = '';
    for (let i = 0; i < 20; i++) {
      const run = createRun(db, { task: `task ${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, 0, i)) });
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } }, opts());
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 4 } }, opts());
      // One match, and deliberately not on the first page, so it is found by the scan and not by luck.
      if (i === 3) { appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.cancelled' }, opts()); wanted = run.id; }
      else appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());
    }

    const page = listRuns(db, { status: ['cancelled'], limit: 2 });
    expect(page.runs.map((r) => r.id)).toEqual([wanted]);
    expect(page.runs[0].status).toBe('cancelled');
    expect(page.runs[0].tabIds).toEqual(['tab-3']);
    expect(page.runs[0].cost.browserActions).toBe(4);
    // The one read every surface is measured against: a listed row equals the item read, filter or not.
    expect(page.runs[0]).toEqual(getRun(db, wanted));
  });

  /**
   * WHY: the clamp is the only thing in front of `SELECT ... LIMIT ?` on the list route, and the
   * broker path reaches the store with no REST layer to reject a limit first. The test that stood
   * here created THREE runs and asserted the page was at most 200 — true whether the clamp existed
   * or not, so it could not go red for the defect it names.
   */
  it('caps the page size so one call cannot ask for the whole store', () => {
    // One past the cap, so a page that returns everything is visibly one row too long — and so the
    // cursor has something to point at.
    for (let i = 0; i <= MAX_LIST_LIMIT; i++) {
      createRun(db, { task: `t${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, i)) });
    }
    const page = listRuns(db, { limit: 10_000 });
    expect(page.runs).toHaveLength(MAX_LIST_LIMIT);
    // A clamp that silently drops the remainder is the other half of the defect: the caller has to
    // be told there is more, or a paging loop stops one page short of the store.
    expect(page.nextCursor).toBeDefined();
    const rest = listRuns(db, { limit: 10_000, cursor: page.nextCursor });
    expect(rest.runs).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    // Newest first, and the two pages are disjoint — the clamp cannot be met by returning the same
    // 200 rows twice.
    expect(new Set([...page.runs, ...rest.runs].map((r) => r.id)).size).toBe(MAX_LIST_LIMIT + 1);
    expect(rest.runs[0].task).toBe('t0');
  });
});

/**
 * WHY: a run id is `join()`ed into a filesystem path by `runDir`, and the store's own bound on what
 * it will persist is the only thing standing between an event log and a disk-fill. Neither is
 * reachable from outside today — the callers all pass minted ids, and REST caps its own fields —
 * but both preconditions live in OTHER files, which is precisely the kind that a later caller
 * deletes without noticing.
 */
describe('run-store — an id is an id and a payload is bounded (structural guards)', () => {
  it('refuses anything outside the mint alphabet as a run id', () => {
    for (const bad of ['../../etc/passwd', '..', 'a/b/c', 'run-1', 'nope', 'aa', 'a'.repeat(9), '', '  ']) {
      expect(() => normalizeRunId(bad), bad).toThrow(/invalid run id/i);
      expect(() => runDir(bad, dir), bad).toThrow(/invalid run id/i);
      expect(() => runEventsFile(bad, dir), bad).toThrow(/invalid run id/i);
    }
    // The normalizer's real job still works: trimmed, lowercased, resolvable.
    expect(normalizeRunId(' 7FQ2 ')).toBe('7fq2');
    expect(runDir('7FQ2', dir)).toBe(runDir('7fq2', dir));
  });

  it('never lets a traversal id reach mkdirSync, even from a poisoned row', () => {
    // The row is written behind the store's back, which is the only way this id can exist at all.
    const at = new Date().toISOString();
    db.prepare('INSERT INTO studio_runs (id, task, space_id, created_at, status, last_seq, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?)')
      .run('../../escaped', 'poisoned', 'default', at, 'running', at);

    expect(() => appendEvent(db, '../../escaped', { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 't1' } }, opts()))
      .toThrow(/invalid run id/i);
    // Nothing was written anywhere: not the escape, not a directory under the state dir.
    expect(existsSync(join(dir, 'studio', 'runs'))).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM studio_run_events').get()).toEqual({ n: 0 });
  });

  it('reads an unmintable id as a miss, not an error — a typed URL is a 404', () => {
    // `getRun` and friends are the READ side. A person typing a run id from a result footer must
    // get "no such run", never a stack trace out of a 500.
    expect(getRun(db, 'not an id')).toBeUndefined();
    expect(runExists(db, '../../escaped')).toBe(false);
    expect(eventsSince(db, 'run-1')).toEqual([]);
  });

  it('refuses an event payload past the cap — the log is persisted twice', async () => {
    const run = createRun(db, { task: 'bounded' }, opts());
    const oversize = { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_CHARS) };
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'note.added', payload: oversize }, opts()))
      .toThrow(/payload/i);
    // Refused at the door: no row, no seq burned, no line appended to the on-disk projection.
    expect(eventsSince(db, run.id).map((e) => e.type)).toEqual(['run.created']);
    expect(getRun(db, run.id)!.lastSeq).toBe(1);
    await flushRunEventProjections();
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(1);

    // Just under still appends — the cap has to be a bound, not a ban on real payloads.
    const fits = { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_CHARS - 100) };
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'note.added', payload: fits }, opts())).not.toThrow();
  });
});

describe('run-store — files on disk (law 11, A-43-3)', () => {
  it('writes one envelope per line under the run directory', async () => {
    const run = createRun(db, { task: 'inspectable' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } }, opts());
    await flushRunEventProjections();
    const file = runEventsFile(run.id, dir);
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => JSON.parse(l))).toEqual(eventsSince(db, run.id, 0));
  });

  it('keeps the run directory owner-only', () => {
    const run = createRun(db, { task: 't' }, opts());
    const mode = statSync(join(dir, 'studio', 'runs', run.id)).mode & 0o777;
    if (process.platform !== 'win32') expect(mode).toBe(0o700);
  });

  it('keeps the event file itself owner-only, not merely owner-only by its parent', async () => {
    if (process.platform === 'win32') return;
    const run = createRun(db, { task: 't' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'card number?' } }, opts());
    await flushRunEventProjections();
    // The line above is why: prompts, task text and attached URLs that can carry a query-string
    // token all live in this file, and the 0700 directory stops shielding it the moment the tree is
    // copied, archived or synced.
    expect(statSync(runEventsFile(run.id, dir)).mode & 0o777).toBe(0o600);
  });

  it('is a projection — a lost or damaged file never changes what the store reads back', async () => {
    const run = createRun(db, { task: 't' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 2 } }, opts());
    const before = getRun(db, run.id);
    await flushRunEventProjections();
    rmSync(runEventsFile(run.id, dir));
    expect(getRun(db, run.id)).toEqual(before);
    expect(eventsSince(db, run.id, 0)).toHaveLength(2);
  });

  it('still commits the event when the disk projection cannot be written', () => {
    const run = createRun(db, { task: 't' }, opts());
    // The DB is the source of truth; a full or read-only disk must not lose an event that the
    // agent has already been told happened.
    const unwritable = join(dir, 'no-such-root', '\0bad');
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'x' } }, { dataDir: unwritable })).not.toThrow();
    expect(eventsSince(db, run.id, 0)).toHaveLength(2);
  });
});

describe('run-store — existence probe (§5.5 precondition)', () => {
  it('answers existence without reading the log the paged replay exists to avoid', () => {
    const run = createRun(db, { task: 'exists' }, { dataDir: dir });
    for (let i = 0; i < 40; i++) {
      appendEvent(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: `t${i}` } }, { dataDir: dir });
    }

    expect(runExists(db, run.id)).toBe(true);
    expect(runExists(db, run.id.toUpperCase())).toBe(true);
    expect(runExists(db, 'nope')).toBe(false);

    // The point is not the boolean — `getRun` already returns one. It is that asking costs a single
    // indexed row rather than the whole event log, which is what the SSE route's 404 check needs.
    let readRows = 0;
    const realPrepare = db.prepare.bind(db);
    const spy = ((sql: string) => {
      if (/FROM studio_run_events/i.test(sql)) readRows++;
      return realPrepare(sql);
    }) as typeof db.prepare;
    // The store holds its statements per handle, so a spy on `prepare` only sees the sql it does not
    // already have compiled. Dropping the cache is what makes the count the store's reads and not an
    // artefact of what this test happened to call first.
    _resetPreparedStatements(db);
    Object.defineProperty(db, 'prepare', { value: spy, configurable: true });
    try {
      runExists(db, run.id);
      expect(readRows).toBe(0);
      getRun(db, run.id);
      expect(readRows).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(db, 'prepare', { value: realPrepare, configurable: true });
      _resetPreparedStatements(db);
    }
  });
});

describe('run-store — the event-type grammar is what keeps the SSE wire safe', () => {
  it('refuses an event type that could forge an SSE frame', () => {
    const run = createRun(db, { task: 'grammar' }, { dataDir: dir });
    // The SSE writer interpolates `type` straight into an `event:` line. A CR or LF here would let
    // an event forge `data:`/`event:` fields — so the store, not the writer, is the fence.
    const forgeries = [
      'tab.attached\nevent: run.completed',
      'tab.attached\rdata: {}',
      'tab.attached\n\ndata: {"seq":999}',
      'tab attached',
      'Tab.Attached',
    ];
    for (const type of forgeries) {
      expect(() => appendEvent(db, run.id, { actor: { kind: 'daemon' }, type, payload: {} }, { dataDir: dir }))
        .toThrow(/invalid event type/);
    }
    // And the legal shape still appends, so the guard is not simply refusing everything.
    expect(() => appendEvent(db, run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, { dataDir: dir }))
      .not.toThrow();
  });
});

describe('run-store — live subscription hook', () => {
  it('hands each committed envelope to the subscriber, after the commit', () => {
    const seen: Array<{ runId: string; event: RunEvent }> = [];
    const o = { ...opts(), onEvent: (runId: string, event: RunEvent) => seen.push({ runId, event }) };
    const run = createRun(db, { task: 't' }, o);
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'x' } }, o);
    expect(seen.map((s) => s.event.seq)).toEqual([1, 2]);
    expect(seen.every((s) => s.runId === run.id)).toBe(true);
  });
});

describe('run-store — an append costs its status, not its history (F1)', () => {
  it('recomputes the cached status from status-relevant rows alone, at any log depth', () => {
    const run = createRun(db, { task: 'deep' }, opts());
    const mark = (i: number) => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: i } }, opts());
    for (let i = 0; i < 200; i++) mark(i);
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'sign in?' } }, opts());
    for (let i = 200; i < 400; i++) mark(i);

    const seen = spyEventReads(db, () => mark(400));

    // The log is 402 events deep and exactly one of them can move the status. The old append read
    // and JSON-parsed all 402 — inside BEGIN IMMEDIATE, on the database the search cache and the
    // embedding index queue also write to.
    expect(seen.rows).toBe(1);
    // Two: the five newest-row seeks arrive as one compound statement, and the open card is the
    // second. Nothing settled the status cheaply here, so the decision read was actually asked.
    expect(seen.queries).toBe(2);
    // ...and the answer is still the right one.
    expect(cachedStatus(run.id)).toBe('needs_you');
    expect(getRun(db, run.id)!.status).toBe('needs_you');
  });

  it('does not ask the decision question at all once a cheaper rule has settled the status', () => {
    const run = createRun(db, { task: 'settled' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'ok?' } }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, opts());

    const seen = spyEventReads(db, () => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 1 } }, opts()));
    // A terminal event outranks a pending card, so the anti-join is dead work on a finished run —
    // and a finished run is the one whose decision rows have finished accumulating.
    expect(seen.queries).toBe(1);
    expect(cachedStatus(run.id)).toBe('done');
  });

  /**
   * WHY: the type filter bounded the read to a SET of types, not to a bounded number of ROWS. Two of
   * the seven are writer-controlled pairs — `decision.requested/resolved` and `run.paused/resumed` —
   * and the store polices envelope mechanics only (A-43-6), so nothing caps how many a run
   * accumulates. Measured on the tip: 0.8 ms at 1k decision rows, 60.5 ms at 50k, per append, held
   * against the shared cache database's write lock; appending K of them cost O(K squared) of it.
   */
  it('costs the same at 400 accumulated decision pairs as at 4 — answered cards are not re-read', () => {
    // Back-dated, because that is what "accumulated" means: a pair raised and answered long enough
    // ago that no clock could still be counting down on it.
    const pairs = (n: number): string => {
      const r = createRun(db, { task: 'decisive' }, opts());
      for (let i = 0; i < n; i++) {
        const at = new Date(Date.UTC(2026, 7, 22, 1, 0, 0) + i * 1000);
        const with_ = { ...opts(), now: () => at };
        appendEvent(db, r.id, { actor: { kind: 'human' }, type: 'decision.requested', payload: { decisionId: `d${i}`, prompt: 'ok?' } }, with_);
        appendEvent(db, r.id, { actor: { kind: 'human' }, type: 'decision.resolved', payload: { decisionId: `d${i}`, outcome: 'approved' } }, with_);
      }
      return r.id;
    };

    const shallowId = pairs(4);
    const shallow = spyEventReads(db, () => appendEvent(db, shallowId, { actor: { kind: 'agent' }, type: 'mark.placed' }, opts()));
    db = freshDb();
    const deepId = pairs(400);
    const deep = spyEventReads(db, () => appendEvent(db, deepId, { actor: { kind: 'agent' }, type: 'mark.placed' }, opts()));

    // A hundred times the decision history, identical work. A fixed expectation could be met by a
    // path that happened to hit the number once; the differential is what says "not O(pairs)".
    expect(deep.queries).toBe(shallow.queries);
    expect(deep.rows).toBe(shallow.rows);
    expect(deep.queries).toBe(2);
    // Zero rows come back at either depth: every pair is answered, so the anti-join drops it, and
    // every pair is older than the auto-deny window, so the ts bound never reaches it either.
    expect(deep.rows).toBe(0);
    // ...and 400 answered pairs still leave the run running, which is the answer a replay gives.
    expect(cachedStatus(deepId)).toBe('running');
    expect(getRun(db, deepId)!.status).toBe('running');
  });

  it('reaches those rows through the type index rather than walking the run', () => {
    const run = createRun(db, { task: 'plan' }, opts());
    for (let i = 0; i < 50; i++) appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: i } }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'ok?' } }, opts());

    const seen = spyEventReads(db, () => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: 99 } }, opts()));
    expect(seen.reads).toHaveLength(2);
    const heads = queryPlan(seen.reads[0]);
    const pending = queryPlan(seen.reads[1]);

    // The row count above cannot see this. Ask SQLite for `ORDER BY seq` off the index and it
    // prefers the (run_id, seq) primary key, or sorts the whole type slice in a temp b-tree — either
    // way it touches every row the run has and returns the identical handful, so the read is
    // O(log depth) again with no visible change.
    expect(heads, heads).toContain('idx_studio_run_events_type_seq');
    // `SCAN (subquery-N)` is SQLite reading back a co-routine that has already stopped at one row;
    // a SCAN of the TABLE is the regression, and so is a sort, which is what an index without seq
    // on the tail would force.
    expect(heads, heads).not.toContain('SCAN studio_run_events');
    expect(heads, heads).not.toContain('TEMP B-TREE');
    // The two bounds on the pending read, each visible as an index term. `ts>?` is the one that
    // makes the work independent of how many cards the run has already answered; `seq>?` is what
    // keeps the anti-join from walking the answered ones.
    expect(pending, pending).toContain('idx_studio_run_events_type_ts (run_id=? AND type=? AND ts>?)');
    expect(pending, pending).toContain('idx_studio_run_events_type_seq (run_id=? AND type=? AND seq>?)');
    expect(pending, pending).not.toContain('SCAN studio_run_events');
  });

  it('keeps the cached column equal to a full replay through every status transition', () => {
    const run = createRun(db, { task: 'transitions' }, opts());
    const step = (type: string, payload?: Record<string, unknown>) => {
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type, payload }, opts());
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } }, opts());
      // The cache is what a status-filtered `listRuns` selects on; a replay is the truth. A
      // seek-driven recompute is only correct while these two cannot disagree.
      const replayed = projectRun({ id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt }, eventsSince(db, run.id, 0));
      expect(cachedStatus(run.id), type).toBe(replayed.status);
      return replayed.status;
    };

    expect(step('decision.requested', { decisionId: 'd1', prompt: 'ok?' })).toBe('needs_you');
    expect(step('decision.resolved', { decisionId: 'd1', outcome: 'approved' })).toBe('running');
    expect(step('run.paused', { reason: 'agent' })).toBe('paused');
    expect(step('run.paused', { reason: 'cost_cap' })).toBe('needs_you');
    expect(step('run.resumed', { by: 'human' })).toBe('running');
    expect(step('run.completed')).toBe('done');
  });

  /**
   * WHY: the transitions above are the ones a run makes on purpose. These are the shapes a seek fold
   * can get wrong that a full replay cannot — the ordering facts the JS fold gets for free by
   * walking the log in seq order, and the seek fold has to ask SQLite for.
   */
  it('agrees with a full replay on the orderings a seek has to reconstruct', () => {
    const replayed = (id: string, task: string, createdAt: string) =>
      projectRun({ id, task, spaceId: 'default', createdAt }, eventsSince(db, id, 0)).status;
    const scenario = (name: string, steps: ReadonlyArray<[string, Record<string, unknown>?]>): string => {
      const r = createRun(db, { task: name }, opts());
      for (const [type, payload] of steps) appendEvent(db, r.id, { actor: { kind: 'agent' }, type, payload }, opts());
      expect(cachedStatus(r.id), name).toBe(replayed(r.id, r.task, r.createdAt));
      return cachedStatus(r.id);
    };

    // A terminal event outranks a pause whichever order they arrive in — the seek fold reads the two
    // heads independently, so it cannot infer that from seq the way the replay does.
    expect(scenario('paused after done', [['run.completed'], ['run.paused', { reason: 'agent' }]])).toBe('done');
    expect(scenario('done after paused', [['run.paused', { reason: 'agent' }], ['run.completed']])).toBe('done');
    // The newest terminal wins across DIFFERENT terminal types, which is one seek per type merged.
    expect(scenario('failed then cancelled', [['run.failed'], ['run.cancelled']])).toBe('cancelled');
    expect(scenario('cancelled then failed', [['run.cancelled'], ['run.failed']])).toBe('failed');
    // A resolve that lands BEFORE its request answers nothing — the anti-join is `seq >`, not "ever".
    expect(scenario('resolved early', [
      ['decision.resolved', { decisionId: 'd1', outcome: 'approved' }],
      ['decision.requested', { decisionId: 'd1', prompt: 'ok?' }],
    ])).toBe('needs_you');
    // ...and a re-request after a resolve lights the run again, from the same decisionId.
    expect(scenario('re-requested', [
      ['decision.requested', { decisionId: 'd1', prompt: 'ok?' }],
      ['decision.resolved', { decisionId: 'd1', outcome: 'approved' }],
      ['decision.requested', { decisionId: 'd1', prompt: 'again?' }],
    ])).toBe('needs_you');
    // One card answered while another stays open is still needs_you.
    expect(scenario('one of two', [
      ['decision.requested', { decisionId: 'd1', prompt: 'a?' }],
      ['decision.requested', { decisionId: 'd2', prompt: 'b?' }],
      ['decision.resolved', { decisionId: 'd1', outcome: 'approved' }],
    ])).toBe('needs_you');
    // A card with no decisionId can never be answered, so it never counts as pending either.
    expect(scenario('anonymous card', [['decision.requested', { prompt: 'who?' }]])).toBe('running');
    // A pause whose reason is a cap reads as needs_you; the reason comes off the newest pause row,
    // not off whichever pause the seek happened to find.
    expect(scenario('newest pause reason wins', [
      ['run.paused', { reason: 'cost_cap' }],
      ['run.resumed', { by: 'human' }],
      ['run.paused', { reason: 'agent' }],
    ])).toBe('paused');
  });

  /**
   * WHY: the append path bounds its pending read by `ts >= now - AUTO_DENY_MS`, which is only sound
   * because `requestedAtOf` refuses a claimed time LATER than the envelope. A payload that could
   * push its own deadline forward would sit outside that window and stay pending invisibly — the
   * status cache and a replay would then disagree, permanently, on an append-only log.
   */
  it('refuses a payload that claims to have been raised after the event that records it', () => {
    const run = createRun(db, { task: 'liar' }, opts());
    const future = new Date(Date.now() + 86_400_000).toISOString();
    appendEvent(db, run.id, { actor: { kind: 'human' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'ok?', requestedAt: future } }, opts());

    const card = getRun(db, run.id)!.pendingDecisions[0];
    // The envelope wins: the card's clock started when the log says it did.
    expect(card.requestedAt).not.toBe(future);
    expect(Date.parse(card.autoDenyAt) - Date.parse(card.requestedAt)).toBe(AUTO_DENY_MS);
    // ...and past that deadline the card is gone from both folds, cache and replay alike.
    const after = new Date(Date.parse(card.autoDenyAt) + 1000);
    expect(getRun(db, run.id, { now: () => after })!.status).toBe('running');
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed' }, { ...opts(), now: () => after });
    expect(cachedStatus(run.id)).toBe('running');
  });

  it('still assigns seq gap-free under the write lock', () => {
    const run = createRun(db, { task: 'seq' }, opts());
    for (let i = 0; i < 30; i++) appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: i } }, opts());
    expect(eventsSince(db, run.id, 0).map((e) => e.seq)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(getRun(db, run.id)!.lastSeq).toBe(31);
  });
});

describe('run-store — listing a page is bounded work (F2)', () => {
  function busyRuns(count: number, eventsEach: number): string[] {
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const r = createRun(db, { task: `busy ${n}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, n)) });
      for (let m = 0; m < eventsEach; m++) {
        appendEvent(db, r.id, { actor: { kind: 'agent' }, type: 'mark.placed', payload: { mark: m } }, opts());
      }
      ids.push(r.id);
    }
    return ids;
  }

  it('does the same work at any log depth — the page cost tracks runs, never their history', () => {
    const shallow = (() => {
      const ids = busyRuns(6, 10);
      return { ids, seen: spyEventReads(db, () => listRuns(db, {})) };
    })();
    db = freshDb();
    const deep = (() => {
      const ids = busyRuns(6, 200);
      return { ids, seen: spyEventReads(db, () => listRuns(db, {})) };
    })();

    // Twenty times the log, identical work. A fixed expectation could be met by a slow path that
    // happened to hit the number once; the differential is what says "not O(events)".
    expect(deep.seen.queries).toBe(shallow.seen.queries);
    expect(deep.seen.rows).toBe(shallow.seen.rows);
    // One projection read for the whole page, plus three bounded per-run reads: the newest-row
    // seeks, the pending anti-join and the tail seek. Never the unbounded full-log read per row this
    // replaced, and no cost aggregate either — the counters are columns on the row the page already
    // selected. Three statements against one is the trade: each is O(log depth) or bounded to its
    // own answer, where the types they replaced made one read O(everything the run has done).
    expect(deep.seen.queries).toBe(1 + 3 * deep.ids.length);
    // Per run: `run.created` from the projection read, and the tail row. The 200 marks each are
    // what used to be read, parsed and thrown away, synchronously, before the router could yield.
    expect(deep.seen.rows).toBe(deep.ids.length * 2);
  });

  it('reaches both of those reads through an index rather than walking a log', () => {
    busyRuns(4, 40);
    const seen = spyEventReads(db, () => listRuns(db, {}));

    // Row counts cannot see a scan that returns the right rows — see the append-path test.
    const projection = seen.reads.find((r) => /type IN/i.test(r.sql));
    const tail = seen.reads.find((r) => TAIL_READ.test(r.sql));
    expect(projection).toBeDefined();
    expect(tail).toBeDefined();
    expect(queryPlan(projection!), queryPlan(projection!)).toContain('idx_studio_run_events_type');
    // The tail is the one place ORDER BY earns its keep: reversed on the primary key it stops at
    // the first row. Every page-wide alternative — a correlated max, a GROUP BY, a row-value IN —
    // measured 250x worse at depth because each walks the run.
    expect(queryPlan(tail!), queryPlan(tail!)).toContain('SEARCH');
    expect(queryPlan(tail!), queryPlan(tail!)).not.toContain('TEMP B-TREE');
  });

  /**
   * WHY: the run TABLE was the unindexed half. `ORDER BY created_at DESC, id DESC` over no matching
   * index planned `SCAN studio_runs` + `USE TEMP B-TREE FOR ORDER BY` — the whole table read and the
   * whole table sorted, per page read, on a table that grows forever by design. The keyset predicate
   * that makes pagination stable was doing nothing for the plan, because the columns it names were
   * not in an index.
   *
   * Both shapes are asserted because neither index can serve the other's: a read that does not
   * constrain `space_id` cannot use an index led by it, and a space-scoped read cannot seek without
   * one.
   */
  it('reads the run table through an index rather than scanning and sorting it', () => {
    for (let i = 0; i < 6; i++) {
      createRun(db, { task: `t${i}` }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, i)) });
    }
    const runTable = /\bFROM studio_runs\b/i;

    const first = spyEventReads(db, () => listRuns(db, { limit: 2 }), runTable);
    const firstPlan = queryPlan(first.reads[0]);
    // Ordered index traversal that stops at LIMIT, so there is no sort step left to pay for.
    expect(firstPlan, firstPlan).toContain('idx_studio_runs_created_at');
    expect(firstPlan, firstPlan).not.toContain('TEMP B-TREE');

    // The keyset read — every page after the first — seeks straight to the cursor.
    const keyset = spyEventReads(db, () => listRuns(db, { limit: 2, cursor: first.result.nextCursor }), runTable);
    const keysetPlan = queryPlan(keyset.reads[0]);
    expect(keysetPlan, keysetPlan).toContain('SEARCH');
    expect(keysetPlan, keysetPlan).toContain('idx_studio_runs_created_at');
    expect(keysetPlan, keysetPlan).not.toContain('TEMP B-TREE');

    const scoped = spyEventReads(db, () => listRuns(db, { limit: 2, spaceId: DEFAULT_SPACE_ID }), runTable);
    const scopedPlan = queryPlan(scoped.reads[0]);
    expect(scopedPlan, scopedPlan).toContain('SEARCH');
    expect(scopedPlan, scopedPlan).toContain('idx_studio_runs_space_created_at');
    expect(scopedPlan, scopedPlan).not.toContain('TEMP B-TREE');
  });

  /**
   * WHY: an index that answers nothing still costs a b-tree write on every write that touches its
   * columns. `idx_studio_runs_status` was rewritten by the status UPDATE every single append made,
   * and since the status filter moved onto the projection nothing selects `studio_runs` by status at
   * all. The migration that drops it also has to survive being re-run: the postStep is the only
   * place these statements live, so an un-guarded one would fail a replayed migration table.
   */
  it('drops the index nothing queries, idempotently', () => {
    const indexes = (): string[] =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'studio_runs' AND name LIKE 'idx_%'").all() as { name: string }[])
        .map((r) => r.name)
        .sort();
    const expected = ['idx_studio_runs_created_at', 'idx_studio_runs_space_created_at'];
    expect(indexes()).toEqual(expected);

    // Replay the migration over a database it has already run on — the shape an upgrade actually has.
    db.prepare("DELETE FROM schema_migrations WHERE name = '018-studio-runs-list-index'").run();
    _resetMigrationGuard();
    applyMigrations(db, { vecLoaded: false });
    expect(indexes()).toEqual(expected);

    // And nothing in the store went looking for the dropped index on the way past.
    expect(listRuns(db, {}).runs).toEqual([]);
  });

  it('projects each list row exactly as getRun does, marks and unknown types included', () => {
    const run = createRun(db, { task: 'busy', driver: { kind: 'cli', client: { name: 'a-harness', version: '2.1.0' } } }, opts());
    const a = (type: string, payload?: Record<string, unknown>) =>
      appendEvent(db, run.id, { actor: { kind: 'agent', driver: 'cli' }, type, payload }, opts());
    a('tab.attached', { tabId: 'tab-1' });
    a('mark.placed', { mark: 1 });
    a('tab.attached', { tabId: 'tab-2' });
    a('tab.detached', { tabId: 'tab-1' });
    a('cost.recorded', { kind: 'browser_action', amount: 3 });
    a('cost.recorded', { kind: 'spend_usd', amount: 0.25 });
    a('presentation.promoted', { by: 'human', surface: 'tray' });
    a('decision.requested', { decisionId: 'd1', prompt: 'sign in?', anchor: { tabId: 'tab-2', mark: 4 } });
    a('decision.requested', { decisionId: 'd2', prompt: 'pay?' });
    a('decision.resolved', { decisionId: 'd1', outcome: 'approved' });
    a('run.paused', { reason: 'cost_cap' });
    // A type nobody projects, appended LAST: lastSeq and updatedAt move with it even though the
    // type-filtered read cannot see it.
    a('mark.placed', { mark: 9 });

    const listed = listRuns(db, {}).runs;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(getRun(db, run.id));
    expect(listed[0].lastSeq).toBe(13);
  });

  it('returns an empty page without touching the event log at all', () => {
    const seen = spyEventReads(db, () => listRuns(db, {}));
    expect(seen.queries).toBe(0);
  });

  it('names every type that can move a projected field', () => {
    // The list path reads ONLY these types. A `case` added to either fold without its type here
    // would be silently dropped from every list row while `getRun` still honoured it — a divergence
    // no behavioural test would catch, because the two paths would still each be self-consistent.
    const src = readFileSync(fileURLToPath(new URL('../../../src/studio/run-store.ts', import.meta.url)), 'utf8');
    const caseTypes = (body: string): string[] => [...body.matchAll(/case '([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)':/g)].map((m) => m[1]);
    const body = (name: string): string => {
      const start = src.indexOf(`function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      const end = src.indexOf('\n}\n', start);
      return src.slice(start, end);
    };

    expect(new Set(caseTypes(body('foldStatus')))).toEqual(new Set(store.STATUS_EVENT_TYPES));
    // A projected type is read as a ROW or folded in SQL — one list or the other, never neither and
    // never both: a type in both would be counted twice, once from the seed and once from the case.
    expect(new Set([...caseTypes(body('foldStatus')), ...caseTypes(body('projectRun'))]))
      .toEqual(new Set([...store.PROJECTION_EVENT_TYPES, ...store.AGGREGATED_EVENT_TYPES]));
    expect(store.PROJECTION_EVENT_TYPES.filter((t) => store.AGGREGATED_EVENT_TYPES.includes(t))).toEqual([]);
    // Control: the scan really does find cases, so an equal-sets result is evidence.
    expect(caseTypes(body('projectRun')).length).toBeGreaterThan(0);
    expect(store.AGGREGATED_EVENT_TYPES.length).toBeGreaterThan(0);
  });
});

describe('run-store — reading ONE run is bounded work too (SD1 exit review, perf #1)', () => {
  function busyRun(eventsEach: number, type = 'mark.placed', payload: (i: number) => Record<string, unknown> = (i) => ({ mark: i })): string {
    const r = createRun(db, { task: 'item' }, opts());
    for (let i = 0; i < eventsEach; i++) {
      appendEvent(db, r.id, { actor: { kind: 'agent' }, type, payload: payload(i) }, opts());
    }
    return r.id;
  }

  it('does the same work at any log depth — the item read tracks the projection, never the history', () => {
    const shallow = (() => {
      const id = busyRun(10);
      return spyEventReads(db, () => getRun(db, id));
    })();
    db = freshDb();
    const deep = (() => {
      const id = busyRun(400);
      return spyEventReads(db, () => getRun(db, id));
    })();

    // Forty times the log, identical work. `getRun` used to be the one path that still read and
    // parsed every row — the defect F2 took off the list route and left on the item route, measured
    // at 682 ms of blocked event loop per request at 400k events.
    expect(deep.queries).toBe(shallow.queries);
    expect(deep.rows).toBe(shallow.rows);
    // The projection read, the two bounded seeds and the newest-row tail seek. Nothing per event,
    // and nothing for cost.
    expect(deep.queries).toBe(4);
    // `run.created` from the projection read and the tail row — the other two answer with nothing,
    // because this run has no status row and no card. The 400 marks are what the old path read,
    // JSON-parsed and threw away, synchronously, before the router could yield.
    expect(deep.rows).toBe(2);
    // ...and the answer is the one a full replay gives.
    expect(deep.result!.lastSeq).toBe(401);
    expect(getRun(db, deep.result!.id)).toEqual(listRuns(db, {}).runs[0]);
  });

  it('reaches the projection through the type index rather than walking the run', () => {
    const id = busyRun(60);
    const seen = spyEventReads(db, () => getRun(db, id));

    // Row counts cannot see a scan that returns the right rows: an unfiltered read of a 61-event
    // log still projects correctly and still returns one `run.created`. The plan is what says the
    // other 60 rows were never touched.
    const projection = seen.reads.find((r) => /type IN/i.test(r.sql));
    expect(projection, seen.reads.map((r) => r.sql).join(' ;; ')).toBeDefined();
    expect(queryPlan(projection!), queryPlan(projection!)).toContain('idx_studio_run_events_type');
    expect(queryPlan(projection!), queryPlan(projection!)).not.toContain('sqlite_autoindex_studio_run_events');
    // No read on this path may be a bare per-run log read — that is the regression itself.
    const unbounded = seen.reads.filter((r) => !/type IN|type = |ORDER BY seq DESC/i.test(r.sql));
    expect(unbounded.map((r) => r.sql)).toEqual([]);
  });

  it('serves a run whose whole log is invisible to the type filter', () => {
    // Every projected field is a default and `lastSeq`/`updatedAt` come from the tail read, so the
    // bounded path must still be right when the filter matches nothing but the birth event.
    const id = busyRun(5, 'mark.placed');
    const run = getRun(db, id)!;
    expect(run.status).toBe('running');
    expect(run.tabIds).toEqual([]);
    expect(run.lastSeq).toBe(6);
    expect(run.updatedAt).toBe(eventsSince(db, id, 5)[0].ts);
  });
});

describe('run-store — cost is a counter kept as a column, not a fold at read time (SD1 exit-2, perf #2)', () => {
  function costlyRun(count: number): string {
    const r = createRun(db, { task: 'costly' }, opts());
    for (let i = 0; i < count; i++) {
      appendEvent(db, r.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } }, opts());
    }
    return r.id;
  }

  it('costs the same at 20 counter events as at 600 — the read is O(kinds), not O(actions)', () => {
    const shallow = (() => {
      const id = costlyRun(20);
      return { item: spyEventReads(db, () => getRun(db, id)), page: spyEventReads(db, () => listRuns(db, {})) };
    })();
    db = freshDb();
    const deep = (() => {
      const id = costlyRun(600);
      return { item: spyEventReads(db, () => getRun(db, id)), page: spyEventReads(db, () => listRuns(db, {})) };
    })();

    // `cost.recorded` is one event per browser action by design, so bounding the projection to a
    // type SET bounded nothing while this type was in it: 200k of them measured 244 ms to project
    // against 0.3 ms for 200k of any other type. A counter does not have to be folded at all.
    expect(deep.item.queries).toBe(shallow.item.queries);
    expect(deep.item.rows).toBe(shallow.item.rows);
    expect(deep.page.queries).toBe(shallow.page.queries);
    expect(deep.page.rows).toBe(shallow.page.rows);
    // `run.created` and the tail row — at either depth. The aggregate that used to ride along was
    // one row back but a per-page table lookup per counter event to produce it: `payload` is not in
    // the type index, so `json_extract` fetched every `cost.recorded` row. Measured 92 ms at 200k
    // rows for ONE run; a 50-run page multiplied it.
    expect(deep.item.rows).toBe(2);
    expect(deep.item.result!.cost.browserActions).toBe(600);
    expect(shallow.item.result!.cost.browserActions).toBe(20);
  });

  it('reads the counters off the run row, with no cost query on the list path at all', () => {
    costlyRun(50);
    const seen = spyEventReads(db, () => listRuns(db, {}));
    // Not "the aggregate is cheap now" — the aggregate is gone. A read that touches the counter rows
    // at page time is the regression, whatever plan it manages.
    expect(seen.reads.filter((r) => /SUM\(|cost\.recorded/i.test(r.sql))).toEqual([]);
    // ...because the page already selected them: the columns come out of `studio_runs` with the row.
    const row = db.prepare('SELECT cost_browser_actions FROM studio_runs').get() as { cost_browser_actions: number };
    expect(row.cost_browser_actions).toBe(50);
  });

  it('maintains the columns in the appending transaction, never after it', () => {
    const run = createRun(db, { task: 'atomic' }, opts());
    const columns = () => db.prepare('SELECT cost_browser_actions AS a, last_seq AS s FROM studio_runs WHERE id = ?').get(run.id) as { a: number; s: number };
    expect(columns()).toEqual({ a: 0, s: 1 });
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } }, opts());
    // One event, one seq, one increment — the counter and the cache column it rides with move
    // together or not at all, which is what keeps a crash from leaving a total nothing can rebuild.
    expect(columns()).toEqual({ a: 1, s: 2 });

    // A failed append moves neither. The event insert is what fails here, so the whole transaction
    // unwinds — including the increment that would otherwise count an action that never happened.
    const failing = failEventInsert(db);
    expect(() => appendEvent(failing, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } }, opts())).toThrow();
    expect(columns()).toEqual({ a: 1, s: 2 });
  });

  it('folds exactly what a full replay folds, including payloads a fold must refuse', () => {
    const run = createRun(db, { task: 'parity' }, opts());
    const cost = (payload: Record<string, unknown>) =>
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload }, opts());
    cost({ kind: 'browser_action', amount: 2 });
    cost({ kind: 'browser_action', amount: '3' });   // a string is not an amount
    cost({ kind: 'browser_action', amount: true });  // nor is a boolean — SQLite would read it as 1
    cost({ kind: 'tokens_in', amount: 10 });
    cost({ kind: 'tokens_out' });                    // no amount at all
    cost({ kind: 'spend_usd', amount: 0.25 });
    cost({ kind: 'spend_usd', amount: -1 });         // a refund is a legal counter
    cost({ kind: 'wat', amount: 99 });               // an unknown kind lands in no bucket
    cost({ amount: 5 });                             // ...and neither does no kind

    const replayed = projectRun({ id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt }, eventsSince(db, run.id, 0));
    // The columns and the replay fold are two implementations of one rule, so the pin is that they
    // agree — and that they agree on something, which the explicit totals below are here to say.
    expect(getRun(db, run.id)!.cost).toEqual(replayed.cost);
    expect(replayed.cost).toEqual({ browserActions: 2, tokensIn: 10, tokensOut: 0, spendUsd: -0.75 });
    // Read straight off the row, not through the projection that could be hiding a second fold.
    expect(db.prepare('SELECT cost_browser_actions AS b, cost_tokens_in AS i, cost_tokens_out AS o, cost_spend_usd AS s FROM studio_runs WHERE id = ?').get(run.id))
      .toEqual({ b: 2, i: 10, o: 0, s: -0.75 });
  });

  it('keeps every run\'s counters to itself across a page', () => {
    const a = createRun(db, { task: 'a' }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, 1)) });
    const b = createRun(db, { task: 'b' }, { ...opts(), now: () => new Date(Date.UTC(2026, 7, 22, 0, 0, 2)) });
    appendEvent(db, a.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 4 } }, opts());
    appendEvent(db, b.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'spend_usd', amount: 1.5 } }, opts());

    const byId = new Map(listRuns(db, {}).runs.map((r) => [r.id, r]));
    expect(byId.get(a.id)!.cost).toEqual({ browserActions: 4, tokensIn: 0, tokensOut: 0, spendUsd: 0 });
    expect(byId.get(b.id)!.cost).toEqual({ browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 1.5 });
    expect(byId.get(a.id)).toEqual(getRun(db, a.id));
    expect(byId.get(b.id)).toEqual(getRun(db, b.id));
  });
});

describe('run-store — an append does not compile sql inside the write lock (SD1 exit-7, perf HIGH-1)', () => {
  /**
   * Deliberately does NOT drop the statement cache: what a real writer pays is the count with the
   * connection in the state the previous append left it in.
   */
  function countPrepares(database: Database.Database, fn: () => void): number {
    let n = 0;
    const realPrepare = database.prepare.bind(database);
    const spy = ((sql: string) => { n++; return realPrepare(sql); }) as typeof database.prepare;
    Object.defineProperty(database, 'prepare', { value: spy, configurable: true });
    try {
      fn();
    } finally {
      Object.defineProperty(database, 'prepare', { value: realPrepare, configurable: true });
    }
    return n;
  }

  /** Every sql shape the append path has: the plain envelope plus one per cost column. */
  function appendPass(runId: string, n: number): void {
    for (let i = 0; i < n; i++) {
      appendEvent(db, runId, { actor: { kind: 'agent', driver: 'cli' }, type: 'tab.attached', payload: { tabId: `t${i}` } }, opts());
      for (const kind of ['browser_action', 'tokens_in', 'tokens_out', 'spend_usd']) {
        appendEvent(db, runId, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind, amount: 1 } }, opts());
      }
    }
  }

  it('compiles each of its statements once per connection, not once per append', () => {
    const run = createRun(db, { task: 'warm' }, opts());

    const first = countPrepares(db, () => appendPass(run.id, 20));
    const second = countPrepares(db, () => appendPass(run.id, 20));

    // The compiler used to run five times per append INSIDE `BEGIN IMMEDIATE` — the write lock on a
    // database that search caching, embeddings and artifacts also queue behind. Measured over 20k
    // appends that was 59.6 µs/append against 7.9 µs reusing the statements: ~87% of the time the
    // lock was held was spent compiling constants. `cost.recorded` is one event per browser action
    // by design, so a long run pays it continuously — which is why the number that matters is the
    // WARM one, and it is zero.
    expect(second).toBe(0);
    // The first pass may compile each distinct text once and no more: the envelope read, the event
    // INSERT, the status heads, the pending-decision read and the five UPDATE arms.
    expect(first).toBeLessThanOrEqual(9);
  });

  it('never hands one connection a statement compiled on another', () => {
    const other = freshDb();
    try {
      const mine = createRun(db, { task: 'handle a' }, opts());
      appendPass(mine.id, 2);

      // Same schema, same sql, different connection — and a `Statement` belongs to the connection
      // that compiled it, so the broker child, the daemon and every test database must each get
      // their own. A shared one would write into the wrong file or throw at step time.
      const compiled = countPrepares(other, () => {
        const theirs = createRun(other, { task: 'handle b' }, { dataDir: dir });
        appendEvent(other, theirs.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'x' } }, { dataDir: dir });
        expect(getRun(other, theirs.id)!.lastSeq).toBe(2);
      });
      expect(compiled).toBeGreaterThan(0);

      expect(db.prepare('SELECT COUNT(*) AS n FROM studio_runs').get()).toEqual({ n: 1 });
      expect(other.prepare('SELECT COUNT(*) AS n FROM studio_runs').get()).toEqual({ n: 1 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM studio_run_events').get()).toEqual({ n: 11 });
      expect(other.prepare('SELECT COUNT(*) AS n FROM studio_run_events').get()).toEqual({ n: 2 });
    } finally {
      other.close();
    }
  });

  it('keeps every counter and every projection identical once the statements are reused', () => {
    const run = createRun(db, { task: 'unchanged' }, opts());
    appendPass(run.id, 3);
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.paused', payload: { reason: 'cap' } }, opts());

    const projected = getRun(db, run.id)!;
    expect(projected.status).toBe('paused');
    expect(projected.lastSeq).toBe(17);
    expect(projected.cost).toEqual({ browserActions: 3, tokensIn: 3, tokensOut: 3, spendUsd: 3 });
    expect(db.prepare('SELECT status, last_seq AS s FROM studio_runs WHERE id = ?').get(run.id)).toEqual({ status: 'paused', s: 17 });
    expect(eventsSince(db, run.id).map((e) => e.seq)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    // A well-formed id nobody minted still fails the same way, from the same cached envelope read.
    expect(() => appendEvent(db, mintRunId(), { actor: { kind: 'daemon' }, type: 'tab.attached', payload: {} }, opts()))
      .toThrow(/run not found/);
  });
});

describe('run-store — a projected field is validated, never cast (SD1 exit review, security LOW-3/LOW-4)', () => {
  it('serves an anchor only when it IS one, and only its two fields', () => {
    const run = createRun(db, { task: 'anchors' }, opts());
    const ask = (decisionId: string, anchor: unknown) =>
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId, prompt: 'ok?', anchor } }, opts());

    ask('d1', { tabId: 'tab-1', mark: 4, note: 'ride-along', prompt: 'not this one' });
    ask('d2', { tabId: 'tab-2', mark: '4' });
    ask('d3', 'tab-3');
    ask('d4', { mark: 2 });
    ask('d5', [{ tabId: 'tab-5' }]);
    ask('d6', { tabId: 'tab-6', mark: 1.5 });

    const anchors = new Map(getRun(db, run.id)!.pendingDecisions.map((d) => [d.decisionId, d.anchor]));
    // Law 8's address is a tab and a mark. Anything else in the payload is payload, and a REST
    // consumer typed `{ tabId; mark? }` must not be handed the rest of it.
    expect(anchors.get('d1')).toEqual({ tabId: 'tab-1', mark: 4 });
    // A junk mark costs the mark, not the anchor — the card still points at a tab a human can answer.
    expect(anchors.get('d2')).toEqual({ tabId: 'tab-2' });
    expect(anchors.get('d6')).toEqual({ tabId: 'tab-6' });
    // No tab, no address.
    expect(anchors.get('d3')).toBeUndefined();
    expect(anchors.get('d4')).toBeUndefined();
    expect(anchors.get('d5')).toBeUndefined();
    // The log still has every byte of it — the store validates what it SERVES, never what it stores.
    const stored = eventsSince(db, run.id, 0).find((e) => e.payload.decisionId === 'd1')!;
    expect(stored.payload.anchor).toEqual({ tabId: 'tab-1', mark: 4, note: 'ride-along', prompt: 'not this one' });
  });

  it('rebuilds the actor so an unknown key cannot ride into an append-only log', async () => {
    const run = createRun(db, { task: 'actors' }, opts());
    const supplied = {
      kind: 'agent',
      driver: 'cli',
      client: { name: 'a-harness', version: '2.1.0', apiKey: 'sk-should-not-persist' },
      impersonating: 'human',
    } as unknown as Parameters<typeof appendEvent>[2]['actor'];

    const returned = appendEvent(db, run.id, { actor: supplied, type: 'mark.placed', payload: { mark: 1 } }, opts());
    const clean = { kind: 'agent', driver: 'cli', client: { name: 'a-harness', version: '2.1.0' } };

    // Returned, stored, replayed and projected to disk — the envelope is one object with one shape,
    // and it is the store's, not the caller's.
    expect(returned.actor).toEqual(clean);
    expect(returned.actor).not.toBe(supplied);
    expect(eventsSince(db, run.id, 1)[0].actor).toEqual(clean);
    await flushRunEventProjections();
    const line = readFileSync(runEventsFile(run.id, dir), 'utf8');
    // A file that had not been written yet would pass both `not.toContain`s for the wrong reason.
    expect(line).toContain('a-harness');
    expect(line).not.toContain('sk-should-not-persist');
    expect(line).not.toContain('impersonating');
  });

  it('rebuilds the driver badge on the way out of the log as well as into it', () => {
    const run = createRun(db, { task: 'driver' }, opts());
    // A payload written by an older build, or by any writer the store does not own: the projection
    // is the last place that can stop it becoming a typed REST field.
    db.prepare('UPDATE studio_run_events SET payload = ? WHERE run_id = ? AND seq = 1')
      .run(JSON.stringify({ task: run.task, spaceId: run.spaceId, driver: { kind: 'cli', client: { name: 'h', version: '1', token: 'nope' } } }), run.id);

    expect(getRun(db, run.id)!.driver).toEqual({ kind: 'cli', client: { name: 'h', version: '1' } });
  });
});

describe('run-store — a projection costs its answer, not its history (SD1 exit-5, perf #4)', () => {
  /**
   * WHY: the type filter bounded the projection read to a SET of types, not to a number of ROWS,
   * and three of them are writer-driven with no cap — the decision pair, the pause pair and
   * `presentation.*`. The file said as much at the decision pair and then claimed the filter bounded
   * the read anyway. Measured on the tip at 50 runs x 5001 events, as blocked daemon event loop per
   * `GET /v1/runs`: 3004 ms of decision pairs, 458 ms of pause pairs, 382 ms of `presentation.*`,
   * against 0.4 ms for a class the filter excludes. The work is synchronous, so the router's
   * per-route deadline cannot fire during it — every SSE tail, every heartbeat and the MCP server
   * wait behind it. In the decision case the pending set came out EMPTY: 250k rows parsed, discarded.
   */
  function accumulated(n: number, pair: (i: number) => Array<[string, Record<string, unknown>?]>): string {
    // Back-dated, because that is what "accumulated" means for the decision pair: raised and
    // answered long enough ago that no clock could still be counting down on one.
    const r = createRun(db, { task: 'accumulating' }, opts());
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.UTC(2026, 7, 22, 1, 0, 0) + i * 1000);
      for (const [type, payload] of pair(i)) {
        appendEvent(db, r.id, { actor: { kind: 'human' }, type, payload }, { ...opts(), now: () => at });
      }
    }
    return r.id;
  }

  const CLASSES: Array<[string, (i: number) => Array<[string, Record<string, unknown>?]>]> = [
    ['decision pair', (i) => [['decision.requested', { decisionId: `d${i}`, prompt: 'ok?' }], ['decision.resolved', { decisionId: `d${i}`, outcome: 'approved' }]]],
    ['pause pair', () => [['run.paused', { reason: 'agent' }], ['run.resumed', { by: 'human' }]]],
    ['presentation pair', () => [['presentation.promoted', { by: 'human' }], ['presentation.demoted', { by: 'human' }]]],
  ];

  for (const [name, pair] of CLASSES) {
    it(`reads the same rows at 400 accumulated ${name}s as at 4`, () => {
      const shallow = (() => {
        const id = accumulated(4, pair);
        return { item: spyEventReads(db, () => getRun(db, id)), page: spyEventReads(db, () => listRuns(db, {})) };
      })();
      db = freshDb();
      const deep = (() => {
        const id = accumulated(400, pair);
        return { item: spyEventReads(db, () => getRun(db, id)), page: spyEventReads(db, () => listRuns(db, {})) };
      })();

      // A hundred times the history, identical work — on both the item route and the page route. A
      // fixed expectation could be met by a path that happened to hit the number once; the
      // differential is what says "not O(events accumulated)".
      expect(deep.item.queries).toBe(shallow.item.queries);
      expect(deep.item.rows).toBe(shallow.item.rows);
      expect(deep.page.queries).toBe(shallow.page.queries);
      expect(deep.page.rows).toBe(shallow.page.rows);
      // `run.created` and the tail row, and — for the pause and presentation classes — the ONE
      // newest row of each type that the seeks stop at. Never the 800 rows the run accumulated.
      expect(deep.item.rows).toBeLessThanOrEqual(4);
      expect(deep.item.result).toEqual(deep.page.result.runs[0]);
    });
  }

  it('reaches every seed read through an index rather than walking the run', () => {
    const id = accumulated(60, CLASSES[0][1]);
    appendEvent(db, id, { actor: { kind: 'agent' }, type: 'run.paused', payload: { reason: 'agent' } }, opts());
    appendEvent(db, id, { actor: { kind: 'agent' }, type: 'presentation.promoted', payload: { by: 'human' } }, opts());
    const seen = spyEventReads(db, () => getRun(db, id));

    // Row counts cannot see a scan that returns the right rows — see the append-path test.
    const heads = seen.reads.find((r) => /UNION ALL/i.test(r.sql));
    const pending = seen.reads.find((r) => /NOT EXISTS/i.test(r.sql));
    expect(heads, seen.reads.map((r) => r.sql).join(' ;; ')).toBeDefined();
    expect(pending, seen.reads.map((r) => r.sql).join(' ;; ')).toBeDefined();

    // Seven arms now — the five status heads plus the presentation pair — and every one of them
    // stops at the first entry of its own (run_id, type, seq) slice. A sort here would mean SQLite
    // walked the slice to find its newest row, which is the regression.
    expect(queryPlan(heads!), queryPlan(heads!)).toContain('idx_studio_run_events_type_seq');
    expect(queryPlan(heads!), queryPlan(heads!)).not.toContain('SCAN studio_run_events');
    expect(queryPlan(heads!), queryPlan(heads!)).not.toContain('TEMP B-TREE');
    // The two bounds on the pending read, each visible as an index term — the same statement the
    // append path uses, so the projection inherits its `ts` window rather than growing one of its own.
    expect(queryPlan(pending!), queryPlan(pending!)).toContain('idx_studio_run_events_type_ts (run_id=? AND type=? AND ts>?)');
    expect(queryPlan(pending!), queryPlan(pending!)).toContain('idx_studio_run_events_type_seq (run_id=? AND type=? AND seq>?)');
    expect(queryPlan(pending!), queryPlan(pending!)).not.toContain('SCAN studio_run_events');
    expect(queryPlan(pending!), queryPlan(pending!)).not.toContain('TEMP B-TREE');
    // No read on this path may be a bare per-run log read — that is the regression itself.
    const unbounded = seen.reads.filter((r) => !/type IN|type = |type =\n|ORDER BY seq DESC/i.test(r.sql));
    expect(unbounded.map((r) => r.sql)).toEqual([]);
  });

  /**
   * The base-vs-tip differential. `projectRun` over the FULL log is the implementation the seeded
   * path replaced, unchanged and still exercised by the replay and the app's view model — so
   * pinning the two equal over generated logs is the old path and the new one run side by side.
   *
   * Generated rather than hand-picked, because the revealing shapes are the ones nobody thought of:
   * a re-requested decision id, an expiry that lands between two events, a promote with no demote.
   */
  it('projects exactly what a full-log replay projects, over generated logs of every seeded class', () => {
    const NOW = new Date(Date.UTC(2026, 7, 22, 12, 0, 0));
    let seed = 93;
    const next = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

    for (let trial = 0; trial < 40; trial++) {
      db = freshDb();
      const run = createRun(db, { task: `trial ${trial}` }, opts());
      let live = 0;
      for (let i = 0; i < 60; i++) {
        // Spread over the auto-deny window and well past it, so some cards expire and some do not.
        const at = new Date(NOW.getTime() - 300_000 + i * 5_000);
        const o = { ...opts(), now: () => at };
        const a = (type: string, payload?: Record<string, unknown>): void => {
          appendEvent(db, run.id, { actor: { kind: 'human' }, type, payload }, o);
        };
        switch (next(9)) {
          case 0: a('decision.requested', { decisionId: `d${next(5)}`, kind: 'approval', prompt: 'ok?', anchor: { tabId: `t${next(3)}`, mark: next(9) } }); live++; break;
          case 1: a('decision.resolved', { decisionId: `d${next(5)}`, outcome: 'approved' }); break;
          // A re-request of an id that may still be live: newest wins, at the first card's position.
          case 2: a('decision.requested', { decisionId: `d${next(2)}`, prompt: 're-asked' }); live++; break;
          case 3: a('tab.attached', { tabId: `t${next(4)}` }); break;
          case 4: a('tab.detached', { tabId: `t${next(4)}` }); break;
          case 5: a('presentation.promoted', { by: 'human' }); break;
          case 6: a('presentation.demoted', { by: 'human' }); break;
          case 7: a('run.paused', { reason: next(2) ? 'agent' : 'cost_cap' }); break;
          default: a('run.resumed', { by: 'human' }); break;
        }
      }
      const replayed = projectRun(
        { id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt },
        eventsSince(db, run.id, 0),
        NOW,
      );
      const item = getRun(db, run.id, { now: () => NOW })!;
      expect(item, `trial ${trial}`).toEqual(replayed);
      expect(listRuns(db, { now: () => NOW }).runs[0], `trial ${trial}`).toEqual(replayed);
      // Control: the generator actually raised cards, so an equal-projections result is evidence.
      expect(live).toBeGreaterThan(0);
    }
  });

  it('keeps a re-requested decision newest-wins, at the position the first request took', () => {
    const run = createRun(db, { task: 'reasked' }, opts());
    const a = (type: string, payload: Record<string, unknown>) =>
      appendEvent(db, run.id, { actor: { kind: 'human' }, type, payload }, opts());
    a('decision.requested', { decisionId: 'd1', prompt: 'first ask' });
    a('decision.requested', { decisionId: 'd2', prompt: 'other' });
    a('decision.requested', { decisionId: 'd1', prompt: 'asked again' });

    const cards = getRun(db, run.id)!.pendingDecisions;
    // The bounded read returns both `d1` rows — nothing resolved either — so the seed has to replay
    // them in `seq` order through the same map the fold uses, or the older prompt wins.
    expect(cards.map((d) => d.decisionId)).toEqual(['d1', 'd2']);
    expect(cards[0].prompt).toBe('asked again');
  });

  it('lists an unanswered card on a run that has already finished, and drops it when it expires', () => {
    const raised = new Date(Date.UTC(2026, 7, 22, 12, 0, 0));
    const run = createRun(db, { task: 'terminal' }, { ...opts(), now: () => raised });
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'ok?' } }, { ...opts(), now: () => raised });
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'run.completed' }, { ...opts(), now: () => raised });

    // A terminal event outranks a card for STATUS (§1) — it does not delete the card. The seed reads
    // the cards whatever the status says, which is the one place the status seek is allowed to skip
    // the question and a projection is not.
    const during = getRun(db, run.id, { now: () => new Date(raised.getTime() + 60_000) })!;
    expect(during.status).toBe('done');
    expect(during.pendingDecisions.map((d) => d.decisionId)).toEqual(['d1']);
    // Past the deadline the card is gone — the `ts` window in SQL cannot reach it, and `hasAutoDenied`
    // would drop it anyway. Both, because the window is a superset and never the rule.
    const after = getRun(db, run.id, { now: () => new Date(raised.getTime() + AUTO_DENY_MS + 1) })!;
    expect(after.pendingDecisions).toEqual([]);
  });
});

describe('run-store — the tab fold is a set question, not a walk (SD1 exit-5, perf #3)', () => {
  /**
   * WHY: `tabIds.includes` is O(held) per `tab.attached`, so a run holding many tabs at once paid
   * O(held squared) to project — measured 112 ms of blocked event loop at 16k attach-only events.
   * A Set answers membership in constant time; the array stays because law 4's order is the answer.
   *
   * A counter cannot see the difference and a wall-clock constant is a flake, so what is pinned here
   * is that the cheaper structure folds IDENTICALLY — every shape the O(n squared) walk could reach.
   */
  const fold = (events: Array<[string, Record<string, unknown>?]>): string[] => {
    const run = createRun(db, { task: 'tabs' }, opts());
    for (const [type, payload] of events) appendEvent(db, run.id, { actor: { kind: 'agent' }, type, payload }, opts());
    const listed = listRuns(db, {}).runs.find((r) => r.id === run.id)!;
    const item = getRun(db, run.id)!;
    const replayed = projectRun({ id: run.id, task: run.task, spaceId: run.spaceId, createdAt: run.createdAt }, eventsSince(db, run.id, 0));
    // One answer or a bug: the seeded page row, the seeded item read and the full-log replay.
    expect(listed.tabIds).toEqual(replayed.tabIds);
    expect(item.tabIds).toEqual(replayed.tabIds);
    return replayed.tabIds;
  };
  const att = (tabId: unknown): [string, Record<string, unknown>] => ['tab.attached', { tabId }];
  const det = (tabId: unknown): [string, Record<string, unknown>] => ['tab.detached', { tabId }];

  it('keeps attach order, and a second attach of a held tab does not move it', () => {
    expect(fold([att('a'), att('b'), att('a'), att('c')])).toEqual(['a', 'b', 'c']);
  });

  it('drops a detached tab and re-appends it at the end when it comes back', () => {
    expect(fold([att('a'), att('b'), det('a'), att('a')])).toEqual(['b', 'a']);
    expect(fold([att('a'), att('b'), att('c'), det('b')])).toEqual(['a', 'c']);
  });

  it('detaching a tab the run never held changes nothing', () => {
    expect(fold([att('a'), det('zz'), det('a'), det('a'), att('a')])).toEqual(['a']);
  });

  it('refuses a tab id that is not one, on both halves of the pair', () => {
    // `str` is the rule: a non-string, an empty string and a missing key are all "no tab", and a
    // detach carrying one must not remove the tab that happens to sit at index 0.
    expect(fold([att('a'), att(''), att(7), att(null), ['tab.attached']])).toEqual(['a']);
    expect(fold([att('a'), det(''), det(7), det(null), ['tab.detached']])).toEqual(['a']);
  });

  it('folds a long generated attach/detach log exactly as a linear replay does', () => {
    // The differential the structure change is really about: 600 events of mixed attach, re-attach,
    // detach and detach-of-unheld, folded against an independent reference implementation.
    const script: Array<[string, Record<string, unknown>?]> = [];
    const expected: string[] = [];
    let seed = 20260823;
    const next = (n: number): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 600; i++) {
      const tabId = `t${next(24)}`;
      if (next(3) === 0) {
        script.push(det(tabId));
        const at = expected.indexOf(tabId);
        if (at >= 0) expected.splice(at, 1);
      } else {
        script.push(att(tabId));
        if (!expected.includes(tabId)) expected.push(tabId);
      }
    }
    expect(expected.length).toBeGreaterThan(1); // control: the script actually holds tabs
    expect(fold(script)).toEqual(expected);
  });
});

// --- helpers -------------------------------------------------------------

import * as store from '../../../src/studio/run-store.js';

function cachedStatus(runId: string): string {
  return (db.prepare('SELECT status FROM studio_runs WHERE id = ?').get(runId) as { status: string }).status;
}

interface EventRead { sql: string; params: unknown[]; rows: number }

/**
 * Every EXECUTION against the event log — not every prepare. A statement prepared once and stepped
 * per run is still a read per run, and counting prepares would hide exactly that.
 *
 * The store caches its prepared statements per handle, so the wrapping only reaches a statement it
 * compiles itself: the cache is dropped on the way in so every read inside `fn` goes through the
 * spy, and again on the way out so no wrapped statement outlives the array it reports into.
 */
function spyEventReads<T>(
  database: Database.Database,
  fn: () => T,
  // The run TABLE is the other half of the list's cost, and it is read by a statement built fresh
  // per filter shape — so its plan has to be caught in flight, exactly as the log's reads are.
  table: RegExp = /\bFROM studio_run_events\b/i,
): { queries: number; rows: number; reads: EventRead[]; result: T } {
  const reads: EventRead[] = [];
  const realPrepare = database.prepare.bind(database);
  const spy = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (!table.test(sql)) return stmt;
    const wrap = (name: 'all' | 'get', count: (out: unknown) => number): void => {
      const real = stmt[name].bind(stmt) as (...args: unknown[]) => unknown;
      Object.defineProperty(stmt, name, {
        value: (...args: unknown[]) => {
          const out = real(...args);
          reads.push({ sql, params: args, rows: count(out) });
          return out;
        },
        configurable: true,
      });
    };
    wrap('all', (out) => (out as unknown[]).length);
    wrap('get', (out) => (out === undefined ? 0 : 1));
    return stmt;
  }) as typeof database.prepare;
  _resetPreparedStatements(database);
  Object.defineProperty(database, 'prepare', { value: spy, configurable: true });
  try {
    const result = fn();
    return { queries: reads.length, rows: reads.reduce((n, r) => n + r.rows, 0), reads, result };
  } finally {
    Object.defineProperty(database, 'prepare', { value: realPrepare, configurable: true });
    _resetPreparedStatements(database);
  }
}

/**
 * The tail seek, and nothing else. `ORDER BY seq DESC` alone no longer names it: the status seeds'
 * head read is a UNION of per-type subselects that each carry the same clause, and it now runs
 * FIRST — so the loose pattern silently picked the wrong statement to make claims about.
 */
const TAIL_READ = /SELECT seq, ts FROM studio_run_events WHERE run_id = \? ORDER BY seq DESC/i;

/** What SQLite actually does with a read, as one string. */
function queryPlan(read: EventRead): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).all(...read.params) as { detail: string }[];
  return rows.map((r) => r.detail).join(' | ');
}

function scanSrc(pattern: RegExp): string[] {
  const root = fileURLToPath(new URL('../../../src/', import.meta.url));
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(ts|sql)$/.test(entry.name) && pattern.test(readFileSync(p, 'utf8'))) hits.push(p);
    }
  };
  walk(root);
  return hits;
}
