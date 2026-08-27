import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_LIST_LIMIT, type ListRunsOptions, type Run, type RunEvent } from 'wigolo/studio';
import {
  LIVE_EVICTION_SLACK,
  MAX_BOOT_HYDRATION_RUNS,
  MAX_RETAINED_LIVE_RUNS,
  MAX_RETAINED_SEALED_RUNS,
  REMATERIALIZE_MAX_EVENTS,
  RunViewModel,
  SEALED_EVICTION_SLACK,
  type RunLogPage,
} from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';

/** The real ceiling on retained sealed runs: the bound plus the slack the batched cut leaves. */
const CEILING = MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK;
/** …and the same for the live set, which is the other half of the bound. */
const LIVE_CEILING = MAX_RETAINED_LIVE_RUNS + LIVE_EVICTION_SLACK;

/**
 * SD1 exit-16 — what this projection host RETAINS, and what it walks to answer a fan-out.
 *
 * `seal` bounded what a finished run costs (its envelopes go, its projection stays) and left the
 * COUNT unbounded: there was no `logs.delete`, no `statusRereads.delete` and no `clear` anywhere in
 * the class, runs are never deleted, and `hydrate` deliberately keeps runs a later listing did not
 * name. So every map here gained one entry per run the machine had ever run and gave none of it back
 * for the life of the app — and every walk over `logs` was charged for all of them, three times per
 * fan-out, at up to 60 Hz, on the thread that paints.
 */

/** Roughly what a real task line costs, so a retained run is a realistic size rather than a stub. */
const TASK = 'reconcile the october invoices against the ledger export and flag anything over 2%';

async function seedTerminal(vm: RunViewModel, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const run = await vm.createRun({ task: `${TASK} #${i}` });
    await vm.endRun(run.id, 'completed');
    ids.push(run.id);
  }
  return ids;
}

