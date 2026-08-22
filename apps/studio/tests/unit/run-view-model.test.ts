import { describe, it, expect, beforeEach } from 'vitest';
import type { CreateRunInput, ListRunsResult, Run, RunEvent, RunEventInput } from 'wigolo/studio';
import { RunViewModel, TabOwnedError, type RunStoreClient } from '../../src/main/run-view-model';

/**
 * A faithful in-memory stand-in for the daemon run store: it assigns `seq` and `ts` (callers never
 * can), it is append-only, and it fans committed envelopes out to the live-tail handlers the way the
 * broker's `run-event` notify does. The app never loads the native DB, so the real store cannot bind
 * here — but every rule the view-model depends on is reproduced.
 */
class FakeRunStore implements RunStoreClient {
  readonly facts = new Map<string, { task: string; spaceId: string; createdAt: string }>();
  readonly log = new Map<string, RunEvent[]>();
  private handlers: Array<(runId: string, e: RunEvent) => void> = [];
  private n = 0;
  /** Every append that reached the store, so a test can assert what was NOT written. */
  readonly appends: Array<{ runId: string; type: string; payload: Record<string, unknown> }> = [];

  async createRun(input: CreateRunInput): Promise<Run> {
    const id = `run${++this.n}`;
    const createdAt = new Date(1_700_000_000_000 + this.n).toISOString();
    this.facts.set(id, { task: input.task, spaceId: input.spaceId ?? 'default', createdAt });
    this.log.set(id, []);
    this.commit(id, {
      actor: { kind: 'daemon' },
      type: 'run.created',
      payload: { task: input.task, spaceId: input.spaceId ?? 'default', driver: input.driver ?? { kind: 'studio' }, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
    });
    return (await this.getRun(id))!;
  }

  async appendEvent(runId: string, event: RunEventInput): Promise<RunEvent> {
    if (!this.log.has(runId)) throw new Error(`unknown run: ${runId}`);
    this.appends.push({ runId, type: event.type, payload: event.payload ?? {} });
    return this.commit(runId, event);
  }

  private commit(runId: string, event: RunEventInput): RunEvent {
    const events = this.log.get(runId)!;
    const committed: RunEvent = { seq: events.length + 1, ts: new Date(1_700_000_000_000 + events.length).toISOString(), actor: event.actor, type: event.type, payload: event.payload ?? {} };
    events.push(committed);
    for (const h of this.handlers) h(runId, committed);
    return committed;
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const f = this.facts.get(runId);
    if (!f) return undefined;
    const events = this.log.get(runId)!;
    return {
      id: runId, task: f.task, spaceId: f.spaceId, createdAt: f.createdAt,
      status: 'running', driver: { kind: 'studio' },
      tabIds: [], pendingDecisions: [], cost: { browserActions: 0, tokensIn: 0, tokensOut: 0, spendUsd: 0 },
      visibility: 'hidden', lastSeq: events.length, updatedAt: f.createdAt,
    };
  }

  async listRuns(): Promise<ListRunsResult> {
    const runs = await Promise.all([...this.facts.keys()].map((id) => this.getRun(id)));
    return { runs: runs.filter((r): r is Run => r !== undefined) };
  }

  async eventsSince(runId: string, since = 0): Promise<RunEvent[]> {
    return (this.log.get(runId) ?? []).filter((e) => e.seq > since);
  }

  onRunEvent(handler: (runId: string, event: RunEvent) => void): void {
    this.handlers.push(handler);
  }
}

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

  it('learns a run it has never seen from a live event without being told to re-list', async () => {
    const outsider = await store.createRun({ task: 'created behind our back' });
    await store.appendEvent(outsider.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-x' } });
    await vm.hydrate();
    expect(vm.ownerOf('tab-x')).toBe(outsider.id);
  });

  it('keeps the focused run as ephemeral UI state that no event ever writes', async () => {
    const a = await vm.createRun({ task: 'a' });
    const b = await vm.createRun({ task: 'b' });
    expect(vm.focusedRunId).toBe(a.id); // the first run focuses itself; a human can move it
    store.appends.length = 0;

    vm.focusRun(b.id);
    expect(vm.focusedRunId).toBe(b.id);
    expect(store.appends).toEqual([]); // focus is not a run fact — it never reaches the log

    const fresh = new RunViewModel(store);
    await fresh.hydrate();
    expect(fresh.focusedRunId).toBeNull(); // replaying every run restores no focus, because none was stored
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
