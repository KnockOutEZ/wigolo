import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunViewModel, TabOwnedError, type RunStoreClient } from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';

describe('RunViewModel — tab↔run ownership is the run log, not registry state', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
  });

  it('records an attach as a tab.attached event on the run, carrying the tab id', async () => {
    const run = await vm.createRun({ task: 'buy milk' });
    await vm.attachTab(run.id, 'tab-a', 'https://example.com/');

    expect(store.appends).toEqual([
      { runId: run.id, type: 'tab.attached', payload: { tabId: 'tab-a', url: 'https://example.com/' } },
    ]);
    expect(vm.ownerOf('tab-a')).toBe(run.id);
    expect(vm.tabsOf(run.id)).toEqual(['tab-a']);
  });

  // Law 4: a tab belongs to exactly ONE run. Two agents never share a tab. Enforced at this seam so no
  // caller can opt out of it, and REFUSED rather than reassigned — a silent steal is the failure mode.
  it('refuses to attach a tab that another run already owns, and writes no event', async () => {
    const a = await vm.createRun({ task: 'first' });
    const b = await vm.createRun({ task: 'second' });
    await vm.attachTab(a.id, 'tab-shared');
    store.appends.length = 0;

    await expect(vm.attachTab(b.id, 'tab-shared')).rejects.toBeInstanceOf(TabOwnedError);
    expect(store.appends).toEqual([]); // the refusal left the append-only log untouched
    expect(vm.ownerOf('tab-shared')).toBe(a.id); // and did not steal the tab
    expect(vm.tabsOf(b.id)).toEqual([]);
  });

  it('treats re-attaching a tab to the run that already owns it as a no-op, not a second event', async () => {
    const run = await vm.createRun({ task: 'idempotent' });
    await vm.attachTab(run.id, 'tab-a');
    store.appends.length = 0;

    await vm.attachTab(run.id, 'tab-a');
    expect(store.appends).toEqual([]);
    expect(vm.tabsOf(run.id)).toEqual(['tab-a']);
  });

  it('detaches as an event and frees the tab for a different run', async () => {
    const a = await vm.createRun({ task: 'first' });
    const b = await vm.createRun({ task: 'second' });
    await vm.attachTab(a.id, 'tab-a');
    await vm.detachTab('tab-a', 'closed');

    expect(store.appends.at(-1)).toEqual({ runId: a.id, type: 'tab.detached', payload: { tabId: 'tab-a', reason: 'closed' } });
    expect(vm.ownerOf('tab-a')).toBeUndefined();
    await expect(vm.attachTab(b.id, 'tab-a')).resolves.toBeUndefined();
    expect(vm.ownerOf('tab-a')).toBe(b.id);
  });

  it('writes nothing when a tab nobody owns is closed — a user tab is not a run event', async () => {
    await vm.createRun({ task: 'irrelevant' });
    store.appends.length = 0;
    await vm.detachTab('tab-the-human-opened', 'closed');
    expect(store.appends).toEqual([]);
  });
});

describe('RunViewModel — the user tab group', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
  });

  // Law 4's second half: the user's own tabs are a separate group, invisible to EVERY agent. The group is
  // defined by absence — a tab with no `tab.attached` event is the human's — so it needs no registry of
  // its own and cannot drift out of sync with one.
  it('never returns a tab the human opened from an agent-visible enumeration', async () => {
    const run = await vm.createRun({ task: 'agent work' });
    await vm.attachTab(run.id, 'tab-agent');
    const universe = ['tab-agent', 'tab-human-1', 'tab-human-2'];

    expect(vm.agentVisibleTabs(run.id, universe)).toEqual(['tab-agent']);
    expect(vm.userTabs(universe)).toEqual(['tab-human-1', 'tab-human-2']);
    expect(vm.isUserTab('tab-human-1')).toBe(true);
    expect(vm.isUserTab('tab-agent')).toBe(false);
  });

  it('hides one run’s tabs from another run’s enumeration', async () => {
    const a = await vm.createRun({ task: 'a' });
    const b = await vm.createRun({ task: 'b' });
    await vm.attachTab(a.id, 'tab-a');
    await vm.attachTab(b.id, 'tab-b');

    expect(vm.agentVisibleTabs(a.id, ['tab-a', 'tab-b'])).toEqual(['tab-a']);
    expect(vm.agentVisibleTabs(b.id, ['tab-a', 'tab-b'])).toEqual(['tab-b']);
  });

  it('returns nothing for a run id nobody minted, rather than falling back to every tab', async () => {
    const run = await vm.createRun({ task: 'a' });
    await vm.attachTab(run.id, 'tab-a');
    expect(vm.agentVisibleTabs('no-such-run', ['tab-a'])).toEqual([]);
  });
});