describe('RunViewModel — retention is bounded by the runs a surface can reach, not by the machine’s lifetime', () => {
  // The claim used to be "keeps every LIVE one", and that was the gap rather than the guarantee: a run
  // that never reaches a terminal event never enters `sealed`, so this bound could not reach it and
  // nothing else tried. `MAX_RETAINED_LIVE_RUNS` is the other arm; what this one still promises is that
  // it never drops a live run to make room for a finished one.
  it('drops terminal, unwatched, sealed runs past the bound, and never cuts a live one to make room', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const finished = await seedTerminal(vm, CEILING + 250);
    const live = await vm.createRun({ task: 'still going' });

    // The bound, counted. On the tip this was `finished.length + 1` and rose forever.
    expect(vm.retainedRunCount(), 'retention is a function of the lifetime run count again')
      .toBeLessThanOrEqual(CEILING + 1);
    expect(vm.retainedRunCount(), 'the bound cut deeper than it promises, so a history read lost runs it should hold')
      .toBeGreaterThanOrEqual(MAX_RETAINED_SEALED_RUNS);

    // Oldest go first, and the live one is never a candidate whatever its age.
    expect(vm.snapshot(finished[0]!), 'the oldest finished run survived the bound').toBeUndefined();
    expect(vm.snapshot(finished.at(-1)!)?.status, 'the newest finished run was evicted before the oldest').toBe('done');
    expect(vm.snapshot(live.id)?.status).toBe('running');
    expect(vm.listLive().map((r) => r.id), 'the live run was lost with the finished ones').toEqual([live.id]);
  });

  it('keeps the most recently BORN finished runs when boot hands them over newest-first', async () => {
    // The order this process files a run in is not the order it was born in, and the difference is not
    // academic: `hydrate` pages the listing NEWEST-FIRST, so an eviction that dropped the
    // least-recently-filed run would keep the machine's oldest finished runs and evict everything a
    // human might still be looking for — the exact inverse of the intent, invisible to any assertion
    // about the COUNT.
    const store = new FakeRunStore();
    const ids: string[] = [];
    for (let i = 0; i < CEILING + 200; i++) {
      const run = await store.createRun({ task: `${TASK} #${i}` });
      await store.appendEvent(run.id, { actor: { kind: 'system' }, type: 'run.completed', payload: {} });
      ids.push(run.id);
    }

    // A fresh projection, hydrating the whole corpus the way boot does — the listing is newest-first.
    const vm = new RunViewModel(store);
    await vm.hydrate();

    // Boot ends with a cut that takes no slack, so this is the bound exactly.
    expect(vm.retainedRunCount()).toBe(MAX_RETAINED_SEALED_RUNS);
    expect(vm.snapshot(ids.at(-1)!)?.status, 'the NEWEST finished run on the machine was evicted').toBe('done');
    expect(vm.snapshot(ids[0]!), 'the oldest finished run on the machine survived').toBeUndefined();
  });

  it('re-adopts an evicted run from the store when a later envelope arrives for it', async () => {
    // The eviction is safe BECAUSE this path exists: a dropped run is not a forgotten one, it is one
    // this process reads again if anything ever asks. Same arm `applyEvent` already takes for a run
    // created by another writer.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const finished = await seedTerminal(vm, CEILING + 1);
    const evicted = finished[0]!;
    expect(vm.snapshot(evicted)).toBeUndefined();

    // An envelope for a run this process is no longer holding. `presentation.demoted` is a legal write
    // to a finished run — it is what a boot reconcile does to one that ended while it was watched.
    await store.appendEvent(evicted, { actor: { kind: 'system' }, type: 'presentation.demoted', payload: { by: 'system' } });
    await new Promise((r) => { setTimeout(r, 0); });

    const back = vm.snapshot(evicted);
    expect(back?.status, 'the evicted run came back as something other than what the log says').toBe('done');
    expect(back?.task).toBe(`${TASK} #0`);
  });

  it('never evicts a run that still owns a tab, whatever the bound says', async () => {
    // Law 4 outranks the bound: dropping the run drops its rows from the tab index too, and a tab
    // with no owner is the human's. A terminal run holding a page is a state only a foreign writer
    // can produce — the app's own `endRun` releases first — so it is the one that has to be pinned.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const holder = await store.createRun({ task: 'ended still holding a page' });
    await store.appendEvent(holder.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-held' } });
    await store.appendEvent(holder.id, { actor: { kind: 'system' }, type: 'run.completed', payload: {} });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(vm.ownerOf('tab-held')).toBe(holder.id);

    await seedTerminal(vm, CEILING + 50);

    expect(vm.snapshot(holder.id)?.status, 'a run holding a page was evicted by the retention bound').toBe('done');
    expect(vm.ownerOf('tab-held'), 'the tab silently became the human’s when its run was evicted').toBe(holder.id);
    expect(vm.isUserTab('tab-held')).toBe(false);
  });

  it('drops the per-run rows the log is not the only one of', async () => {
    // `statusRereads`, the memo, the session link and any owed retry are all keyed by run id. A bound
    // that dropped the log alone would have moved the leak rather than closed it, and nothing about
    // the resulting projection would say so — which is why the session link is the one asserted: it
    // is the only one of the four with a public reader.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const first = await store.createRun({ task: 'the linked one', sessionId: 'sess-evicted' });
    await store.appendEvent(first.id, { actor: { kind: 'system' }, type: 'run.completed', payload: {} });
    await new Promise((r) => { setTimeout(r, 0); });
    expect(vm.runForSession('sess-evicted')).toBe(first.id);

    await seedTerminal(vm, CEILING + 5);

    expect(vm.snapshot(first.id)).toBeUndefined();
    expect(vm.runForSession('sess-evicted'), 'the session index kept pointing at an evicted run').toBeUndefined();
  });
});

/**
 * A run created the way the REST surface creates one: on the STORE, never through this projection, and
 * with its `run.created` as the only envelope anything will ever append to it.
 *
 * Not a contrived shape — `ADOPT_RETRY_BASE_MS`'s note is entirely about it, and a force-quit past the
 * shutdown deadline produces the same thing from the other end, a log whose terminal append was
 * truncated with no reaper behind it. Either way the run is permanently `running`.
 */
async function seedNeverTerminal(store: FakeRunStore, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push((await store.createRun({ task: `${TASK} #${i}` })).id);
  return ids;
}

/** Let every adoption `applyEvent`'s unknown-run arm started actually finish. */
async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => { setTimeout(r, 0); });
}

/**
 * SD1 exit-17 — the population `MAX_RETAINED_SEALED_RUNS` could not reach.
 *
 * Sealing is what makes a run a candidate for the sealed bound, and a run is sealed only once a
 * TERMINAL envelope has been folded for it. A REST-created run never gets one; neither does a run whose
 * terminal append was truncated by a force-quit. So `reindex` filed both in `live` and nothing ever took
 * them out: `live` and `logs` grew with the machine's lifetime population of them, `hydrate` reloaded
 * every one at each boot with no status filter, and the three fan-out listeners walked the whole set at
 * up to one fan-out per frame on the thread that paints. Narrowing `listLive` to `live` was worth
 * nothing here, because a run that never terminates never leaves `live`.
 */
