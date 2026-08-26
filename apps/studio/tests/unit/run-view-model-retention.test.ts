import { describe, it, expect } from 'vitest';
import type { ListRunsOptions, Run, RunEvent } from 'wigolo/studio';
import {
  MAX_RETAINED_SEALED_RUNS,
  REMATERIALIZE_MAX_EVENTS,
  RunViewModel,
  SEALED_EVICTION_SLACK,
  type RunLogPage,
} from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';

/** The real ceiling on retained sealed runs: the bound plus the slack the batched cut leaves. */
const CEILING = MAX_RETAINED_SEALED_RUNS + SEALED_EVICTION_SLACK;

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
  it('drops terminal, unwatched, sealed runs past the bound, and keeps every live one', async () => {
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
 * A store whose kept projections COUNT the reads of their own status.
 *
 * `listLive` narrows with `isListable`, which reads `status` first — so "did the walk visit this run"
 * is observable without a stopwatch, and observable per run. Every entry is answered with a
 * projection in place of its envelopes, which is the shape the boot read already produces for a log
 * too large for one frame, so the runs land condensed and their `kept` IS one of these objects.
 */
class CountingProjectionStore extends FakeRunStore {
  statusReads = 0;

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
    if (base.status !== 'done' && base.status !== 'failed' && base.status !== 'cancelled') return base;
    const self = this;
    return {
      ...base,
      get status(): Run['status'] {
        self.statusReads++;
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
