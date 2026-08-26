import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { registerIpc } from '../../src/main/ipc-host';
import { MAX_RETAINED_SEALED_RUNS, RunViewModel, SEALED_EVICTION_SLACK } from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';
import type { StudioState } from '../../src/shared/ipc';

/**
 * What the state push may carry, in bytes and in runs.
 *
 * The broadcast used to send `runs.list()` — every run this process has ever hydrated, terminal ones
 * included — and it fires once per 16 ms coalescing window. `RunViewModel` never forgets a run:
 * sealing drops a finished run's ENVELOPES and keeps its projection, and `hydrate` deliberately keeps
 * runs the listing did not name. So the payload grew monotonically with the machine's lifetime run
 * count while the number of runs anyone could act on stayed tiny: measured on the tip at 2,000
 * terminal + 2 live runs, one broadcast carried 2,002 summaries and ~253 KB across the IPC boundary,
 * and at 10,000 runs with realistic task strings, ~4.6 MB and 7 ms of the 16 ms frame — on the thread
 * that paints, with structured clone dominating.
 *
 * The rule is the tray's, applied at the push seam: a surface renders what is LIVE — everything
 * unfinished, plus anything still being watched so it can be demoted. History is read on demand, not
 * pushed sixty times a second.
 *
 * These bounds are cardinality and order-of-magnitude, never a stopwatch: a byte count is
 * deterministic, a millisecond on CI is not. This fixture's own numbers, at the counts below and with
 * the task string it uses: 323,223 bytes per broadcast against 333 — the same shape as the issue's
 * measurement, with a longer task line.
 */

/** Roughly what a real task line costs, so the byte bound measures a realistic payload. */
const TASK = 'reconcile the october invoices against the ledger export and flag anything over 2%';

async function seed(vm: RunViewModel, terminal: number, live: number): Promise<{ liveIds: string[] }> {
  for (let i = 0; i < terminal; i++) {
    const run = await vm.createRun({ task: `${TASK} #${i}` });
    await vm.endRun(run.id, 'completed');
  }
  const liveIds: string[] = [];
  for (let i = 0; i < live; i++) {
    const run = await vm.createRun({ task: `${TASK} live#${i}` });
    liveIds.push(run.id);
  }
  return { liveIds };
}

function pushOnce(runs: RunViewModel): StudioState {
  const listeners: Array<() => void> = [];
  const tabs = { onChange: (fn: () => void) => listeners.push(fn), listTabs: () => [] };
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } };
  registerIpc(
    win as unknown as Parameters<typeof registerIpc>[0],
    tabs as unknown as Parameters<typeof registerIpc>[1],
    runs,
  );
  listeners[0]!();
  return (send.mock.calls.at(-1) as [string, StudioState])[1];
}

describe('the IPC state push carries live runs, not lifetime runs', () => {
  it('pushes 2 summaries and kilobytes, not 2,002 and a quarter megabyte', async () => {
    const vm = new RunViewModel(new FakeRunStore());
    const { liveIds } = await seed(vm, 2_000, 2);

    const pushed = pushOnce(vm);

    expect(pushed.runs.map((r) => r.id), 'the broadcast carried runs that have already ended').toEqual(liveIds);

    // The demo, as an assertion rather than a claim. `list()` is what the tip pushed; the payload is
    // what it pushes now. Bounds are loose enough that a task string's length cannot flip them and
    // tight enough that dropping the narrowing reds.
    //
    // The lifetime listing no longer grows without limit: `MAX_RETAINED_SEALED_RUNS` evicts terminal,
    // unwatched, sealed runs, so 2,000 finished runs are held as 500 plus the live ones rather than
    // as all 2,000. That does not weaken this bound, it gives it a ceiling — the claim was always the
    // RATIO between what a broadcast used to carry and what it carries now, not a number that
    // happened to be large. Asserted here as well, because a regression that un-bounded retention
    // would otherwise show up as this arm getting "healthier".
    expect(vm.retainedRunCount(), 'retention is unbounded again — the lifetime listing has no ceiling')
      .toBeLessThanOrEqual(MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK + liveIds.length);
    const before = JSON.stringify(vm.list()).length;
    const after = JSON.stringify(pushed.runs).length;
    expect(before, 'the lifetime listing got cheap — this bound no longer measures anything').toBeGreaterThan(50_000);
    expect(after, `the broadcast still carries the lifetime listing (${before} → ${after} bytes)`).toBeLessThan(1_000);
  });

  it('keeps a finished run that is still being watched, so it can be demoted', async () => {
    // The narrowing is the tray's `listable`, not `!isTerminal`: a run promoted before it ended is
    // still on screen, and dropping it from the push would leave the human watching a run the chrome
    // no longer knows about — with no affordance left to send it away.
    const vm = new RunViewModel(new FakeRunStore());
    const watched = await vm.createRun({ task: 'the one on screen' });
    await vm.setVisibility(watched.id, 'visible', 'human');
    await vm.endRun(watched.id, 'completed');
    const hidden = await vm.createRun({ task: 'finished and out of sight' });
    await vm.endRun(hidden.id, 'completed');

    const pushed = pushOnce(vm);

    expect(pushed.runs.map((r) => r.id)).toEqual([watched.id]);
    expect(pushed.runs[0]).toMatchObject({ status: 'done', visibility: 'visible' });
  });

  it('still pushes a live run the moment it is created', async () => {
    // The control: a push narrowed to nothing at all would satisfy both bounds above.
    const vm = new RunViewModel(new FakeRunStore());
    const run = await vm.createRun({ task: 'still going' });

    expect(pushOnce(vm).runs).toEqual([
      { id: run.id, task: 'still going', status: 'running', tabIds: [], visibility: 'hidden' },
    ]);
  });
});

describe('runForDecision does not walk the machine’s finished runs', () => {
  it('finds the card on the run that is still live', async () => {
    const vm = new RunViewModel(new FakeRunStore());
    await seed(vm, 50, 0);
    const run = await vm.createRun({ task: 'waiting on a human' });
    await vm.requestDecision(run.id, { decisionId: 'd-1', kind: 'navigate', prompt: 'may I open checkout?' });

    expect(vm.runForDecision('d-1')).toBe(run.id);
  });

  it('answers nothing for a card whose run has ended', async () => {
    // The narrowing's whole semantic change, stated. `run-decisions` refuses to append a resolution
    // once the run is terminal — it re-reads the status and returns — so a terminal run was never an
    // answer this could act on, only one more projection to walk on the way past.
    const vm = new RunViewModel(new FakeRunStore());
    const run = await vm.createRun({ task: 'ended holding a card' });
    await vm.requestDecision(run.id, { decisionId: 'd-2', kind: 'navigate', prompt: 'may I open checkout?' });
    await vm.endRun(run.id, 'completed');

    expect(vm.runForDecision('d-2')).toBeUndefined();
  });
});
