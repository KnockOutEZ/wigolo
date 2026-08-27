import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { SearchEngine } from '../../src/types.js';
import type { SmartRouter } from '../../src/fetch/router.js';
import { resetConfig } from '../../src/config.js';
import { initDatabase, getDatabase, closeDatabase } from '../../src/cache/db.js';
import { MAX_EVENT_PAYLOAD_CHARS } from '../../src/studio/run-store.js';
import {
  createBrokerHandlers,
  MAX_BOOT_EVENTS_PER_RUN,
  MAX_BOOT_FRAME_CHARS,
  MAX_BOOT_PENDING_CARDS,
  MAX_EVENTS_PAGE,
} from '../../src/daemon/studio-db-broker.js';
import { DEFAULT_MAX_FRAME_CHARS } from '../../apps/studio/src/main/broker-frame-bounds.js';

/**
 * SD1 exit-16 — the boot page's condensed answer is an ANSWER, and an answer that ships characters
 * has to be charged for them.
 *
 * `runListLogs` decided on the event budget first, so every run past `MAX_BOOT_EVENTS_PER_RUN` took
 * the condensed branch and shipped `projection: run` — the full held-tab list and the full
 * in-window pending-card list, each card's prompt up to `MAX_EVENT_PAYLOAD_CHARS` — while reporting
 * `charsSpent: 0`. Nothing in the call ever compared a projection against `MAX_BOOT_FRAME_CHARS`,
 * and the frame the host has to accumulate and `JSON.parse` on the thread that paints was therefore
 * bounded by nothing at all: a run holding many unresolved cards produces tens of megabytes past
 * the host's `DEFAULT_MAX_FRAME_CHARS`, which kills and respawns the DB child on EVERY hydration
 * attempt — the same boot, the same oversize, forever.
 *
 * These rows pin the two halves of the fix as behaviour: the projection is CHARGED (so a page of
 * condensed runs terminates), and the pending-card listing is CAPPED BY COUNT (so no single
 * projection can be unbounded on its own, whatever the store let a writer store).
 */

const CARD_PROMPT_CHARS = 63_000;

/** Enough to put the run past the per-run event budget, so the condensed branch is the only one. */
const FILLER_EVENTS = MAX_BOOT_EVENTS_PER_RUN + 1;

interface SeedEvent {
  type: string;
  payload: Record<string, unknown>;
  ts?: string;
}

/**
 * Grow a run's log by the same INSERT the store makes — the sibling note in
 * `studio-broker-frame-budget.test.ts` says why: thousands of real appends are thousands of
 * IMMEDIATE transactions plus a status fold each, for rows that are identical either way.
 */
function bulkInsert(db: Database.Database, runId: string, events: SeedEvent[]): number {
  const head = db.prepare('SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number };
  const insert = db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)');
  const actor = JSON.stringify({ kind: 'agent' });
  const defaultTs = new Date().toISOString();
  let seq = head.last_seq;
  db.transaction(() => {
    for (const e of events) {
      seq += 1;
      insert.run(runId, seq, e.ts ?? defaultTs, actor, e.type, JSON.stringify(e.payload));
    }
    db.prepare('UPDATE studio_runs SET last_seq = ? WHERE id = ?').run(seq, runId);
  })();
  return seq;
}

/** Filler that no projection rule reads — it moves `lastSeq` and nothing else. */
function filler(count: number): SeedEvent[] {
  return Array.from({ length: count }, (_, i) => ({ type: 'run.progress', payload: { i } }));
}

/**
 * `cards` unresolved `decision.requested` rows, each with a near-maximal prompt.
 *
 * `PENDING_DECISION_SQL` windows on `ts` and never on COUNT, so "in window" is the only thing a
 * writer has to arrange to have every one of these projected — which is exactly what makes the
 * count cap, and not the window, the bound that matters here.
 */
function pendingCards(count: number): SeedEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'decision.requested',
    payload: { decisionId: `d-${i}`, kind: 'approval', prompt: 'p'.repeat(CARD_PROMPT_CHARS) },
  }));
}

