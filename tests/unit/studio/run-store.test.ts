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
  isValidListCursor,
  MAX_EVENT_PAYLOAD_CHARS,
  runDir,
  runEventsFile,
  type RunEvent,
  type Run,
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

  it('caps the page size so one call cannot ask for the whole store', () => {
    for (let i = 0; i < 3; i++) createRun(db, { task: `t${i}` }, opts());
    expect(listRuns(db, { limit: 10_000 }).runs.length).toBeLessThanOrEqual(200);
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

  it('refuses an event payload past the cap — the log is persisted twice', () => {
    const run = createRun(db, { task: 'bounded' }, opts());
    const oversize = { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_CHARS) };
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'note.added', payload: oversize }, opts()))
      .toThrow(/payload/i);
    // Refused at the door: no row, no seq burned, no line appended to the on-disk projection.
    expect(eventsSince(db, run.id).map((e) => e.type)).toEqual(['run.created']);
    expect(getRun(db, run.id)!.lastSeq).toBe(1);
    expect(readFileSync(runEventsFile(run.id, dir), 'utf8').trimEnd().split('\n')).toHaveLength(1);

    // Just under still appends — the cap has to be a bound, not a ban on real payloads.
    const fits = { blob: 'x'.repeat(MAX_EVENT_PAYLOAD_CHARS - 100) };
    expect(() => appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'note.added', payload: fits }, opts())).not.toThrow();
  });
});

describe('run-store — files on disk (law 11, A-43-3)', () => {
  it('writes one envelope per line under the run directory', () => {
    const run = createRun(db, { task: 'inspectable' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-1' } }, opts());
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

  it('keeps the event file itself owner-only, not merely owner-only by its parent', () => {
    if (process.platform === 'win32') return;
    const run = createRun(db, { task: 't' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', prompt: 'card number?' } }, opts());
    // The line above is why: prompts, task text and attached URLs that can carry a query-string
    // token all live in this file, and the 0700 directory stops shielding it the moment the tree is
    // copied, archived or synced.
    expect(statSync(runEventsFile(run.id, dir)).mode & 0o777).toBe(0o600);
  });

  it('is a projection — a lost or damaged file never changes what the store reads back', () => {
    const run = createRun(db, { task: 't' }, opts());
    appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 2 } }, opts());
    const before = getRun(db, run.id);
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
    Object.defineProperty(db, 'prepare', { value: spy, configurable: true });
    try {
      runExists(db, run.id);
      expect(readRows).toBe(0);
      getRun(db, run.id);
      expect(readRows).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(db, 'prepare', { value: realPrepare, configurable: true });
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
    // One projection read for the whole page, plus one newest-row seek per run for lastSeq — never
    // the unbounded full-log read per row this replaced, and no longer a cost aggregate either: the
    // counters are columns on the row the page already selected.
    expect(deep.seen.queries).toBe(1 + deep.ids.length);
    // Per run: `run.created` from the projection read, and the tail row. The 200 marks each are
    // what used to be read, parsed and thrown away, synchronously, before the router could yield.
    expect(deep.seen.rows).toBe(deep.ids.length * 2);
  });

  it('reaches both of those reads through an index rather than walking a log', () => {
    busyRuns(4, 40);
    const seen = spyEventReads(db, () => listRuns(db, {}));

    // Row counts cannot see a scan that returns the right rows — see the append-path test.
    const projection = seen.reads.find((r) => /type IN/i.test(r.sql));
    const tail = seen.reads.find((r) => /ORDER BY seq DESC/i.test(r.sql));
    expect(projection).toBeDefined();
    expect(tail).toBeDefined();
    expect(queryPlan(projection!), queryPlan(projection!)).toContain('idx_studio_run_events_type');
    // The tail is the one place ORDER BY earns its keep: reversed on the primary key it stops at
    // the first row. Every page-wide alternative — a correlated max, a GROUP BY, a row-value IN —
    // measured 250x worse at depth because each walks the run.
    expect(queryPlan(tail!), queryPlan(tail!)).toContain('SEARCH');
    expect(queryPlan(tail!), queryPlan(tail!)).not.toContain('TEMP B-TREE');
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
    // The projection read and the newest-row tail seek. Nothing per event, and nothing for cost.
    expect(deep.queries).toBe(2);
    // `run.created` from the projection read and the tail row. The 400 marks are what the old path
    // read, JSON-parsed and threw away, synchronously, before the router could yield.
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

  it('rebuilds the actor so an unknown key cannot ride into an append-only log', () => {
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
    const line = readFileSync(runEventsFile(run.id, dir), 'utf8');
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

// --- helpers -------------------------------------------------------------

import * as store from '../../../src/studio/run-store.js';

function cachedStatus(runId: string): string {
  return (db.prepare('SELECT status FROM studio_runs WHERE id = ?').get(runId) as { status: string }).status;
}

interface EventRead { sql: string; params: unknown[]; rows: number }

/**
 * Every EXECUTION against the event log — not every prepare. A statement prepared once and stepped
 * per run is still a read per run, and counting prepares would hide exactly that.
 */
function spyEventReads<T>(database: Database.Database, fn: () => T): { queries: number; rows: number; reads: EventRead[]; result: T } {
  const reads: EventRead[] = [];
  const realPrepare = database.prepare.bind(database);
  const spy = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (!/\bFROM studio_run_events\b/i.test(sql)) return stmt;
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
  Object.defineProperty(database, 'prepare', { value: spy, configurable: true });
  try {
    const result = fn();
    return { queries: reads.length, rows: reads.reduce((n, r) => n + r.rows, 0), reads, result };
  } finally {
    Object.defineProperty(database, 'prepare', { value: realPrepare, configurable: true });
  }
}

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
