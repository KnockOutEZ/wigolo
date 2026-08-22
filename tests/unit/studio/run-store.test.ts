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
    expect(() => appendEvent(db, 'nope', { actor: { kind: 'agent' }, type: 'x.y' }, opts())).toThrow(/not found/i);
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
    expect(seen.queries).toBe(1);
    // ...and the answer is still the right one.
    expect(cachedStatus(run.id)).toBe('needs_you');
    expect(getRun(db, run.id)!.status).toBe('needs_you');
  });

  it('keeps the cached column equal to a full replay through every status transition', () => {
    const run = createRun(db, { task: 'transitions' }, opts());
    const step = (type: string, payload?: Record<string, unknown>) => {
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type, payload }, opts());
      appendEvent(db, run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } }, opts());
      // The cache is what a status-filtered `listRuns` selects on; a replay is the truth. A
      // type-filtered recompute is only correct while these two cannot disagree.
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

  it('reads a fixed number of queries and projection-relevant rows, not the whole log per row', () => {
    const ids = busyRuns(6, 60);

    const seen = spyEventReads(db, () => listRuns(db, {}));

    // Two queries for the whole page — the projection read and the tail read — never one per row.
    expect(seen.queries).toBe(2);
    // Per run: `run.created`, plus its newest row for lastSeq/updatedAt. The 60 marks each are the
    // part that used to be read, parsed and thrown away; `better-sqlite3` is synchronous, so that
    // was event-loop time the router's deadline could not fire during.
    expect(seen.rows).toBe(ids.length * 2);
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
    expect(new Set([...caseTypes(body('foldStatus')), ...caseTypes(body('projectRun'))])).toEqual(new Set(store.PROJECTION_EVENT_TYPES));
    // Control: the scan really does find cases, so an equal-sets result is evidence.
    expect(caseTypes(body('projectRun')).length).toBeGreaterThan(0);
  });
});

// --- helpers -------------------------------------------------------------

import * as store from '../../../src/studio/run-store.js';

function cachedStatus(runId: string): string {
  return (db.prepare('SELECT status FROM studio_runs WHERE id = ?').get(runId) as { status: string }).status;
}

/** Counts the queries against the event log, and the rows they actually hand back. */
function spyEventReads<T>(database: Database.Database, fn: () => T): { queries: number; rows: number; result: T } {
  let queries = 0;
  let rows = 0;
  const realPrepare = database.prepare.bind(database);
  const spy = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (!/\bFROM studio_run_events\b/i.test(sql)) return stmt;
    queries++;
    const realAll = stmt.all.bind(stmt);
    Object.defineProperty(stmt, 'all', {
      value: (...args: unknown[]) => {
        const out = realAll(...args) as unknown[];
        rows += out.length;
        return out;
      },
      configurable: true,
    });
    return stmt;
  }) as typeof database.prepare;
  Object.defineProperty(database, 'prepare', { value: spy, configurable: true });
  try {
    const result = fn();
    return { queries, rows, result };
  } finally {
    Object.defineProperty(database, 'prepare', { value: realPrepare, configurable: true });
  }
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