describe('RunViewModel — a projection, with nothing of its own to lose', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
  });

  // Law 1's acceptance test rather than its docstring: throw away everything the view-model holds, replay
  // the log, and the identical ownership comes back. Any run-like fact kept ONLY in the view-model — the
  // old `StudioSession.tabIds` array being exactly that — cannot survive this and reds the test.
  it('rebuilds identical ownership from the log alone after its memory is discarded', async () => {
    const a = await vm.createRun({ task: 'a' });
    const b = await vm.createRun({ task: 'b' });
    await vm.attachTab(a.id, 'tab-1');
    await vm.attachTab(a.id, 'tab-2');
    await vm.attachTab(b.id, 'tab-3');
    await vm.detachTab('tab-2', 'closed');
    const before = { a: vm.tabsOf(a.id), b: vm.tabsOf(b.id), owner: vm.ownerOf('tab-3') };

    const fresh = new RunViewModel(store);
    await fresh.hydrate();

    expect(fresh.tabsOf(a.id)).toEqual(before.a);
    expect(fresh.tabsOf(b.id)).toEqual(before.b);
    expect(fresh.ownerOf('tab-3')).toBe(before.owner);
    expect(fresh.tabsOf(a.id)).toEqual(['tab-1']); // the detach replayed too, not just the attaches
  });

  // `listRuns` is a snapshot. A run created after it was taken but before the replay finished used to be
  // wiped by the clear-then-refill, and would then stay invisible until it happened to emit again.
  it('keeps a run created while it was replaying, rather than discarding it with the old state', async () => {
    const slow = new FakeRunStore();
    const known = await slow.createRun({ task: 'already there' });
    const vm2 = new RunViewModel(slow);

    // The listing is a snapshot taken BEFORE the newcomer exists, and it lands after the newcomer is
    // registered — the exact interleaving a boot-time hydrate races a first `studio_open` into.
    const stale = await slow.listRunLogs();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    slow.listRunLogs = async () => { await gate; return stale; };

    const inFlight = vm2.hydrate();
    const newcomer = await vm2.createRun({ task: 'born mid-replay' });
    release();
    await inFlight;

    expect(vm2.list().map((r) => r.id).sort()).toEqual([known.id, newcomer.id].sort());
    expect(vm2.list().find((r) => r.id === known.id)?.task).toBe('already there');
  });

  it('picks up a tab another writer attached, off the live tail', async () => {
    const run = await vm.createRun({ task: 'a' });
    // Nothing the view-model called — a second writer on the same run, arriving as a broker notify.
    await store.appendEvent(run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-elsewhere' } });

    expect(vm.ownerOf('tab-elsewhere')).toBe(run.id);
  });

  // The broker notifies us about our OWN appends and a reconnecting tail replays, so the same envelope
  // arrives more than once as a matter of course. Counters are the honest probe: `tabIds` happens to
  // dedup inside the projection, but a re-applied `cost.recorded` silently bills the human twice.
  it('ignores a replayed envelope instead of double-counting it', async () => {
    const run = await vm.createRun({ task: 'a' });
    const spend = await store.appendEvent(run.id, {
      actor: { kind: 'agent', driver: 'studio' },
      type: 'cost.recorded',
      payload: { kind: 'browser_action', amount: 1 },
    });
    vm.applyEvent(run.id, spend); // the same envelope again, as a reconnecting tail would deliver
    vm.applyEvent(run.id, spend);

    expect(vm.snapshot(run.id)?.cost.browserActions).toBe(1);
  });

  // #46's REST surface creates runs in this same process. Waiting for the next `hydrate()` would mean
  // the chrome silently omitted them, and nothing calls hydrate after boot — so the projection adopts a
  // run it has never seen off the tail, replaying its WHOLE log rather than folding in the one envelope
  // that woke it. A run whose history starts at seq 4 has no owner for the tab attached at seq 2.
  it('adopts a run it has never seen off the live tail, replaying its whole history', async () => {
    const fresh = new FakeRunStore();
    const outsider = await fresh.createRun({ task: 'created behind our back' });
    await fresh.appendEvent(outsider.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-x' } });
    await fresh.appendEvent(outsider.id, { actor: { kind: 'daemon' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 3 } });

    // Constructed AFTER all of that and never hydrated: everything above is history it has not seen.
    const blind = new RunViewModel(fresh);
    expect(blind.list()).toEqual([]);
    await fresh.appendEvent(outsider.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-y' } });

    await vi.waitFor(() => expect(blind.list().map((r) => r.id)).toContain(outsider.id));
    expect(blind.ownerOf('tab-x'), 'the run was adopted from the waking envelope, not its log').toBe(outsider.id);
    expect(blind.ownerOf('tab-y')).toBe(outsider.id);
    expect(blind.snapshot(outsider.id)?.cost.browserActions).toBe(3);
    expect(blind.list()[0]!.task).toBe('created behind our back');
  });

  // A gap means an envelope was missed — during an adoption, or a dropped notify. Folding the newer one
  // in anyway would leave a log that silently disagrees with the store, so the run is replayed instead.
  it('re-replays a run rather than accepting a log with a hole in it', async () => {
    const run = await vm.createRun({ task: 'a' });
    await vm.attachTab(run.id, 'tab-1');
    const missed = await store.appendEvent(run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-2' } });
    // Deliver an envelope from the FUTURE, as a tail that dropped `missed` on the floor would.
    vm.applyEvent(run.id, { ...missed, seq: missed.seq + 5, payload: { tabId: 'tab-9' } });

    await vi.waitFor(() => expect(vm.tabsOf(run.id)).toEqual(['tab-1', 'tab-2']));
    expect(vm.ownerOf('tab-9'), 'the phantom future envelope was folded in as if nothing was missing').toBeUndefined();
  });

  it('summarises runs for the chrome straight out of the log', async () => {
    const a = await vm.createRun({ task: 'buy milk' });
    await vm.attachTab(a.id, 'tab-1');

    expect(vm.list()).toEqual([
      { id: a.id, task: 'buy milk', status: 'running', tabIds: ['tab-1'], visibility: 'hidden' },
    ]);
  });

  it('marks a run terminal through the log when its session ends', async () => {
    const a = await vm.createRun({ task: 'a' });
    await vm.attachTab(a.id, 'tab-1');
    await vm.endRun(a.id, 'completed');

    expect(store.appends.map((x) => x.type)).toEqual(['tab.attached', 'tab.detached', 'run.completed']);
    expect(vm.ownerOf('tab-1')).toBeUndefined();
    expect(vm.list()[0].status).toBe('done');
  });
});

/**
 * F3 — what a finished run costs this process.
 *
 * Runs are never deleted and `hydrate` deliberately keeps a run the listing did not name, so every log
 * this projection ever replicated stayed replicated for the app's lifetime: an agent that ran a hundred
 * tasks held a hundred full event arrays it could no longer learn anything from. A terminal run's
 * projection cannot move, and every reader asks for the projection, so the envelopes are droppable —
 * the rows below pin that the drop happens AND that dropping changes no answer.
 */
describe('RunViewModel — a finished run stops costing its log', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
  });

  it('drops a terminal run’s envelopes and keeps answering out of the projection they produced', async () => {
    const done = await vm.createRun({ task: 'a long one' });
    const live = await vm.createRun({ task: 'still going' });
    await vm.attachTab(done.id, 'tab-done');
    await vm.attachTab(live.id, 'tab-live');
    for (let i = 0; i < 200; i++) {
      await store.appendEvent(done.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    expect(vm.retainedEventCount(done.id)).toBeGreaterThan(200);

    await vm.endRun(done.id, 'completed');

    // The footprint is the projected summary alone — the 200+ envelopes behind it are gone.
    expect(vm.retainedEventCount(done.id)).toBe(0);
    // …and every answer that used to come from those envelopes still comes back identical.
    expect(vm.snapshot(done.id)?.status).toBe('done');
    expect(vm.snapshot(done.id)?.task).toBe('a long one');
    expect(vm.snapshot(done.id)?.cost.browserActions).toBe(200);
    expect(vm.snapshot(done.id)?.tabIds).toEqual([]); // released by endRun, replayed not remembered
    expect(vm.list().map((r) => ({ id: r.id, status: r.status }))).toEqual([
      { id: done.id, status: 'done' },
      { id: live.id, status: 'running' },
    ]);
    expect(vm.ownerOf('tab-live')).toBe(live.id);
    expect(vm.ownerOf('tab-done')).toBeUndefined();
    // The bound is on FINISHED runs only. A live run that dropped its log could not fold its next event.
    expect(vm.retainedEventCount(live.id)).toBeGreaterThan(0);
  });

  it('still names the session of a run whose envelopes it has dropped', async () => {
    const run = await vm.createRun({ task: 'session-linked', sessionId: 'sess-7' });
    await vm.endRun(run.id, 'completed');

    expect(vm.retainedEventCount(run.id)).toBe(0);
    expect(vm.sessionIdOf(run.id)).toBe('sess-7'); // replayed from `run.created` before the drop
    expect(vm.runForSession('sess-7')).toBe(run.id);
  });

  // The store's log is append-only and does not close, so an envelope CAN arrive for a run this
  // projection has already sealed. There is nothing to fold into, so it replays — and re-seals, which
  // is what keeps the bound a bound rather than a one-shot.
  it('replays a sealed run rather than losing an envelope that arrives after it ended', async () => {
    const run = await vm.createRun({ task: 'ended, then spoke' });
    await vm.endRun(run.id, 'completed');
    expect(vm.retainedEventCount(run.id)).toBe(0);

    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 4 } });

    await vi.waitFor(() => expect(vm.snapshot(run.id)?.cost.browserActions).toBe(4));
    expect(vm.snapshot(run.id)?.status).toBe('done');
    expect(vm.retainedEventCount(run.id), 'the replay re-sealed instead of re-retaining the log').toBe(0);
  });

  // Demoting a finished run is the one write this class makes to a sealed run — it is exactly what a
  // boot reconcile does to a run that ended while it was being watched. The projection has to be
  // current when the call resolves, or the caller moves a window on a stale answer.
  it('has the projection current when a demote of a finished run resolves', async () => {
    const run = await vm.createRun({ task: 'watched, then over' });
    await vm.setVisibility(run.id, 'visible', 'human', 'tray');
    await vm.endRun(run.id, 'completed');
    expect(vm.snapshot(run.id)?.visibility).toBe('visible');

    await expect(vm.setVisibility(run.id, 'hidden', 'system')).resolves.toBe(true);

    expect(vm.snapshot(run.id)?.visibility).toBe('hidden'); // no waitFor: settled, not eventually
    expect(vm.retainedEventCount(run.id)).toBe(0);
  });
});

