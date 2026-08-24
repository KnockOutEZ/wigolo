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
import type { RunEvent } from '../../src/studio/run-store.js';
import {
  createBrokerHandlers,
  MAX_EVENTS_PAGE,
  MAX_EVENTS_PAGE_CHARS,
} from '../../src/daemon/studio-db-broker.js';
import { DEFAULT_MAX_FRAME_CHARS } from '../../apps/studio/src/main/broker-frame-bounds.js';

/**
 * SD1 exit-13 — `runEventsSince` is a FRAME, and a frame is bounded in characters or it is not
 * bounded.
 *
 * The row clamp was the only bound this read had. Rows are not size: one payload may be
 * `MAX_EVENT_PAYLOAD_CHARS`, so a page the child considered perfectly legal could be twice the
 * ceiling the host kills a frame at — which turns an ordinary replay into a kill-and-respawn loop
 * that never advances. The lesson was already written down twice in this codebase (`MAX_BOOT_*`
 * here, `DEFAULT_MAX_HELD_BYTES` in `rest/runs.ts`) and applied everywhere except here.
 *
 * These rows pin the three things that make the bound real: the page goes SHORT on characters, a
 * short page is FOLLOWED rather than read as end-of-log, and the worst page the clamp can produce
 * still fits the host's own frame cap.
 */

/** One envelope, sized so the character budget trips long before the row clamp does. */
const BIG_PAYLOAD_CHARS = 59_900;
const EVENT_COUNT = 200;

/**
 * Grow a run's log by the same INSERT the store makes — see the sibling note in
 * `studio-broker-run-reads.test.ts`. Two hundred real appends would be two hundred IMMEDIATE
 * transactions plus a status fold each, for rows that are identical either way.
 */
function bulkAppend(db: Database.Database, runId: string, count: number, payloadChars: number): number {
  const head = db.prepare('SELECT last_seq FROM studio_runs WHERE id = ?').get(runId) as { last_seq: number };
  const insert = db.prepare('INSERT INTO studio_run_events (run_id, seq, ts, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?)');
  const actor = JSON.stringify({ kind: 'agent' });
  let seq = head.last_seq;
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      seq += 1;
      const payload = JSON.stringify({ i, blob: 'x'.repeat(payloadChars) });
      insert.run(runId, seq, new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), actor, 'run.progress', payload);
    }
    db.prepare('UPDATE studio_runs SET last_seq = ? WHERE id = ?').run(seq, runId);
  })();
  return seq;
}

/**
 * The paged reader, exactly as `RunViewModel.readLog` and the REST replay write it: ask, stop on an
 * EMPTY page, advance the cursor to the page's tail seq. Reproduced here rather than imported
 * because what is under test is the CONTRACT between the two — a clamp that only the real caller
 * survives is a clamp coupled to one caller.
 */
async function readLog(
  ask: (since: number, limit: number) => Promise<RunEvent[]>,
  limit: number,
): Promise<{ events: RunEvent[]; pages: number[] }> {
  const events: RunEvent[] = [];
  const pages: number[] = [];
  let cursor = 0;
  for (let guard = 0; guard < 1_000; guard++) {
    const page = await ask(cursor, limit);
    if (page.length === 0) return { events, pages };
    pages.push(page.length);
    for (const e of page) events.push(e);
    const tail = page[page.length - 1]!.seq;
    if (tail <= cursor) return { events, pages };
    cursor = tail;
  }
  throw new Error('readLog did not terminate');
}

