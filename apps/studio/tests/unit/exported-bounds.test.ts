import { describe, it, expect } from 'vitest';
import { BROKER_STOP_GRACE_MS } from 'wigolo/studio';
import { DEFAULT_MAX_FRAME_CHARS } from '../../src/main/broker-frame-bounds';
import {
  ADOPT_RETRY_MAX_MS,
  LIVE_EVICTION_SLACK,
  MAX_BOOT_HYDRATION_RUNS,
  MAX_RETAINED_LIVE_RUNS,
  MAX_RETAINED_SEALED_RUNS,
  SEALED_EVICTION_SLACK,
} from '../../src/main/run-view-model';

/**
 * The literal value of every exported bound that is otherwise asserted only against its own symbol.
 *
 * WHY THIS FILE EXISTS. A bound like `MAX_RETAINED_SEALED_RUNS` is exercised by arms that build
 * `MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK + 250` runs and then expect
 * `MAX_RETAINED_SEALED_RUNS` back. Every one of those stays green if the constant becomes five, or
 * five million: they pin the DERIVATION, which is what you want them to pin, and they are silent about
 * the number. So an edit that moves a shipped bound by three orders of magnitude passes the whole
 * suite, and the thing that was supposed to be a contract turns out to be whatever the source says
 * today. The literal here is what makes the derived assertions non-circular — it is the one place a
 * change to the number has to be stated deliberately rather than absorbed.
 *
 * `run-store.test.ts` pins `AUTO_DENY_MS` on exactly this reasoning and names it: "the number is
 * itself a contract". These are the rest of them, and each line below says what breaks if it moves.
 *
 * Changing a number here is not forbidden. Changing it WITHOUT changing this file is.
 */
describe('the exported bounds carry their literal values, not just their derivations', () => {
  it('holds the retention ceilings at the page-sized numbers the surfaces are built for', () => {
    // No surface here names more than a page of runs, and both bounds are set to that rather than to
    // a memory figure — a projection's size is a function of the task string, which the agent writes.
    // Move either and the state push, the tray menu and the presentation controller all pay for it on
    // the thread that paints, once per fan-out each.
    expect(MAX_RETAINED_SEALED_RUNS).toBe(500);
    expect(MAX_RETAINED_LIVE_RUNS).toBe(500);
    // The slack is what makes each cut batched rather than per-run: it is the number of extra
    // projections held in exchange for one sort per hundred runs instead of one per run.
    expect(SEALED_EVICTION_SLACK).toBe(100);
    expect(LIVE_EVICTION_SLACK).toBe(100);
  });

  it('derives the boot read bound from what retention can hold, so the two cannot disagree', () => {
    // Not an independent number: a page past this point is read, parsed, retained and then evicted by
    // the cut at the end of `hydrate`. Asserted as the SUM rather than as 1200 so that moving a
    // ceiling above moves this with it — the literal is on the parts, and the relationship is here.
    expect(MAX_BOOT_HYDRATION_RUNS).toBe(
      MAX_RETAINED_LIVE_RUNS + LIVE_EVICTION_SLACK + MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK,
    );
    expect(MAX_BOOT_HYDRATION_RUNS).toBe(1_200);
  });

  it('holds the adoption backoff ceiling at half a minute', () => {
    // `ADOPT_RETRY_BASE_MS`'s note is explicit about what this number is for: a store that comes back
    // after a minute must still be picked up inside one, rather than after a backoff that has doubled
    // its way into the hours. A larger ceiling makes a REST-created run — whose only envelope is its
    // `run.created`, so nothing later can heal it — invisible for as long as the backoff lasts.
    expect(ADOPT_RETRY_MAX_MS).toBe(30_000);
  });

  it('holds the broker shutdown grace at three seconds', () => {
    // Paired with `BROKER_KILL_REAP_MS` under a five-second total, which is the quit deadline the OS
    // gives before the app looks hung. Raising this alone silently spends the whole budget on the
    // grace and leaves nothing for the reap.
    expect(BROKER_STOP_GRACE_MS).toBe(3_000);
  });

  it('holds the frame ceiling at 64 MiB', () => {
    // The last line of defence on the stdio pipe: a frame past it kills and respawns the DB child. The
    // boot budgets are all sized to stay under it, so lowering this turns a legitimate page into a
    // restart loop and raising it makes the accumulate-and-parse it guards unbounded again.
    expect(DEFAULT_MAX_FRAME_CHARS).toBe(64 * 1024 * 1024);
    expect(DEFAULT_MAX_FRAME_CHARS).toBe(67_108_864);
  });
});