/**
 * F4 — what boot costs. The broker is one stdio pipe, so a store read is a round-trip, and hydrate used
 * to make one listing call plus one awaited read per run, strictly in series. `reads` is the instrument:
 * no assertion about the resulting projection can tell 1 hop from 51.
 */
describe('RunViewModel — boot hydration is one bounded, concurrent read', () => {
  it('takes the whole boot page in a single round-trip when the store offers the combined read', async () => {
    const store = new FakeRunStore();
    for (let i = 0; i < 5; i++) {
      const run = await store.createRun({ task: `run ${i}` });
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } });
    }

    const vm = new RunViewModel(store);
    store.reads.length = 0;
    await vm.hydrate();

    // One hop for five runs — not one listing plus five reads, and not the same events twice.
    expect(store.reads).toEqual(['listRunLogs']);
    expect(vm.list().map((r) => r.task)).toEqual(['run 0', 'run 1', 'run 2', 'run 3', 'run 4']);
    expect(vm.ownerOf('tab-3')).toBe(vm.list()[3].id);
  });

  it('reads every run at once, not one after another, against a store with no combined read', async () => {
    const base = new FakeRunStore();
    for (let i = 0; i < 4; i++) await base.createRun({ task: `run ${i}` });

    let inFlight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // The minimal port: no `listRunLogs`, so hydrate falls back — and the fallback must still not be
    // a serial chain. Every read parks on one gate, so a serialized hydrate can never reach peak 4.
    const minimal: RunStoreClient = {
      createRun: (input) => base.createRun(input),
      appendEvent: (runId, event) => base.appendEvent(runId, event),
      getRun: (runId) => base.getRun(runId),
      listRuns: () => base.listRuns(),
      eventsSince: async (runId, since, limit) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        return base.eventsSince(runId, since, limit);
      },
      onRunEvent: (handler) => base.onRunEvent(handler),
    };

    const vm = new RunViewModel(minimal);
    const booting = vm.hydrate();
    await vi.waitFor(() => expect(peak).toBe(4));
    release();
    await booting;

    expect(vm.list().map((r) => r.task).sort()).toEqual(['run 0', 'run 1', 'run 2', 'run 3']);
  });
});