describe('studio-db-broker — one runEventsSince page is bounded in characters, not only in rows', () => {
  const originalEnv = process.env;
  const mockSearchEngine: SearchEngine = { name: 'mock', search: vi.fn().mockResolvedValue([]) };
  const mockRouter = { fetch: vi.fn() } as unknown as SmartRouter;

  let dir: string;
  let handlers: ReturnType<typeof createBrokerHandlers>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wigolo-broker-frame-budget-'));
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

  it('returns a SHORT page when the characters run out, well before the row clamp would', async () => {
    const run = await handlers.runCreate({ input: { task: 'a fat log' } });
    // `runCreate` already wrote `run.created` at seq 1, so the log is one longer than the bulk count.
    const total = bulkAppend(getDatabase(), run.id, EVENT_COUNT, BIG_PAYLOAD_CHARS);

    // Asks for everything the row clamp allows. The rows are available — the characters are not.
    const page = await handlers.runEventsSince({ runId: run.id, limit: MAX_EVENTS_PAGE });

    expect(page.length, 'the page was not shortened at all').toBeLessThan(total);
    expect(page.length, 'a short page must never be an empty one — empty is end-of-log').toBeGreaterThan(0);
    // The frame the host would have to accumulate and parse on the thread that paints. Budget plus
    // at most the one event that tripped it: the tripping event is INCLUDED so the page can never
    // come back empty.
    const frameChars = JSON.stringify(page).length;
    expect(frameChars).toBeGreaterThan(MAX_EVENTS_PAGE_CHARS);
    expect(frameChars).toBeLessThan(MAX_EVENTS_PAGE_CHARS + MAX_EVENT_PAYLOAD_CHARS + 1_000);
  });

  it('a byte-tripped short page is followed to the end of the log, not read as the end of it', async () => {
    const run = await handlers.runCreate({ input: { task: 'a fat log' } });
    const lastSeq = bulkAppend(getDatabase(), run.id, EVENT_COUNT, BIG_PAYLOAD_CHARS);

    const { events, pages } = await readLog(
      (since, limit) => handlers.runEventsSince({ runId: run.id, since, limit }),
      MAX_EVENTS_PAGE,
    );

    // Every envelope arrives, in order, across several pages — the contract the clamp relies on.
    expect(events).toHaveLength(lastSeq);
    expect(events.at(-1)!.seq).toBe(lastSeq);
    expect(events.map((e) => e.seq)).toEqual(events.map((e) => e.seq).slice().sort((a, b) => a - b));
    expect(pages.length, 'the budget never tripped, so this asserts nothing').toBeGreaterThan(1);
    // The counter-factual, stated as a number: a reader that stopped on the first SHORT page would
    // have kept a fraction of the run and called it the whole thing.
    expect(pages[0]).toBeLessThan(lastSeq);
  });

  it('an ordinary log is not shortened — the budget bounds a frame, it does not page every read', async () => {
    const run = await handlers.runCreate({ input: { task: 'a normal log' } });
    const lastSeq = bulkAppend(getDatabase(), run.id, 50, 200);

    const page = await handlers.runEventsSince({ runId: run.id, limit: MAX_EVENTS_PAGE });
    expect(page).toHaveLength(lastSeq);
    expect(page.at(-1)!.seq).toBe(lastSeq);
  });

  /**
   * The relation, not the numbers. Each side of this wire has its own ceiling and they were set
   * independently: the child clamped ROWS and the host kills a FRAME, so the child's own worst-case
   * legal answer was twice what the host would accept. Asserting the relation is what makes a future
   * bump of either constant fail a test that names the other one.
   */
  it('the worst page the child can produce still fits the frame the host will accept', () => {
    // ~30 characters of JSON-RPC envelope around the events array (`{"id":N,"ok":true,"result":…}`).
    const RPC_ENVELOPE_CHARS = 1_000;
    const worstPage = MAX_EVENTS_PAGE_CHARS + MAX_EVENT_PAYLOAD_CHARS + RPC_ENVELOPE_CHARS;
    expect(
      worstPage,
      'MAX_EVENTS_PAGE_CHARS (+ one MAX_EVENT_PAYLOAD_CHARS event) now exceeds the host\'s ' +
      'DEFAULT_MAX_FRAME_CHARS — a legitimate page would be killed as an oversized frame and respawn the broker',
    ).toBeLessThan(DEFAULT_MAX_FRAME_CHARS);

    // The defect this replaced, kept as a live number: rows alone did NOT bound the frame, and still
    // would not. If MAX_EVENTS_PAGE or MAX_EVENT_PAYLOAD_CHARS ever shrink far enough for this to
    // stop holding, the character budget is no longer load-bearing and should be re-argued, not
    // silently kept.
    expect(
      MAX_EVENTS_PAGE * MAX_EVENT_PAYLOAD_CHARS,
      'the row clamp alone would now bound the frame, so this budget needs re-arguing rather than keeping',
    ).toBeGreaterThan(DEFAULT_MAX_FRAME_CHARS);

    // Why a clamped page is never empty: no single event can spend the whole budget on its own.
    expect(
      MAX_EVENT_PAYLOAD_CHARS,
      'one event can exceed the page budget, so a clamped page could come back empty — which every ' +
      'paged reader here treats as end-of-log',
    ).toBeLessThan(MAX_EVENTS_PAGE_CHARS);
  });
});