describe('studio-db-broker — a condensed boot projection is charged and bounded', () => {
  const originalEnv = process.env;
  const mockSearchEngine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([]) };
  const mockRouter = { fetch: vi.fn() } as unknown as SmartRouter;

  let dir: string;
  let handlers: ReturnType<typeof createBrokerHandlers>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-boot-projection-'));
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
   * The exit-16 probe's own shape: a long-lived run that holds every tab it ever attached. Its
   * projection grows with the run's lifetime and needs no hostility to do it — a tab list is a
   * perfectly ordinary thing for a run to accumulate.
   */
  it('charges the characters a condensed projection ships, which used to be reported as zero', async () => {
    const run = await handlers.runCreate({ input: { task: 'a long-lived run holding its tabs' } });
    bulkInsert(
      getDatabase(),
      run.id,
      Array.from({ length: FILLER_EVENTS }, (_, i) => ({ type: 'tab.attached', payload: { tabId: `tab-${i}` } })),
    );

    const page = await handlers.runListLogs({});
    const [entry] = page.entries;

    // Precondition: this IS the condensed branch, so the assertion below is about a projection.
    expect(entry.events, 'the run fitted after all — this row no longer tests the condensed path').toHaveLength(0);
    expect(entry.projection).toBeDefined();

    const shipped = JSON.stringify(entry.projection).length;
    expect(shipped, 'the fixture is too small for the charge to be distinguishable from zero').toBeGreaterThan(10_000);
    expect(
      page.charsSpent,
      'a condensed entry shipped its projection and charged the page nothing for it — the host ' +
      'accumulates a per-page allowance out of what came BACK, so an uncharged door is an unbounded one',
    ).toBeGreaterThanOrEqual(shipped);
  });

  /**
   * The reproduced ceiling, forced rather than hoped for. Every run here is past the event budget
   * and holds far more in-window cards than a boot screen could ever show; before the cap and the
   * charge, the page relayed all of them, from every run, in one frame.
   */
  it('keeps a page of hostile pending-card runs inside the host’s frame bound', async () => {
    const RUNS = 5;
    const CARDS_PER_RUN = 30;
    for (let r = 0; r < RUNS; r++) {
      const run = await handlers.runCreate({ input: { task: `run ${r}` } });
      bulkInsert(getDatabase(), run.id, [
        ...filler(FILLER_EVENTS),
        { type: 'tab.attached', payload: { tabId: `tab-${r}` } },
        ...pendingCards(CARDS_PER_RUN),
      ]);
    }

    const page = await handlers.runListLogs({});
    expect(page.entries).toHaveLength(RUNS);
    expect(page.entries.every((e) => e.projection !== undefined), 'no run was condensed — this asserts nothing').toBe(true);

    const frameChars = JSON.stringify(page).length;
    // The counter-factual as a number: unbounded, this page is what the store holds — five runs of
    // thirty near-maximal prompts — and that is multiples of the budget.
    expect(RUNS * CARDS_PER_RUN * CARD_PROMPT_CHARS).toBeGreaterThan(MAX_BOOT_FRAME_CHARS * 2);
    // Budget, plus at most the one projection that tripped it. Bounded because the trip is decided
    // on a CAPPED projection, so "one more" is finite.
    expect(frameChars).toBeLessThan(MAX_BOOT_FRAME_CHARS + MAX_BOOT_PENDING_CARDS * MAX_EVENT_PAYLOAD_CHARS + 100_000);
    expect(
      frameChars,
      'the boot frame is past the size the host kills a frame at — the child is respawned on every ' +
      'hydration attempt and the app never boots',
    ).toBeLessThan(DEFAULT_MAX_FRAME_CHARS);
    expect(page.charsSpent, 'the page shipped characters it did not charge for').toBeGreaterThanOrEqual(
      page.entries.reduce((n, e) => n + JSON.stringify(e.projection).length, 0),
    );
    // Law 4, and the reason the budget may not take it: the host seeds `tab.attached` from exactly
    // this array to rebuild which run owns which tab (`run-view-model.ts`'s `keptSeed`). A run whose
    // projection under-reports its held tabs has not given a smaller answer — it has told the app
    // those tabs belong to nobody, and the next run to ask for one is not refused. Every entry here
    // is past the budget, which is precisely where a cut would be tempting.
    expect(
      page.entries.map((e) => e.projection!.tabIds.length),
      'the character budget cut a run’s held-tab list — two runs can now hold the same tab',
    ).toEqual(page.entries.map(() => 1));
  });

  it('caps the pending-card listing by count and says how many it dropped', async () => {
    const run = await handlers.runCreate({ input: { task: 'a run drowning in cards' } });
    const CARDS = MAX_BOOT_PENDING_CARDS + 7;
    bulkInsert(getDatabase(), run.id, [...filler(FILLER_EVENTS), ...pendingCards(CARDS)]);

    const [entry] = (await handlers.runListLogs({})).entries;
    expect(entry.projection).toBeDefined();
    expect(
      entry.projection!.pendingDecisions.length,
      'the projection relayed every card the store held — the store permits 64k prompts and windows ' +
      'them by time, never by count',
    ).toBeLessThanOrEqual(MAX_BOOT_PENDING_CARDS);
    expect(
      entry.projectionOmitted?.pendingDecisions,
      'cards were dropped silently — a truncation the host cannot see is one it cannot replay',
    ).toBe(CARDS - entry.projection!.pendingDecisions.length);
  });

  /**
   * SD1 exit-18 — the two facts the host's half of this contract is built on.
   *
   * The row above pins the REPORT; this pins that the report is ACTIONABLE, which is what the host
   * relies on and what nothing checked. `runGet` is the read the host's repair goes to
   * (`run-view-model.ts`'s `rereadCondensed` → `replayOnce` → `recondense`), so the repair is only
   * worth issuing if that read is not itself subject to the page's per-run cap — the cap belongs to
   * `condenseProjection` and to nothing else. If it ever spreads to `runGet`, the host's re-read
   * would come back exactly as short as the answer it was replacing, and the repair would be a
   * round-trip that changed nothing.
   *
   * The host's own reaction is pinned in `apps/studio/tests/unit/run-view-model.test.ts` rather than
   * here. It cannot be driven from this file: importing `run-view-model.ts` from a root spec pulls
   * `wigolo/studio` into the root projects, and CI's `type gate` job runs `gate:studio` with no
   * build — so the type-check debt ratchet fails on a `dist/` that does not exist there. Reverse
   * this the moment that job builds core, or `apps/**` leaves `tsconfig.tests-debt.json`.
   */
  it('does not apply the page’s per-run card cap to the read the host repairs from', async () => {
    const run = await handlers.runCreate({ input: { task: 'a run blocked on more cards than a page can carry' } });
    const CARDS = MAX_BOOT_PENDING_CARDS + 7;
    bulkInsert(getDatabase(), run.id, [...filler(FILLER_EVENTS), ...pendingCards(CARDS)]);

    // Precondition: this run really is served short, so the comparison below is against a repair and
    // not against a page that happened to fit.
    const [entry] = (await handlers.runListLogs({})).entries;
    expect(entry.projectionOmitted?.pendingDecisions, 'the fixture was not truncated — nothing to repair').toBe(
      CARDS - entry.projection!.pendingDecisions.length,
    );

    const repaired = (await handlers.runGet({ runId: run.id }))!;
    expect(
      repaired.pendingDecisions.map((d) => d.decisionId).sort(),
      'the read the host re-reads from is capped too — its repair would come back as short as the ' +
      'answer it replaces, and the dropped cards would be unreachable from every surface',
    ).toEqual(pendingCards(CARDS).map((_, i) => `d-${i}`).sort());
    // And the log itself still holds every one of them, which is the claim `:103` makes about why a
    // capped projection is not a loss. Counted in SQL rather than through `runEventsSince`, whose
    // page is clamped to `MAX_EVENTS_PAGE` — the cards are this log's TAIL, so a single page of a
    // 2,028-envelope run would report zero of them and the row would pass for the wrong reason.
    const stored = getDatabase()
      .prepare('SELECT COUNT(*) AS n FROM studio_run_events WHERE run_id = ? AND type = ?')
      .get(run.id, 'decision.requested') as { n: number };
    expect(stored.n, 'the cards the page dropped are not in the log either — nothing could repair them').toBe(CARDS);
  });

  /**
   * The cap must not fire on an ordinary run, or the condensed answer stops being the same answer
   * REST gives — which is the whole reason it is an acceptable substitute for the log.
   */
  it('leaves an ordinary condensed projection field-for-field identical to the REST one', async () => {
    const run = await handlers.runCreate({ input: { task: 'ordinary' } });
    bulkInsert(getDatabase(), run.id, [
      ...filler(FILLER_EVENTS),
      { type: 'tab.attached', payload: { tabId: 'tab-1' } },
      ...pendingCards(2),
    ]);

    const [entry] = (await handlers.runListLogs({})).entries;
    expect(entry.projection).toEqual(await handlers.runGet({ runId: run.id }));
    expect(entry.projectionOmitted, 'an ordinary run was reported as truncated').toBeUndefined();
    expect(entry.projection!.tabIds).toEqual(['tab-1']);
  });

  /**
   * The measure pass and the frame were two separate serializations of the same page — the clamp
   * `JSON.stringify`d every event to decide, and `send` then stringified the whole frame again.
   * Measured at 3.29 ms + 1.66 ms on a 733 KB page; a hundred-thousand-event gap replay pays that
   * ~50 times over, on the child's only thread.
   *
   * Counting the calls is the pin, because the cost IS the call: the size bound is now read from
   * SQLite's own `LENGTH`, which touches no JS string at all.
   */
  it('does not serialize the page to decide how big the page is', async () => {
    const run = await handlers.runCreate({ input: { task: 'a fat log' } });
    bulkInsert(
      getDatabase(),
      run.id,
      Array.from({ length: 40 }, (_, i) => ({ type: 'run.progress', payload: { i, blob: 'x'.repeat(20_000) } })),
    );

    const spy = vi.spyOn(JSON, 'stringify');
    try {
      const page = await handlers.runEventsSince({ runId: run.id, limit: MAX_EVENTS_PAGE });
      expect(page.length, 'nothing was read, so the count below asserts nothing').toBeGreaterThan(0);
      expect(
        spy.mock.calls.length,
        'the read serialized the page to measure it, and the transport serializes it again to send it',
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
