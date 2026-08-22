import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RunViewModel, TabOwnedError } from '../../src/main/run-view-model';
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

    expect(vm.list()).toEqual([{ id: a.id, task: 'buy milk', status: 'running', tabIds: ['tab-1'] }]);
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