describe('RunViewModel — a run that never terminates is bounded too', () => {
  it('cuts a boot-hydrated corpus of never-terminal runs to the bound, counted before and after', async () => {
    const store = new FakeRunStore();
    const ids = await seedNeverTerminal(store, LIVE_CEILING + 250);
    expect(store.facts.size, 'the fixture is not the population this arm is about').toBe(LIVE_CEILING + 250);

    const vm = new RunViewModel(store);
    expect(vm.retainedRunCount()).toBe(0);
    await vm.hydrate();

    // On the tip: 850, and rising by one for every run the machine ever starts. Boot's cut takes no
    // slack, so this is the bound exactly rather than the ceiling.
    expect(vm.retainedRunCount(), 'retention is a function of the lifetime never-terminal count')
      .toBe(MAX_RETAINED_LIVE_RUNS);
    expect(vm.listLive(), 'the surfaces render what is retained, so the two counts have to agree')
      .toHaveLength(MAX_RETAINED_LIVE_RUNS);

    // Newest-born survive, oldest-born go — the same order the sealed cut takes, and the one a history
    // read wants. Every survivor is still `running`: this is a bound on cost, not on facts.
    expect(vm.snapshot(ids.at(-1)!)?.status, 'the NEWEST never-terminal run was evicted').toBe('running');
    expect(vm.snapshot(ids[0]!), 'the oldest never-terminal run survived the bound').toBeUndefined();
    expect(vm.snapshot(ids.at(-1)!)?.task).toBe(`${TASK} #${ids.length - 1}`);
  });

  it('cuts the same corpus when it arrives one live envelope at a time instead of at boot', async () => {
    // The other producer, and the one no hydration bound can help with: each run reaches this
    // projection through `applyEvent`'s unknown-run arm, one adoption at a time, for the life of the
    // app. A bound that only fired at boot would leave the app growing all day and look fixed.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    const ids: string[] = [];
    for (let i = 0; i < LIVE_CEILING + 250; i++) {
      ids.push((await store.createRun({ task: `${TASK} #${i}` })).id);
      await new Promise((r) => { setTimeout(r, 0); });
    }
    await settle();

    expect(vm.retainedRunCount(), 'live adoption re-bought the retention boot no longer has')
      .toBeLessThanOrEqual(LIVE_CEILING);
    expect(vm.retainedRunCount(), 'the cut went deeper than the bound it promises')
      .toBeGreaterThanOrEqual(MAX_RETAINED_LIVE_RUNS);
    // Eviction is by the run's own BIRTH, so which runs survive does not depend on the order the
    // adoptions happened to land in.
    expect(vm.snapshot(ids.at(-1)!)?.status).toBe('running');
    expect(vm.snapshot(ids[0]!)).toBeUndefined();
  });

  it('never evicts a never-terminal run that owns a tab, whatever the bound says', async () => {
    // Law 4, and the exemption that matters most for THIS population: an agent's run is exactly the
    // one that holds a page and has not ended yet. Dropping it drops its rows from the tab index, and
    // a tab with no owner is the human's.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const holder = await store.createRun({ task: 'driving a page and still going' });
    await store.appendEvent(holder.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-driven' } });
    await settle();
    expect(vm.ownerOf('tab-driven')).toBe(holder.id);

    await seedNeverTerminal(store, LIVE_CEILING + 50);
    await settle();

    expect(vm.snapshot(holder.id)?.status, 'the oldest run on the machine was evicted while driving a page').toBe('running');
    expect(vm.ownerOf('tab-driven'), 'the tab silently became the human’s when its run was evicted').toBe(holder.id);
    expect(vm.isUserTab('tab-driven')).toBe(false);
  });

  it('never evicts a run the human is watching, whatever the bound says', async () => {
    // `run-presentation` decides whether the window is shown by asking `listLive` whether any run is
    // visible. Evicting a promoted run therefore closes the window over a run that is still going —
    // and nothing brings it back, because the run class this bound is about emits no further envelope.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const watched = await vm.createRun({ task: 'promoted and still going' });
    await vm.setVisibility(watched.id, 'visible', 'human');

    await seedNeverTerminal(store, LIVE_CEILING + 50);
    await settle();

    expect(vm.snapshot(watched.id)?.visibility, 'the run on screen was evicted by the retention bound').toBe('visible');
    expect(vm.listLive().map((r) => r.id), 'the window would have been closed over a live run').toContain(watched.id);
  });

  it('re-adopts an evicted never-terminal run when a later envelope arrives for it', async () => {
    // Same safety the sealed cut relies on: a dropped run is not a forgotten one. Worth pinning
    // separately here because the run is NOT terminal, so it comes back through the arm that has to
    // rebuild a live projection rather than a finished one.
    const store = new FakeRunStore();
    const ids = await seedNeverTerminal(store, LIVE_CEILING + 1);
    const vm = new RunViewModel(store);
    await vm.hydrate();

    const evicted = ids[0]!;
    expect(vm.snapshot(evicted)).toBeUndefined();

    await store.appendEvent(evicted, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await settle();

    const back = vm.snapshot(evicted);
    expect(back?.status, 'the evicted run came back as something other than what the log says').toBe('running');
    expect(back?.task).toBe(`${TASK} #0`);
    expect(back?.cost.browserActions).toBe(1);
  });

  it('answers runForDecision from a bounded walk, not from the lifetime population', async () => {
    // `runForDecision` walks every run this process retains. It skips terminal ones cheaply, and that
    // skip cannot fire for a run that never terminates — which is the class the walk was most likely to
    // be full of. It is bounded now because `logs` is, so the bound is asserted where it comes from.
    const store = new FakeRunStore();
    await seedNeverTerminal(store, LIVE_CEILING + 400);
    const vm = new RunViewModel(store);
    await vm.hydrate();

    const asking = await vm.createRun({ task: 'the one with a card open' });
    await vm.requestDecision(asking.id, { decisionId: 'd-1', kind: 'approval', prompt: 'may I?' });

    const visited = vi.spyOn(vm, 'snapshot');
    expect(vm.runForDecision('d-1')).toBe(asking.id);
    expect(visited.mock.calls.length, 'the decision walk grew with the lifetime never-terminal count')
      .toBeLessThanOrEqual(MAX_RETAINED_LIVE_RUNS + 1);
    visited.mockRestore();

    expect(vm.runForDecision('d-nobody')).toBeUndefined();
  });
});

/**
 * The boot half: what a hydration READS, which is a different bound from what it retains.
 *
 * `hydrateProjectionPage` was a bare `store.listRuns` with no charge of any kind, and the loop that
 * calls it stopped only at `MAX_HYDRATION_PAGES` — 200 pages of `DEFAULT_LIST_LIMIT`, so ten thousand
 * runs. Every one of those pages fully projects `limit + 1` runs in the child that serialises every
 * other read during boot, and K-82-1 measured one 50-run page of it at 1,109 ms. The branch that exists
 * to be the cheap one was the only unmetered call in the loop.
 */
describe('RunViewModel — boot reads a bounded number of listing pages', () => {
  /** Enough pages behind the bound that a boot which ignored it is unmistakable. */
  const CORPUS = MAX_BOOT_HYDRATION_RUNS + 400;
  const listCalls = (store: FakeRunStore): number => store.reads.filter((r) => r === 'listRuns').length;

  it('stops taking listing pages once it has read what retention can hold', async () => {
    const store = new FakeRunStore();
    store.listLimit = DEFAULT_LIST_LIMIT;
    await seedNeverTerminal(store, CORPUS);

    const vm = new RunViewModel(store);
    // Forced onto the projection branch from the first page: no envelope allowance at all, which is
    // the state an ordinary boot reaches partway through a large machine.
    await vm.hydrate({ eventBudget: 0 });

    // On the tip: every page the store would hand over, because nothing counted the runs.
    expect(listCalls(store), 'boot paged past what it is willing to keep')
      .toBe(MAX_BOOT_HYDRATION_RUNS / DEFAULT_LIST_LIMIT);
    expect(listCalls(store), 'the fixture had no pages left to refuse, so the bound proves nothing')
      .toBeLessThan(CORPUS / DEFAULT_LIST_LIMIT);
    // Read bounded, and retained bounded — two different numbers, both of them bounds.
    expect(vm.retainedRunCount()).toBe(MAX_RETAINED_LIVE_RUNS);
  });

  it('stops sooner when the store reports the projections are expensive to read', async () => {
    // The charge, and what it is for: a page whose runs each cost the store ten thousand characters is
    // not the same page as one whose runs cost nothing, and the answer's own size cannot tell them
    // apart — a projection is small precisely because it folded the expensive rows away.
    const store = new FakeRunStore();
    store.listLimit = DEFAULT_LIST_LIMIT;
    store.listProjectionCharsPerRun = 10_000;
    await seedNeverTerminal(store, CORPUS);

    const vm = new RunViewModel(store);
    // Exactly two pages' worth of reported spend.
    await vm.hydrate({ eventBudget: 0, projectionCharBudget: 2 * DEFAULT_LIST_LIMIT * 10_000 });

    expect(listCalls(store), 'the reported spend moved nothing, so the branch is still free').toBe(2);
    expect(store.listRunsChars, 'the host charged something other than what the store reported reading')
      .toBe(2 * DEFAULT_LIST_LIMIT * 10_000);
    expect(vm.retainedRunCount()).toBe(2 * DEFAULT_LIST_LIMIT);
  });

  it('charges what the store says it read, not what the answer shipped', async () => {
    // The distinction the whole meter exists for. Same corpus, same allowance, and the only difference
    // is that this store reports nothing: the host then falls back to the size of what arrived, which
    // is honest for a binding with no meter and much smaller for the same reads — so it buys more
    // pages, and the two arms cannot both be explained by the page count alone.
    const store = new FakeRunStore();
    store.listLimit = DEFAULT_LIST_LIMIT;
    store.listProjectionCharsPerRun = 10_000;
    await seedNeverTerminal(store, CORPUS);
    const metered = new RunViewModel(store);
    await metered.hydrate({ eventBudget: 0, projectionCharBudget: 4 * DEFAULT_LIST_LIMIT * 10_000 });
    const meteredPages = listCalls(store);

    const silent = new FakeRunStore();
    silent.listLimit = DEFAULT_LIST_LIMIT;
    // A binding with no meter at all — the port allows one, so the fallback has to be reachable.
    silent.reportsListChars = false;
    await seedNeverTerminal(silent, CORPUS);
    const unmetered = new RunViewModel(silent);
    await unmetered.hydrate({ eventBudget: 0, projectionCharBudget: 4 * DEFAULT_LIST_LIMIT * 10_000 });

    expect(meteredPages).toBe(4);
    expect(listCalls(silent), 'the fallback charged as much as the read, so the two are indistinguishable')
      .toBeGreaterThan(meteredPages);
    // …and still bounded, by the other half. The fallback is a floor on the charge, never a way out of
    // the loop's bounds.
    expect(listCalls(silent)).toBeLessThanOrEqual(MAX_BOOT_HYDRATION_RUNS / DEFAULT_LIST_LIMIT);
    expect(listCalls(silent), 'the fallback charged nothing at all, so a store with no meter is free')
      .toBeGreaterThan(0);
  });
});

/**
 * A store whose kept projections COUNT the reads of their own status.
 *
 * `listLive` narrows with `isListable`, which reads `status` first — so "did the walk visit this run"
 * is observable without a stopwatch, and observable per run. Every entry is answered with a
 * projection in place of its envelopes, which is the shape the boot read already produces for a log
 * too large for one frame, so the runs land condensed and their `kept` IS one of these objects.
 */
class CountingProjectionStore extends FakeRunStore {
  statusReads = 0;
  /**
   * WHICH runs a fan-out touched, not just how many touches it made.
   *
   * A count conflates "visited twice as many runs" with "asked the same run twice", and the claim
   * below is about the width of the WALK. The set answers it directly and without a per-read constant
   * standing in for the reader's internals.
   */
  readonly statusReadRuns = new Set<string>();
  /**
   * Count a run whatever its status. Off by default because the arm above is specifically about
   * `listLive` not touching FINISHED runs, and counting the live one would turn its bound into a
   * number rather than a claim.
   */
  countLive = false;

  override async listRunLogs(opts: ListRunsOptions = {}): Promise<RunLogPage> {
    const page = await super.listRunLogs(opts);
    const entries = await Promise.all(
      page.entries.map(async (entry) => ({
        facts: entry.facts,
        events: [],
        lastSeq: entry.lastSeq,
        projection: this.counted((await this.getRun(entry.facts.id))!),
      })),
    );
    return { ...page, entries };
  }

  /**
   * Only a FINISHED run's projection counts, because only a finished run is one `listLive` has no
   * business touching. A live run's projection is read on every fan-out by design — it is the answer
   * — so counting it would make the bound below a number rather than a claim.
   */
  private counted(base: Run): Run {
    const terminal = base.status === 'done' || base.status === 'failed' || base.status === 'cancelled';
    if (!terminal && !this.countLive) return base;
    const self = this;
    return {
      ...base,
      get status(): Run['status'] {
        self.statusReads++;
        self.statusReadRuns.add(base.id);
        return base.status;
      },
    };
  }
}

describe('RunViewModel — listLive walks what it answers with, not everything retained', () => {
  it('does not touch a finished run’s projection on a fan-out', async () => {
    // Three listeners call `listLive` on every fan-out — the state push, the tray menu and the
    // presentation controller — and the walk was over `logs`. So the cost of watching one live run
    // was a function of how many runs had finished beside it, paid on the thread that paints.
    const store = new CountingProjectionStore();
    for (let i = 0; i < 200; i++) {
      const run = await store.createRun({ task: `${TASK} #${i}` });
      await store.appendEvent(run.id, { actor: { kind: 'system' }, type: 'run.completed', payload: {} });
    }
    const live = await store.createRun({ task: 'the one anybody is looking at' });

    const vm = new RunViewModel(store);
    await vm.hydrate();
    expect(vm.retainedRunCount(), 'the fixture did not retain the finished runs it is about').toBe(201);

    // Everything before this is the boot filing each run once. What is counted is the FAN-OUT.
    store.statusReads = 0;
    for (let fanOut = 0; fanOut < 10; fanOut++) expect(vm.listLive().map((r) => r.id)).toEqual([live.id]);

    // On the tip this was 200 per fan-out — 2,000 across ten — because `isListable(log.kept)` was
    // asked of every retained run before it could be skipped.
    expect(store.statusReads, 'a fan-out still reads every finished run this process retains').toBe(0);
  });

  it('visits a page of runs on a fan-out however many never-terminal ones the machine has', async () => {
    // The same claim for the population the sealed bound could not reach, and the reason the narrowing
    // to `live` was not enough on its own: `isListable` re-opens on nothing a never-terminal run can
    // fail, so such a run enters the walk and never leaves it. Three times the ceiling on the machine,
    // and the walk has to cost the ceiling — the state push, the tray and the presentation controller
    // each pay it, at up to one fan-out per frame, on the thread that paints.
    const store = new CountingProjectionStore();
    store.countLive = true;
    const ids = await seedNeverTerminal(store, LIVE_CEILING * 3);

    const vm = new RunViewModel(store);
    await vm.hydrate();
    expect(store.facts.size, 'the machine’s lifetime population is not what this arm is about').toBe(LIVE_CEILING * 3);
    expect(vm.retainedRunCount()).toBe(MAX_RETAINED_LIVE_RUNS);

    // Everything before this is boot filing each run. What is counted is the FAN-OUT.
    store.statusReads = 0;
    store.statusReadRuns.clear();
    for (let fanOut = 0; fanOut < 10; fanOut++) {
      expect(vm.listLive(), 'the walk answered with something other than what it retains').toHaveLength(MAX_RETAINED_LIVE_RUNS);
    }

    // On the tip: 1,800 distinct runs per fan-out, because every one of them was retained and none of
    // them could ever leave the live set.
    expect(store.statusReadRuns.size, 'the fan-out walked the lifetime never-terminal population')
      .toBeLessThanOrEqual(MAX_RETAINED_LIVE_RUNS);
    // The control: a walk that stopped happening would satisfy the bound vacuously, and the survivors
    // are still the newest-born rather than an arbitrary five hundred.
    expect(store.statusReadRuns.size).toBeGreaterThan(0);
    expect(store.statusReadRuns.has(ids.at(-1)!), 'the newest run on the machine was not in the walk').toBe(true);
  });

  it('drops a run from the walk the first time it is seen to have finished, and answers the same either way', async () => {
    // The candidate set is pruned on the READ rather than at the fold that made a run non-listable.
    // That is only sound because a candidate can go stale in one direction: `isListable` re-opens on
    // `visibility === 'visible'`, and `applyVisibility` refuses to promote a run that has ended.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const a = await vm.createRun({ task: 'first' });
    const b = await vm.createRun({ task: 'second' });
    expect(vm.listLive().map((r) => r.id)).toEqual([a.id, b.id]);

    await vm.endRun(a.id, 'completed');
    expect(vm.listLive().map((r) => r.id)).toEqual([b.id]);
    expect(vm.listLive().map((r) => r.id), 'the second read disagreed with the first').toEqual([b.id]);

    // A finished run that is still on screen is still listable, so it must survive the prune — it is
    // the one the human needs an affordance to send away.
    const watched = await vm.createRun({ task: 'on screen' });
    await vm.setVisibility(watched.id, 'visible', 'human');
    await vm.endRun(watched.id, 'completed');
    expect(vm.listLive().map((r) => r.id)).toEqual([b.id, watched.id]);
    await vm.setVisibility(watched.id, 'hidden', 'human');
    expect(vm.listLive().map((r) => r.id), 'a demoted finished run stayed in the live set').toEqual([b.id]);
  });

  it('answers runForSession from the link the log carries, for a run buried behind many others', async () => {
    // The second O(lifetime runs) scan: `runForSession` walked every run this process held and asked
    // each for its link, once per session per `studio_list` and on every approval notice.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const wanted = await store.createRun({ task: 'the session’s run', sessionId: 'sess-1' });
    await new Promise((r) => { setTimeout(r, 0); });
    await seedTerminal(vm, 50);

    expect(vm.runForSession('sess-1')).toBe(wanted.id);
    expect(vm.runForSession('sess-nobody')).toBeUndefined();
    expect(vm.sessionIdOf(wanted.id)).toBe('sess-1');
  });

  it('keeps the FIRST run holding a session link, the way the scan it replaces did', async () => {
    // The scan returned the first run in insertion order, so a second run reusing one session never
    // shadowed the first. An index that took the last writer would have changed that answer silently.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);

    const first = await store.createRun({ task: 'first on this session', sessionId: 'sess-shared' });
    await new Promise((r) => { setTimeout(r, 0); });
    await store.createRun({ task: 'second on this session', sessionId: 'sess-shared' });
    await new Promise((r) => { setTimeout(r, 0); });

    expect(vm.runForSession('sess-shared')).toBe(first.id);
  });
});

/**
 * The unknown-run adoption path, which had no bound at all.
 *
 * `overBound` opens `if (!log) return false`, so it can only speak for a run this process is already
 * holding — which means `replayOnce`'s short-circuit was never available on the one path that reaches
 * it for a run it is not: `applyEvent`'s unknown-run arm, taken for every run created over REST or by
 * another writer. That path read the ENTIRE log with no total cap and `retain` stored every envelope
 * of it. The live-run bound then fired only on the NEXT envelope, so a long run that went quiet after
 * being adopted held its whole log for as long as it stayed quiet.
 */
describe('RunViewModel — adopting an unknown run retains at most the condensation bound', () => {
  it('condenses a 2,501-envelope unknown run immediately, not on its next envelope', async () => {
    const store = new FakeRunStore();
    const run = await store.createRun({ task: 'long and then quiet' });
    // Built BEFORE the projection exists, which is what makes the run unknown to it — the same state
    // a REST-created run is in, at a length the fold bound is about.
    for (let i = 0; i < REMATERIALIZE_MAX_EVENTS + 499; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    expect(store.log.get(run.id)!.length).toBe(2_500);

    const vm = new RunViewModel(store);
    // One envelope, for a run this projection has never seen. This is the whole trigger.
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await new Promise((r) => { setTimeout(r, 0); });
    await new Promise((r) => { setTimeout(r, 0); });

    // On the tip: 2,501, held until some later envelope happened to condense them.
    expect(vm.retainedEventCount(run.id), 'the whole log was retained by the unknown-run adoption')
      .toBeLessThanOrEqual(REMATERIALIZE_MAX_EVENTS);
    // …and the answer is unchanged, which is what makes this a bound on cost rather than on facts.
    expect(vm.snapshot(run.id)?.task).toBe('long and then quiet');
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(2_500);
    expect(vm.lastSeqOf(run.id), 'the store’s tail was lost, so the next envelope reads as a hole').toBe(2_501);
  });

  it('stops PAGING the log once it is past the bound, rather than reading it all and discarding it', async () => {
    // Skipping the retention alone would still have paged and parsed the whole log, and the frame is
    // what blocks the thread that paints. Counted in envelopes read, because a page count cannot tell
    // "stopped early" from "the store had fewer pages".
    const store = new FakeRunStore();
    const run = await store.createRun({ task: 'very long' });
    for (let i = 0; i < 6_000; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }

    const vm = new RunViewModel(store);
    store.eventReads.length = 0;
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await new Promise((r) => { setTimeout(r, 0); });
    await new Promise((r) => { setTimeout(r, 0); });

    // Each page is `REPLAY_PAGE_SIZE`, so the read stops within one page of the bound. On the tip it
    // walked all 6,001.
    const readFrom = store.eventReads.filter((r) => r.runId === run.id);
    expect(readFrom.length, 'the unknown-run read paged the whole log').toBeLessThan(REMATERIALIZE_MAX_EVENTS / 500 + 2);
    expect(vm.retainedEventCount(run.id)).toBe(0);
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(6_001);
  });

  it('still materializes a short unknown run, so it can fold its next envelope for free', async () => {
    // The bound is on length, never on how a run was first seen — a short adopted run holds its
    // envelopes exactly as one created here does. The control for the two arms above.
    const store = new FakeRunStore();
    const run = await store.createRun({ task: 'short' });
    for (let i = 0; i < 5; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }

    const vm = new RunViewModel(store);
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await new Promise((r) => { setTimeout(r, 0); });
    await new Promise((r) => { setTimeout(r, 0); });

    expect(vm.retainedEventCount(run.id), 'a short unknown run was condensed by a bound that is about long ones').toBe(7);
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(6);
  });
});

/**
 * The fold path's seq shape guard — hardening, unreachable at the tip.
 *
 * A `run-event` notify envelope is JSON cast to `RunEvent` with nothing between the wire and the
 * cast. `seq === undefined` passes BOTH comparisons in `applyEvent` — `undefined <= n` and
 * `undefined > n + 1` are each false — so it folded, and `log.lastSeq = event.seq` then set the tail
 * to `undefined`. Every later comparison against `undefined` is false too, so no gap can ever open
 * for that run again: gap detection is dead, silently, with no path that self-heals.
 */
describe('RunViewModel — an envelope with no usable seq is replayed, never folded', () => {
  it('leaves the tail an integer and keeps gap detection alive', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    const run = await vm.createRun({ task: 'fed a malformed envelope' });
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    expect(vm.lastSeqOf(run.id)).toBe(2);

    const malformed = {
      ts: new Date().toISOString(),
      actor: { kind: 'agent' as const },
      type: 'cost.recorded',
      payload: { kind: 'browser_action', amount: 1 },
    } as unknown as RunEvent;
    vm.applyEvent(run.id, malformed);
    await new Promise((r) => { setTimeout(r, 0); });

    // On the tip the tail was `undefined` here, and the run's cost had been double-counted.
    expect(Number.isInteger(vm.lastSeqOf(run.id)), 'the tail was set from an envelope with no seq').toBe(true);
    expect(vm.lastSeqOf(run.id)).toBe(2);
    expect(vm.snapshot(run.id)?.cost.browserActions, 'the malformed envelope was folded in').toBe(1);

    // The state that used to be unreachable afterwards: a genuine gap still replays. Appended
    // straight to the store's log so the notify carries a seq this projection has not folded.
    const events = store.log.get(run.id)!;
    events.push({ seq: 3, ts: new Date().toISOString(), actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await new Promise((r) => { setTimeout(r, 0); });
    await new Promise((r) => { setTimeout(r, 0); });

    expect(vm.lastSeqOf(run.id), 'the gap was never noticed, so the missed envelope was never replayed').toBe(4);
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(3);
  });

  it('re-reads the run rather than dropping the envelope on the floor', async () => {
    // Routed to a replace-adoption because an envelope this process cannot PLACE is exactly the case
    // a full re-read answers. Dropping it would leave the projection behind a log that has moved.
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    const run = await vm.createRun({ task: 'malformed while behind' });

    // The store is two envelopes ahead of this projection, and the one that announces it has no seq.
    const events = store.log.get(run.id)!;
    for (const seq of [2, 3]) {
      events.push({ seq, ts: new Date().toISOString(), actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    vm.applyEvent(run.id, { ts: new Date().toISOString(), actor: { kind: 'agent' }, type: 'cost.recorded', payload: {} } as unknown as RunEvent);
    await new Promise((r) => { setTimeout(r, 0); });
    await new Promise((r) => { setTimeout(r, 0); });

    expect(vm.lastSeqOf(run.id), 'the malformed envelope was dropped instead of replaying the run').toBe(3);
    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(2);
  });
});
