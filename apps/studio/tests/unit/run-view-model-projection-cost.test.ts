import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunEvent } from 'wigolo/studio';
import { RunViewModel } from '../../src/main/run-view-model';
import { createRunTray, type TrayMenuItem, type TrayPort } from '../../src/main/run-tray';
import { FakeRunStore } from '../helpers/fake-run-store';

/**
 * `projectRun` replays a whole log. The view-model memoises it and drops the memo when a run's events
 * change, so folding is supposed to be cheap and projecting is supposed to happen on READ — once per
 * burst, not once per envelope.
 *
 * That is easy to lose by accident: any per-envelope check written as "project, then look at the
 * result" turns folding a run of N envelopes into N replays, which is quadratic in the exact place the
 * retention bound exists to make cheap. This file counts the replays, because nothing about the
 * resulting projection is different when they are quadratic — only the clock is, and a clock
 * assertion is a flake.
 *
 * THE BLIND SPOT THIS FILE USED TO HAVE, because it is the reason for every arm below the first.
 * The original guard registered NO listener — the one condition production never meets. Every
 * surface subscribes a listener that reads: `ipc-host` broadcasts `runs.list()`, `run-tray` rebuilds
 * the whole menu, `run-presentation` calls `list()` to decide what the window wants. Each of those
 * refills the memo `applyEvent` just dropped, so the fold WAS quadratic in the shipped app and this
 * file could not see it: measured at 3k envelopes = 44 ms with a reader against 6 ms without, and at
 * 20k = 1135 ms against 14 ms — doubling the log roughly quadrupled the cost, on the main thread.
 *
 * So the reader is now part of the fixture, in the tray's own shape, and the bound is on how many
 * times a BURST may project rather than on whether folding projects at all.
 */
const counter = vi.hoisted(() => ({ projections: 0 }));

vi.mock('wigolo/studio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('wigolo/studio')>();
  const counted: typeof actual.projectRun = (facts, events, now, opts) => {
    counter.projections++;
    return actual.projectRun(facts, events, now, opts);
  };
  return { ...actual, projectRun: counted };
});

/**
 * A burst is allowed a leading fan-out and a trailing one: the first envelope paints immediately so
 * the menu bar stays responsive, and everything that arrives inside the coalescing window is folded
 * into the single redraw that closes it. Anything above this is a per-envelope replay.
 */
const BURST_PROJECTION_BOUND = 2;

describe('RunViewModel — folding an envelope does not replay the log', () => {
  it('projects on read and on sealing, never once per folded envelope', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'a chatty one' });

    counter.projections = 0;
    for (let i = 0; i < 50; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    // Nobody read the run, so nothing had to be replayed to fold 50 envelopes in.
    expect(counter.projections, 'folding replayed the log per envelope').toBe(0);

    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(50);
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(50);
    expect(counter.projections, 'the memo did not survive a second read').toBe(1);

    // Ending the run costs exactly one more: the projection that is kept in place of the log.
    counter.projections = 0;
    await vm.endRun(run.id, 'completed');
    expect(counter.projections).toBe(1);
    expect(vm.retainedEventCount(run.id)).toBe(0);
    expect(vm.snapshot(run.id)?.status).toBe('done');
    expect(counter.projections, 'a sealed run re-projected instead of answering from what it kept').toBe(1);
  });
});

describe('RunViewModel — a burst with a reader attached', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let runId: string;

  /**
   * The next envelope the socket would deliver — `onLine → applyEvent`, the synchronous entry point.
   * The seq is counted here rather than read off the store, because this path deliberately does NOT
   * go through the store: a delivered envelope is already committed there. Reading the store's length
   * would hand every call the same seq, and `applyEvent` would idempotently drop all but the first —
   * a fixture that folds one envelope and calls it a burst of two hundred.
   */
  let seq = 0;
  const nextEvent = (payload: Record<string, unknown> = { kind: 'browser_action', amount: 1 }): RunEvent => ({
    seq: ++seq,
    ts: new Date(1_700_000_100_000).toISOString(),
    actor: { kind: 'agent' },
    type: 'cost.recorded',
    payload,
  });

  beforeEach(async () => {
    vi.useFakeTimers();
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
    runId = (await vm.createRun({ task: 'a chatty one' })).id;
    seq = store.log.get(runId)?.length ?? 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('costs a bounded number of projections, not one per envelope', () => {
    // The tray's shape exactly: a listener that answers by projecting every run it can see.
    let fanOuts = 0;
    vm.onChange(() => { fanOuts++; vm.list(); });

    counter.projections = 0;
    for (let i = 0; i < 200; i++) vm.applyEvent(runId, nextEvent());
    vi.advanceTimersByTime(100);

    expect(counter.projections, 'the fan-out replayed the whole log once per envelope').toBeLessThanOrEqual(BURST_PROJECTION_BOUND);
    expect(fanOuts, 'the burst was fanned out once per envelope').toBeLessThanOrEqual(BURST_PROJECTION_BOUND);
    // The control: a bound is only worth something if the projection is still CORRECT and still
    // reaches the reader. A fan-out that stopped happening would satisfy the bound vacuously.
    expect(fanOuts).toBeGreaterThan(0);
    expect(vm.snapshot(runId)?.cost.browserActions).toBe(200);
  });

  it('rebuilds the menu-bar item once per burst, not once per envelope', () => {
    const menus: TrayMenuItem[][] = [];
    const tray: TrayPort = {
      setLabel: () => {},
      setToolTip: () => {},
      setMenu: (items) => { menus.push(items); },
      destroy: () => {},
    };
    createRunTray({
      tray,
      runs: { list: () => vm.list(), onChange: (cb) => vm.onChange(cb) },
      setVisibility: async () => {},
      onError: () => {},
    });
    // `createRunTray` draws once on mount; the burst is what is being counted.
    const atMount = menus.length;

    for (let i = 0; i < 200; i++) vm.applyEvent(runId, nextEvent());
    vi.advanceTimersByTime(100);

    // Every rebuild is a native menu template plus a `setContextMenu` on the OS item, on the main
    // thread. 200 of them for one burst of envelopes is the cost this bound exists to refuse.
    expect(menus.length - atMount, 'the OS menu was rebuilt once per folded envelope').toBeLessThanOrEqual(BURST_PROJECTION_BOUND);
    expect(menus.length, 'the menu stopped being rebuilt at all').toBeGreaterThan(atMount);
  });

  it('holds when the envelopes arrive with promise turns between them', async () => {
    // The production notify path: the store fans each committed envelope out before its own append
    // resolves, so the awaits below put a microtask turn between every fold. A coalescer that only
    // batched a synchronous loop would be defeated by exactly this and would still be quadratic.
    vm.onChange(() => { vm.list(); });
    const run = await vm.createRun({ task: 'another' });

    counter.projections = 0;
    for (let i = 0; i < 200; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    vi.advanceTimersByTime(100);

    expect(counter.projections, 'a turn between envelopes defeated the coalescer').toBeLessThanOrEqual(BURST_PROJECTION_BOUND + 1);
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(200);
  });
});
