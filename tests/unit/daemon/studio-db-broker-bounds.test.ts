import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SearchEngine } from '../../../src/types.js';
import type { SmartRouter } from '../../../src/fetch/router.js';
import { resetConfig } from '../../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../../src/cache/db.js';
import { MAX_EVENT_PAYLOAD_CHARS } from '../../../src/studio/run-store.js';
import {
  createBrokerHandlers,
  MAX_BOOT_EVENTS_PER_RUN,
  MAX_EVENTS_PAGE,
  MAX_EVENTS_PAGE_CHARS,
} from '../../../src/daemon/studio-db-broker.js';

/**
 * PX0 exit-4 — the core-resident half of the broker's frame bounds.
 *
 * `MAX_BOOT_PENDING_CARDS`, `MAX_EVENTS_PAGE_CHARS` and the `projectionOmitted` truncation report
 * are core code, and after the studio split their only pins were not: both integration suites moved
 * to the private app repo, where they run against a PINNED core SHA. So a core edit loosening any of
 * these bounds stayed green in core CI and reds later, in a different repo, reading as a studio
 * problem — a defect attributed to the wrong side of the wire, days after the commit that caused it.
 *
 * This is deliberately NOT the relocated suite re-imported. Those rows assert the same relations
 * from the host's side, importing the host's own `DEFAULT_MAX_FRAME_CHARS`. These assert them from
 * the CHILD's side, against ceilings DECLARED HERE AS LITERALS — because a bound that imports the
 * constant it is bounding can only ever agree with it, and because core must be able to fail on its
 * own without a module it no longer contains.
 *
 * The literals below are therefore load-bearing, not incidental. Changing a bound in `src/` means
 * changing one here too, in the same commit, with the argument written down — which is exactly the
 * event that used to pass unnoticed.
 */

/**
 * The host's wire ceiling, mirrored.
 *
 * `apps/studio/src/main/broker-frame-bounds.ts`'s `DEFAULT_MAX_FRAME_CHARS`, which is now in the
 * private repo: 64 MiB, the size past which the host treats an answer as a protocol failure and
 * kills the child. Mirroring it is the point — the child's page ceilings were set independently of
 * it once already, and its worst legal answer came out at twice this, which turns an ordinary replay
 * into a kill-and-respawn loop that never advances. Reverse this literal only when the host's number
 * moves, and say so in the same commit.
 */
const HOST_FRAME_CHARS = 64 * 1024 * 1024;

/** `{"id":N,"ok":true,"result":…}` — the JSON-RPC wrapper `send` puts around a page. Rounded up. */
const RPC_ENVELOPE_CHARS = 1_000;

/**
 * The largest frame ONE `runEventsSince` answer may hand the host.
 *
 * 4,000,000 of page budget + 64,000 for the one event that trips it + 1,000 of envelope. The
 * tripping event is inside the page on purpose — a clamp that could answer NOTHING would end a
 * replay in the middle of a run, since every paged reader here recognises end-of-log by an EMPTY
 * page — so "budget plus one event" is the contract, and this number is that contract as a literal.
 * Written out rather than computed from `MAX_EVENTS_PAGE_CHARS + MAX_EVENT_PAYLOAD_CHARS`, which
 * would rise with either of them and pin nothing.
 */
const ADMISSIBLE_PAGE_FRAME_CHARS = 4_065_000;

/**
 * One serialized envelope, at the largest the store admits.
 *
 * The frame arithmetic above assumes an overrun of at most this much past the budget. It is stated
 * separately, and checked against a real appended event rather than against the constant, because a
 * raise to `MAX_EVENT_PAYLOAD_CHARS` widens the worst page by exactly that raise while every other
 * number in this file stays put.
 */
const ADMISSIBLE_EVENT_CHARS = 65_000;

/**
 * How many unresolved cards ONE condensed boot projection may relay.
 *
 * `MAX_BOOT_PENDING_CARDS`'s value, held independently. `PENDING_DECISION_SQL` windows pending
 * decisions by TIME and never by count, and each prompt may be a full payload, so a run that raises
 * a thousand of them in two minutes projects larger than the host's whole frame bound on its own.
 * The cap is what bounds a SINGLE run's projection; the page-wide charge cannot reach that case,
 * because the first run of a page is offered the whole budget.
 */
const ADMISSIBLE_BOOT_CARDS = 20;

/** A payload the store accepts and cannot accept much more of — one maximal legal envelope. */
const MAXIMAL_PAYLOAD_CHARS = MAX_EVENT_PAYLOAD_CHARS - 200;

