import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RunEvent, RunEventInput } from 'wigolo/studio';
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

/**
 * The same class of defect one seam over: `ownerOf` used to WALK every run and project it to ask
 * whether that run held the tab. It is asked once per TAB per state push — `ipc-host`'s `state()`
 * labels every tab with the run that owns it — so a single broadcast cost tabs × runs × the tabs each
 * run holds, on the thread that paints, and it grew with every run the machine had ever seen rather
 * than with anything the human is looking at.
 *
 * `snapshot` is the instrument for the same reason `projectRun` is above: the ANSWER is identical
 * whether it came from an index or from a scan, so nothing about the answer can see the difference.
 */
describe('RunViewModel — a broadcast does not scan the runs to label a tab', () => {
  it('answers ownership from a fold-maintained index', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    await vm.hydrate();

    const owners = new Map<string, string>();
    for (let i = 0; i < 50; i++) {
      const run = await vm.createRun({ task: `run ${i}` });
      await vm.attachTab(run.id, `tab-${i}`);
      owners.set(`tab-${i}`, run.id);
    }
    // Two tabs the human opened and no run has ever attached — law 4's separate group.
    const universe = [...owners.keys(), 'human-1', 'human-2'];

    const projections = vi.spyOn(vm, 'snapshot');
    // One state push, exactly as `ipc-host` assembles it: every tab labelled with its run.
    const labelled = universe.map((tabId) => [tabId, vm.ownerOf(tabId)] as const);
    const mine = vm.userTabs(universe);

    expect(projections, 'labelling the tabs replayed every run once per tab').not.toHaveBeenCalled();
    projections.mockRestore();

    // The control: a bound is worth nothing if the answer moved. Every tab is still labelled with the
    // run that attached it, and the human's own tabs are still nobody's.
    for (const [tabId, runId] of labelled) expect(runId).toBe(owners.get(tabId));
    expect(mine).toEqual(['human-1', 'human-2']);
  });

  it('keeps the index in step with the log through detach, reattach and a replay', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    await vm.hydrate();
    const a = await vm.createRun({ task: 'first' });
    const b = await vm.createRun({ task: 'second' });
    await vm.attachTab(a.id, 'tab-x');

    expect(vm.ownerOf('tab-x')).toBe(a.id);
    expect(vm.isUserTab('tab-x')).toBe(false);

    // Released, so it becomes the human's again — and another run may now legally take it.
    await vm.detachTab('tab-x', 'closed');
    expect(vm.ownerOf('tab-x')).toBeUndefined();
    expect(vm.isUserTab('tab-x')).toBe(true);
    await vm.attachTab(b.id, 'tab-x');
    expect(vm.ownerOf('tab-x')).toBe(b.id);

    // A replay REPLACES a log rather than folding into it, so the index has to be rebuilt from the
    // projection there — a run that lost a tab while the read was on the wire must lose it here too.
    const fresh = new RunViewModel(store);
    await fresh.hydrate();
    expect(fresh.ownerOf('tab-x')).toBe(b.id);
    expect(fresh.tabsOf(a.id)).toEqual([]);
  });
});

/**
 * The third seam of the same class, on the path that runs BEFORE the app draws anything.
 *
 * `retain` re-indexes the run it just replaced, and the clear step used to walk the WHOLE tab index
 * looking for that run's entries. `hydrate` calls `retain` once per listed run — up to
 * `MAX_HYDRATION_PAGES × DEFAULT_LIST_LIMIT` of them — so boot cost runs × every tab every run on the
 * machine holds, on the Electron main thread, before the first frame. Measured isolated at 10,000
 * runs × 3 tabs: 1.3 s of nothing but map deletion.
 *
 * Counting map iteration steps rather than the clock, because a wall-clock bound at this size is a
 * flake on a loaded CI box and says nothing about WHY it was slow. The instrument is global — every
 * `for…of` over any Map inside `hydrate` is counted — which is what makes the bound meaningful: it
 * caps the total, so a scan moving to a different map cannot hide from it.
 */
const HYDRATION_RUNS = 2_000;
const TABS_PER_RUN = 2;
/**
 * Per RUN, not in total: the claim is that boot is linear in the run count, so the bound has to scale
 * with it or it is a bound on this fixture's size instead. Generous by more than an order of magnitude
 * against what a linear hydrate actually costs, and smaller by three than what a quadratic one does —
 * the gap is the margin, and nothing lives in it.
 */