/** Enough maximal events that the character budget trips long before the row clamp is in sight. */
const FAT_LOG_EVENTS = Math.ceil((MAX_EVENTS_PAGE_CHARS * 2) / MAXIMAL_PAYLOAD_CHARS);

interface SeedEvent {
  type: string;
  payload: Record<string, unknown>;
  /** Only the decision rows need one: a card is projected as pending against the CLOCK, not the log. */
  ts?: string;
}

/**
 * Grow a run's log by the same INSERT the store makes.
 *
 * Not `runAppend` in a loop: forcing a real budget needs millions of characters, and each append is
 * its own IMMEDIATE transaction plus a status fold, for rows that are identical either way. The one
 * place the real append path matters is `admits one maximal event`, which uses it.
 */
function bulkInsert(db: Database.Database, runId: string, events: SeedEvent[]): number {
  const head = db.prepare('SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number };
  const insert = db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)');
  const actor = JSON.stringify({ kind: 'agent' });
  const ts = new Date(Date.UTC(2026, 0, 1)).toISOString();
  let seq = head.last_seq;
  db.transaction(() => {
    for (const e of events) {
      seq += 1;
      insert.run(runId, seq, e.ts ?? ts, actor, e.type, JSON.stringify(e.payload));
    }
    db.prepare('UPDATE studio_runs SET last_seq = ? WHERE id = ?').run(seq, runId);
  })();
  return seq;
}

function fatEvents(count: number): SeedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'run.progress',
    payload: { i, blob: 'x'.repeat(MAXIMAL_PAYLOAD_CHARS) },
  }));
}

/** Filler that no projection rule reads — it moves `lastSeq`, and that is all it is for. */
function filler(count: number): SeedEvent[] {
  return Array.from({ length: count }, (_, i) => ({ type: 'run.progress', payload: { i } }));
}

/**
 * Unresolved `decision.requested` rows with near-maximal prompts — the projection's unmetered door.
 *
 * Stamped NOW because a card past law-7's two-minute auto-deny is not projected at all, and a
 * fixture that expired before it was read would leave the cap with nothing to cap.
 */
function pendingCards(count: number): SeedEvent[] {
  const ts = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    type: 'decision.requested',
    payload: { decisionId: `d-${i}`, kind: 'approval', prompt: 'p'.repeat(63_000) },
    ts,
  }));
}

describe('studio-db-broker — the page and boot bounds, gated core-side', () => {
  const originalEnv = process.env;
  const mockSearchEngine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([]) };
  const mockRouter = { fetch: vi.fn() } as unknown as SmartRouter;

  let dir: string;
  let handlers: ReturnType<typeof createBrokerHandlers>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-bounds-'));
    process.env = { ...originalEnv, LOG_LEVEL: 'error', WIGOLO_DATA_DIR: dir };
    resetConfig();
    initDatabase(':memory:');
    handlers = createBrokerHandlers({
      db: getDatabase(),
      engines: [mockSearchEngine],
      router: mockRouter,
      backendStatus: undefined,
      onArtifact: () => {},
    });
  });

  afterEach(() => {
    closeDatabase();
    process.env = originalEnv;
    resetConfig();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The relation, not the numbers — and the relation is what a split repo loses first.
   *
   * Each side of this wire has its own ceiling and they were set independently once already. The
   * child clamps a page and the host kills a frame, so stating the child's worst LEGAL answer
   * against the host's ceiling is what makes a bump of either one fail a test naming the other.
   */
  it('the worst page the child can legally produce still fits the host frame bound', () => {
    const worstPage = MAX_EVENTS_PAGE_CHARS + MAX_EVENT_PAYLOAD_CHARS + RPC_ENVELOPE_CHARS;
    expect(
      worstPage,
      'the page budget plus one maximal event now exceeds the host frame ceiling — a LEGITIMATE page ' +
      'would be killed as an oversized frame and respawn the broker on every page of a replay',
    ).toBeLessThan(HOST_FRAME_CHARS);

    // The defect the character budget was added for, kept as a live number: the row clamp alone did
    // not bound a frame and still does not. If this ever stops holding, the character budget has
    // stopped being load-bearing and should be re-argued rather than silently kept.
    expect(
      MAX_EVENTS_PAGE * MAX_EVENT_PAYLOAD_CHARS,
      'the row clamp alone would now bound the frame, so the character budget needs re-arguing',
    ).toBeGreaterThan(HOST_FRAME_CHARS);

    // Why a clamped page is never empty: no single event can spend the whole budget by itself.
    expect(
      MAX_EVENT_PAYLOAD_CHARS,
      'one event can now exceed the page budget, so a clamped page could come back EMPTY — which ' +
      'every paged reader here treats as end-of-log',
    ).toBeLessThan(MAX_EVENTS_PAGE_CHARS);
  });

  /**
   * The per-event half of that arithmetic, measured rather than asserted about.
   *
   * `worstPage` above adds ONE maximal event to the budget. That term is only true if a maximal
   * event is actually the size this file assumes — so this appends one through the real store path,
   * which is the thing that decides what "maximal" means, and measures what came back.
   */
  it('one maximal event the store admits still fits the per-event ceiling the page arithmetic assumes', async () => {
    const run = await handlers.runCreate({ input: { task: 'one fat envelope' } });
    const event = await handlers.runAppend({
      runId: run.id,
      event: { actor: { kind: 'agent' }, type: 'run.progress', payload: { blob: 'x'.repeat(MAXIMAL_PAYLOAD_CHARS) } },
    });

    expect(
      JSON.stringify(event).length,
      'a single envelope is now larger than the overrun the frame ceiling budgets for, so the worst ' +
      'page overshoots by more than this file allows',
    ).toBeLessThanOrEqual(ADMISSIBLE_EVENT_CHARS);
  });

  /**
   * The behavioural half: the clamp, exercised, against a ceiling declared here.
   *
   * A page that comes back at the row clamp is unbounded in the unit the frame grows in. This asks
   * for everything the row clamp allows over a log of maximal envelopes and pins three things at
   * once: the page goes SHORT, a short page is never an EMPTY one, and the frame the host would have
   * to accumulate and `JSON.parse` on the thread that paints stays inside the stated ceiling.
   */
  it('clamps one runEventsSince page to the stated frame ceiling, not to the row limit', async () => {
    const run = await handlers.runCreate({ input: { task: 'a fat log' } });
    const lastSeq = bulkInsert(getDatabase(), run.id, fatEvents(FAT_LOG_EVENTS));

    const page = await handlers.runEventsSince({ runId: run.id, limit: MAX_EVENTS_PAGE });

    expect(page.length, 'the rows were available and the page was not shortened at all').toBeLessThan(lastSeq);
    expect(page.length, 'a clamped page came back EMPTY — every reader here reads that as end-of-log').toBeGreaterThan(0);
    expect(
      JSON.stringify(page).length,
      'one page now exceeds the budget by more than the single event that trips it — the frame this ' +
      'read may hand the host has grown past what its ceiling was argued for',
    ).toBeLessThanOrEqual(ADMISSIBLE_PAGE_FRAME_CHARS);

    // A SHORT page is not end-of-log, and the contract is worth nothing if the next one is empty.
    // The counter-factual as a number: a reader stopping at the first short page keeps a fraction.
    const next = await handlers.runEventsSince({ runId: run.id, since: page.at(-1)!.seq, limit: MAX_EVENTS_PAGE });
    expect(next.length, 'the log continues, so the page after a byte-tripped one must not be empty').toBeGreaterThan(0);
    expect(next[0]!.seq).toBe(page.at(-1)!.seq + 1);
  });

  /**
   * `MAX_BOOT_PENDING_CARDS` and the `projectionOmitted` report, which travel together or not at all.
   *
   * The cap alone would be a silent truncation, and a truncation the host cannot see is one it
   * cannot repair: the run's log still holds every card, and the count is how the host knows to go
   * and read them rather than install a shortened list as the run's state.
   */
  it('caps a condensed boot projection at the stated card ceiling and reports what it dropped', async () => {
    const run = await handlers.runCreate({ input: { task: 'a run drowning in cards' } });
    const CARDS = ADMISSIBLE_BOOT_CARDS + 7;
    bulkInsert(getDatabase(), run.id, [...filler(MAX_BOOT_EVENTS_PER_RUN + 1), ...pendingCards(CARDS)]);

    const [entry] = (await handlers.runListLogs({})).entries;

    expect(entry.projection, 'the run did not condense, so this asserts nothing about the projection').toBeDefined();
    expect(
      entry.projection!.pendingDecisions.length,
      'the projection relayed more cards than the ceiling — the store permits maximal prompts and ' +
      'windows them by time, never by count, so one run can exceed the host frame bound alone',
    ).toBeLessThanOrEqual(ADMISSIBLE_BOOT_CARDS);
    expect(
      entry.projectionOmitted?.pendingDecisions,
      'cards were dropped without a count — the host cannot repair a truncation it cannot see',
    ).toBe(CARDS - entry.projection!.pendingDecisions.length);
  });
});