const MAP_STEPS_PER_RUN_BOUND = 40;

/**
 * Total `next()` calls on every Map iterator taken while `fn` runs.
 *
 * `for (const x of map)` and `[...map]` both go through `Map.prototype[Symbol.iterator]`, so wrapping
 * that one function catches every walk of a map without the view-model having to expose its indexes to
 * a test. Restored in a `finally`: leaving a patched prototype behind would corrupt every later file.
 */
async function countMapSteps(fn: () => Promise<void>): Promise<number> {
  const original = Map.prototype[Symbol.iterator];
  let steps = 0;
  Map.prototype[Symbol.iterator] = function (this: Map<unknown, unknown>) {
    const inner = original.call(this);
    return {
      next: () => { steps++; return inner.next(); },
      [Symbol.iterator]() { return this; },
    } as MapIterator<[unknown, unknown]>;
  };
  try {
    await fn();
  } finally {
    Map.prototype[Symbol.iterator] = original;
  }
  return steps;
}

describe('RunViewModel — boot hydration is linear in the number of runs', () => {
  it('clears a replayed run’s tabs by what that run owns, not by every tab on the machine', async () => {
    const store = new FakeRunStore();
    const owners = new Map<string, string>();
    for (let i = 0; i < HYDRATION_RUNS; i++) {
      const run = await store.createRun({ task: `run ${i}` });
      for (let t = 0; t < TABS_PER_RUN; t++) {
        const tabId = `tab-${i}-${t}`;
        await store.appendEvent(run.id, { actor: { kind: 'agent', driver: 'studio' }, type: 'tab.attached', payload: { tabId } });
        owners.set(tabId, run.id);
      }
    }

    // The boot path exactly: a view-model that has seen nothing, replaying the store's listing.
    const vm = new RunViewModel(store);
    const steps = await countMapSteps(() => vm.hydrate());

    expect(steps, 'hydrating scanned the whole tab index once per run').toBeLessThanOrEqual(HYDRATION_RUNS * MAP_STEPS_PER_RUN_BOUND);

    // The controls. A bound is worth nothing if the index it made cheap is now wrong: every tab is
    // still labelled with the run that attached it, every run still lists its own, and a tab no run
    // ever attached is still the human's — law 4's refusal reads the same index.
    for (const [tabId, runId] of owners) expect(vm.ownerOf(tabId)).toBe(runId);
    const first = store.facts.keys().next().value!;
    expect(vm.tabsOf(first)).toEqual(['tab-0-0', 'tab-0-1']);
    expect(vm.isUserTab('tab-0-0')).toBe(false);
    expect(vm.userTabs(['tab-0-0', 'human-1'])).toEqual(['human-1']);
  });

  /**
   * The one shape a reverse index adds a way to get wrong. `attachTab` refuses a tab another run owns,
   * so this only ever arrives as a fact already in a log — and when it does, the owner has to be the
   * same run after the second replay as after the first. A clear driven by the wrong run's entries
   * would unown a live tab here, which is law 4's refusal firing on a fact that is not in any log.
   */
  it('moves both directions together when a log hands a tab to a second run', async () => {
    const store = new FakeRunStore();
    const a = await store.createRun({ task: 'first' });
    const b = await store.createRun({ task: 'second' });
    const attach: RunEventInput = { actor: { kind: 'agent', driver: 'studio' }, type: 'tab.attached', payload: { tabId: 'tab-x' } };
    await store.appendEvent(a.id, attach);
    await store.appendEvent(b.id, attach);

    const vm = new RunViewModel(store);
    await vm.hydrate();
    expect(vm.ownerOf('tab-x')).toBe(b.id);

    // A second replay of the same pair of logs: the same facts fold to the same owner, and the run
    // that lost the tab does not take it back on the way through.
    await vm.hydrate();
    expect(vm.ownerOf('tab-x')).toBe(b.id);
    expect(vm.isUserTab('tab-x')).toBe(false);
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
      runs: { listLive: () => vm.listLive(), onChange: (cb) => vm.onChange(cb) },
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
