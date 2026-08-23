import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_LIST_LIMIT,
  projectRun,
  type CreateRunInput,
  type ListRunsOptions,
  type RunEvent,
  type RunEventInput,
} from 'wigolo/studio';
import { EMIT_COALESCE_MS, RunViewModel, TabOwnedError, type RunStoreClient } from '../../src/main/run-view-model';
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
      { runId: run.id, type: 'tab.attached', payload: { tabId: 'tab-a', url: 'https://example.com' } },
    ]);
    expect(vm.ownerOf('tab-a')).toBe(run.id);
    expect(vm.tabsOf(run.id)).toEqual(['tab-a']);
  });

  // The run log is durable, append-only by design (no prune path), and served to any client that clears
  // the REST gate — over `GET /v1/runs/{id}/events` and the SSE tail. So a query string that rides in on
  // an attach url is a secret stored FOREVER and handed out on request: a magic link, an SSO callback, a
  // password-reset token, a pre-signed URL. None of those pages look credential-bearing to a classifier,
  // which is exactly why the audit path strips the query UNCONDITIONALLY rather than deciding per page.
  // The run log gets the same rule: forensics and replay need the origin, never what follows it.
  it('stores only the origin of an attach url — query and fragment never reach the durable log', async () => {
    const run = await vm.createRun({ task: 'open a magic link' });
    await vm.attachTab(run.id, 'tab-a', 'https://mail.example.com/login/verify?token=s3cr3t-reset&uid=42#inbox');

    expect(store.appends).toEqual([
      { runId: run.id, type: 'tab.attached', payload: { tabId: 'tab-a', url: 'https://mail.example.com' } },
    ]);
    const stored = JSON.stringify(store.appends);
    expect(stored, 'the reset token reached the append-only log').not.toContain('s3cr3t-reset');
    expect(stored, 'the fragment reached the append-only log').not.toContain('inbox');
  });

  // "Unparseable" is not "harmless". `originOnly`'s catch used to hand the string back WHOLE, so a url the
  // URL parser rejects for a reason unrelated to its query — a bad port, a stray space — would have carried
  // its token into the same durable row the parseable case is protected from.
  it('cuts a url the parser rejects at its query rather than storing it whole', async () => {
    const run = await vm.createRun({ task: 'malformed' });
    await vm.attachTab(run.id, 'tab-a', 'https://host:notaport/reset?token=s3cr3t-reset');

    expect(store.appends[0]!.payload.url).toBe('https://host:notaport/reset');
    expect(JSON.stringify(store.appends)).not.toContain('s3cr3t-reset');
  });

  // The sweep, as an executable invariant rather than a one-time grep: drive EVERY event constructor the
  // view-model owns and assert that any payload carrying a `url` carries an origin and nothing else. A new
  // constructor that starts recording a full url fails here without anyone remembering to re-run the grep.
  it('lets no run-event payload carry more of a url than its origin', async () => {
    const secret = 'https://app.example.com/a/b?token=s3cr3t-reset&x=1#frag';
    const run = await vm.createRun({ task: 'every constructor' });
    await vm.attachTab(run.id, 'tab-a', secret);
    await vm.setVisibility(run.id, 'visible', 'human', 'panel');
    await vm.setVisibility(run.id, 'hidden', 'human');
    await vm.requestDecision(run.id, { decisionId: 'd1', kind: 'nav', prompt: 'open it?' });
    await vm.resolveDecision(run.id, 'd1', 'approved', 'human');
    await vm.detachTab('tab-a', 'closed');
    await vm.endRun(run.id, 'completed', 'finished');

    const withUrl = store.appends.filter((a) => typeof a.payload.url === 'string');
    expect(withUrl.length, 'no constructor recorded a url at all — the sweep proved nothing').toBeGreaterThan(0);
    for (const a of withUrl) {
      const url = a.payload.url as string;
      expect(url, `${a.type} recorded more than an origin`).toBe(new URL(url).origin);
    }
    expect(JSON.stringify(store.appends)).not.toContain('s3cr3t-reset');
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

  /**
   * The memo is an implementation detail, and a returned array is the caller's.
   *
   * These enumerations read straight off the memoised projection, so before this they handed every
   * caller the SAME array — the one the cache is holding. Callers treat what they are given as
   * theirs: `endRun` iterates it while detaching, the tab strip sorts, a consumer splices. Any of
   * those rewrote the cached projection under everyone else, and the run then appeared to have lost
   * a tab that no `tab.detached` event ever mentioned — ownership silently disagreeing with the log,
   * which is the one thing this class exists to prevent.
   *
   * Asserted through `ownerOf` as well as through the enumeration, because the corrupted memo is
   * what law 4's refusal is checked against: a tab dropped out of the cache is a tab another run
   * would then be allowed to attach.
   */
  it('hands out a copy of the tab list, so a mutating caller cannot corrupt the projection', async () => {
    const run = await vm.createRun({ task: 'a' });
    await vm.attachTab(run.id, 'tab-a');
    await vm.attachTab(run.id, 'tab-b');

    vm.tabsOf(run.id).pop();
    expect(vm.tabsOf(run.id), 'the cached projection lost a tab nobody detached').toEqual(['tab-a', 'tab-b']);

    vm.agentVisibleTabs(run.id).length = 0;
    expect(vm.tabsOf(run.id), 'the agent-visible enumeration emptied the projection it read from').toEqual(['tab-a', 'tab-b']);

    vm.list()[0]!.tabIds.push('tab-stolen');
    expect(vm.tabsOf(run.id), 'a summary handed to the chrome was a handle on the projection').toEqual(['tab-a', 'tab-b']);

    expect(vm.ownerOf('tab-b'), 'law 4 would now let another run attach a tab this one still owns').toBe(run.id);
    expect(vm.snapshot(run.id)?.tabIds).toEqual(['tab-a', 'tab-b']);
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

/**
 * MED-2 / perf #5 — what boot MOVES, as opposed to how many hops it takes.
 *
 * The combined boot read asked each run for its entire log and the store answered literally, in ONE
 * newline-delimited frame the host accumulates as a single JS string and `JSON.parse`s synchronously
 * on the thread that paints. Fifty long-lived runs of tens of thousands of envelopes is hundreds of
 * megabytes of that at startup, with no cap and no fallback.
 *
 * A run over the bound now arrives as the projection the store had already computed for it, which is
 * the same state a finished run is kept in. The two things that have to survive that are the two
 * things a projection cannot rebuild for itself: the seq the store is actually at, and the session
 * link that rides on the `run.created` envelope.
 */
describe('RunViewModel — a boot read the pipe can carry', () => {
  const restProjection = (store: FakeRunStore, runId: string) =>
    projectRun({ id: runId, ...store.facts.get(runId)! }, store.log.get(runId)!);

  /** A store holding one run whose log is past the boot cap, and one that is not. */
  async function seed(): Promise<{ store: FakeRunStore; longId: string; shortId: string; tail: number }> {
    const store = new FakeRunStore();
    const long = await store.createRun({ task: 'a long one', sessionId: 'sess-long' });
    for (let i = 0; i < 12; i++) {
      await store.appendEvent(long.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } });
    }
    const short = await store.createRun({ task: 'an ordinary one' });
    await store.appendEvent(short.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-short' } });
    store.bootEventCapPerRun = 4;
    return { store, longId: long.id, shortId: short.id, tail: store.log.get(long.id)!.length };
  }

  it('keeps the store’s projection for a log too large to send, and still answers every read from it', async () => {
    const { store, longId, shortId } = await seed();
    const vm = new RunViewModel(store);
    await vm.hydrate();

    // The bound is a property, not a comment: the twelve envelopes never crossed.
    expect(vm.retainedEventCount(longId), 'the oversize log was sent after all, so this arm proves nothing').toBe(0);
    // …and nothing a caller can ask changed. Compared against `projectRun` over the WHOLE log — what
    // REST answers for the same run — rather than against a hand-written expectation.
    expect(vm.snapshot(longId)).toEqual(restProjection(store, longId));
    expect(vm.tabsOf(longId)).toEqual(Array.from({ length: 12 }, (_, i) => `tab-${i}`));
    expect(vm.ownerOf('tab-11')).toBe(longId);
    // The session link normally comes off `run.created`, which is not in a condensed entry.
    expect(vm.sessionIdOf(longId)).toBe('sess-long');
    expect(vm.runForSession('sess-long')).toBe(longId);
    // The control: the bound applies to the run that is over it, not to the page. A run that fits
    // still arrives whole, because a live run that dropped its log could not fold its next envelope.
    expect(vm.retainedEventCount(shortId)).toBeGreaterThan(0);
  });

  /**
   * The seq bookkeeping, which is where a naive bound goes wrong.
   *
   * A condensed entry holds no envelopes, so a `lastSeq` derived from the ones it was sent would be
   * zero — and the broker replays its own committed envelopes to a reconnecting tail as a matter of
   * course. Every one of those would then read as NEW rather than as already-folded, and each would
   * find a projection with nothing to fold into and replay the whole run: a read bound turned into a
   * replay storm on exactly the runs that are too big to replay.
   */
  it('drops an envelope it has already seen rather than replaying the run it just condensed', async () => {
    const { store, longId, tail } = await seed();
    const vm = new RunViewModel(store);
    await vm.hydrate();
    store.reads.length = 0;

    // The tail reconnects and re-delivers the run's last three envelopes, as it does on every reconnect.
    for (const event of store.log.get(longId)!.slice(-3)) vm.applyEvent(longId, event);
    await Promise.resolve();

    expect(store.reads, 'a re-delivered envelope replayed a run that had missed nothing').toEqual([]);
    expect(vm.snapshot(longId)).toEqual(restProjection(store, longId));

    // …and the genuinely NEXT envelope is not dropped with them: it replays, once, and lands gapless.
    await store.appendEvent(longId, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-new' } });
    await vi.waitFor(() => expect(vm.ownerOf('tab-new')).toBe(longId));
    expect(vm.snapshot(longId)).toEqual(restProjection(store, longId));
    expect(vm.snapshot(longId)!.lastSeq).toBe(tail + 1);
    expect(store.reads.filter((r) => r === 'runFacts'), 'one envelope caused more than one replay').toHaveLength(1);
  });

  /**
   * `hydrate` called `loadLogs()` with no options, took the page it got and dropped the `nextCursor`
   * that came with it — so a machine with more runs than one page booted the app showing one page of
   * them, and nothing calls `hydrate` again after boot.
   */
  it('follows the listing cursor, so a run past the first page is not invisible until it speaks', async () => {
    const store = new FakeRunStore();
    store.listLimit = DEFAULT_LIST_LIMIT;
    for (let i = 0; i <= DEFAULT_LIST_LIMIT; i++) await store.createRun({ task: `run ${i}` });

    const vm = new RunViewModel(store);
    store.reads.length = 0;
    await vm.hydrate();

    expect(vm.list()).toHaveLength(DEFAULT_LIST_LIMIT + 1);
    expect(vm.list().map((r) => r.task)).toContain(`run ${DEFAULT_LIST_LIMIT}`);
    // Two pages for fifty-one runs, and it stops there: the cursor is followed, not chased forever.
    expect(store.reads.filter((r) => r === 'listRunLogs')).toHaveLength(2);
  });
});

/**
 * perf #5 (second half) and perf #6 — what a gap replay costs.
 *
 * `replay` read the same log twice and read all of it both times: `getRun` made the store PROJECT the
 * run so that four strings of facts could be kept, and then `eventsSince(id, 0)` asked for every
 * envelope the run has ever had, in one frame, on the thread that paints — on EVERY seq gap.
 */
describe('RunViewModel — a gap replay that pages', () => {
  it('reads the log in bounded pages and asks for facts without projecting the run', async () => {
    const store = new FakeRunStore();
    // The store's own per-frame ceiling, well under what the reader asks for — which is what makes a
    // SHORT page the ordinary shape here, and stopping on one a silent truncation.
    store.eventsPageCeiling = 7;
    const vm = new RunViewModel(store);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'a long-running one' });
    for (let i = 0; i < 30; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } });
    }
    const tail = store.log.get(run.id)!.length;

    const pages: Array<{ since: number; limit: number | undefined }> = [];
    const read = store.eventsSince.bind(store);
    store.eventsSince = async (runId, since = 0, limit?: number) => {
      pages.push({ since, limit });
      return read(runId, since, limit);
    };
    store.reads.length = 0;

    // An envelope from the future, as a tail that dropped the ones before it would deliver: a gap
    // several pages wide.
    vm.applyEvent(run.id, {
      seq: tail + 4, ts: new Date().toISOString(), actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-phantom' },
    });

    // The settle signal is the replay's own last page, not the projection: the projection already
    // held all thirty tabs before the gap arrived, so waiting on it would pass without a replay at all.
    await vi.waitFor(() => expect(pages.at(-1)?.since ?? -1).toBeGreaterThanOrEqual(tail));

    // Multiple reads, every one of them bounded, tiling the log from the start with no overlap.
    expect(pages.length, 'the whole log came back in one frame').toBeGreaterThan(3);
    expect(pages.every((p) => typeof p.limit === 'number' && p.limit > 0), 'a read asked for the whole log').toBe(true);
    expect(pages.map((p) => p.since)).toEqual([...pages.map((p) => p.since)].sort((a, b) => a - b));
    expect(pages[0]!.since).toBe(0);
    // …and it did not stop at the first SHORT page, which is what a server-side ceiling looks like.
    expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(tail / store.eventsPageCeiling));

    // One facts read, no projection: `getRun` would have made the store replay the log to build a
    // `Run` whose every field but four is discarded here.
    expect(store.reads.filter((r) => r === 'runFacts')).toHaveLength(1);
    expect(store.reads.filter((r) => r === 'getRun'), 'the replay projected the run it was about to project itself').toEqual([]);

    // Gapless: every tab is there, the projection matches the store's own, and the phantom envelope
    // that triggered the replay was not folded in as if nothing were missing.
    expect(vm.tabsOf(run.id)).toEqual(Array.from({ length: 30 }, (_, i) => `tab-${i}`));
    expect(vm.snapshot(run.id)).toEqual(projectRun({ id: run.id, ...store.facts.get(run.id)! }, store.log.get(run.id)!));
    expect(vm.ownerOf('tab-phantom')).toBeUndefined();
    expect(vm.snapshot(run.id)!.lastSeq).toBe(tail);
  });
});

/**
 * The memo used to be keyed on the log alone. `projectRun` is a pure function of the log AND the
 * clock — `autoDenyAt` is the one field the clock moves — so a projection cached while a decision
 * was pending stayed `needs_you` forever: the two-minute deadline passes without any envelope
 * arriving to drop the memo. The menu-bar count and the dock badge read through `list()`, so the app
 * went on saying a human was needed while the REST surface, projecting fresh with its own clock,
 * said the run was simply running. One log, two answers.
 *
 * Every arm therefore asserts the app's projection against `projectRun` over the SAME log at the
 * SAME instant, which is what the REST surface does. Asserting only "not needs_you" would pass
 * against a memo that had gone stale in some other direction.
 */
describe('RunViewModel — a memo the clock can invalidate', () => {
  const restProjection = (store: FakeRunStore, runId: string, now: Date) =>
    projectRun({ id: runId, ...store.facts.get(runId)! }, store.log.get(runId)!, now);

  it('stops holding a run at needs_you once its card auto-denied, with no event arriving', async () => {
    const store = new FakeRunStore();
    let now = new Date();
    const vm = new RunViewModel(store, () => now);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'book the flight' });
    await vm.requestDecision(run.id, { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' });

    // The read the tray does on every redraw — and the read that warms the memo.
    expect(vm.list()[0]!.status).toBe('needs_you');
    const card = vm.snapshot(run.id)!.pendingDecisions[0]!;

    // Two minutes pass. Auto-deny is a DEADLINE, not an envelope: nothing is appended, nothing is
    // notified, and the only thing that changed is what time it is.
    now = new Date(Date.parse(card.autoDenyAt));

    expect(vm.list()[0]!.status, 'the menu bar went on asking for a human after the card expired').toBe('running');
    expect(vm.snapshot(run.id)!.pendingDecisions, 'an expired card was still being offered').toEqual([]);

    const rest = restProjection(store, run.id, now);
    expect(vm.snapshot(run.id)!.status, 'the app and REST disagreed about one log').toBe(rest.status);
    expect(vm.snapshot(run.id)!.pendingDecisions).toEqual(rest.pendingDecisions);
  });

  it('keeps the memo while the card is still answerable, rather than reprojecting on every read', async () => {
    // The control: an expiry rule that just disabled the cache would satisfy the arm above and undo
    // the whole point of memoising. The deadline is the key, not a reason to stop having one.
    const store = new FakeRunStore();
    let now = new Date();
    const vm = new RunViewModel(store, () => now);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'book the flight' });
    await vm.requestDecision(run.id, { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' });

    const first = vm.snapshot(run.id)!;
    now = new Date(Date.parse(vm.snapshot(run.id)!.pendingDecisions[0]!.autoDenyAt) - 1);
    expect(vm.snapshot(run.id), 'the memo was thrown away while it was still true').toBe(first);
  });

  it('does not go on offering an expired card on a run whose envelopes it has dropped', async () => {
    // A sealed run cannot be reprojected — its envelopes are gone by design — but the clock still
    // moves the same field, and REST still answers from the full log. Expiry only ever removes a
    // card, so the kept projection can be narrowed without replaying anything.
    const store = new FakeRunStore();
    let now = new Date();
    const vm = new RunViewModel(store, () => now);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'book the flight' });
    await vm.requestDecision(run.id, { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' });
    const card = vm.snapshot(run.id)!.pendingDecisions[0]!;
    await vm.endRun(run.id, 'completed');

    expect(vm.retainedEventCount(run.id), 'the run was not sealed, so this arm proves nothing').toBe(0);
    expect(vm.snapshot(run.id)!.pendingDecisions).toHaveLength(1);

    now = new Date(Date.parse(card.autoDenyAt));
    expect(vm.snapshot(run.id)!.pendingDecisions, 'a finished run kept offering a card that had expired').toEqual([]);
    expect(vm.snapshot(run.id)!.pendingDecisions).toEqual(restProjection(store, run.id, now).pendingDecisions);
    expect(vm.snapshot(run.id)!.status, 'narrowing the kept projection moved something other than the card').toBe('done');
  });
});

/**
 * The other half of the same defect: being right when asked is not the same as saying so.
 *
 * The memo above expires on the clock, which makes every READ correct. But `emit` fires on events,
 * and the `needs_you → running` transition at `autoDenyAt` arrives without one — that is the whole
 * point of a deadline. Nothing reads a quiet run, so nothing recomputed: the tray label, the dock
 * badge and the presentation controller went on showing "needs you" indefinitely, while REST —
 * which projects fresh on every request — said the run was running. Two surfaces, one log, two
 * answers, which is exactly what the memo's own comment claimed to have removed.
 *
 * So the projection schedules the fan-out at the deadline. Every arm here drives that timer, because
 * a test that only reads after moving the clock cannot tell a fan-out from a memo.
 */
describe('RunViewModel — the deadline announces itself', () => {
  const collect = (into: Array<{ ms: number; fire: () => void }>) => (cb: () => void, ms: number): (() => void) => {
    const t = { ms, fire: cb };
    into.push(t);
    return () => { const at = into.indexOf(t); if (at >= 0) into.splice(at, 1); };
  };

  it('fans the expiry out to its subscribers without any envelope landing', async () => {
    const store = new FakeRunStore();
    let now = new Date();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const vm = new RunViewModel(store, () => now, collect(timers));
    await vm.hydrate();
    const run = await vm.createRun({ task: 'book the flight' });
    await vm.requestDecision(run.id, { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' });

    // The read the tray does on every redraw, which is also what registers the deadline.
    expect(vm.list()[0]!.status).toBe('needs_you');
    const card = vm.snapshot(run.id)!.pendingDecisions[0]!;
    expect(timers, 'nothing was scheduled for a deadline the run is holding').toHaveLength(1);

    const seen: string[] = [];
    vm.onChange(() => seen.push(vm.list()[0]!.status));
    store.appends.length = 0;

    now = new Date(Date.parse(card.autoDenyAt));
    timers[0]!.fire();

    // The claim is the callback, not the value: every attention surface redraws off this and nothing
    // else, so a transition nobody announced is a transition they never make.
    expect(seen, 'the deadline passed in silence — the badge stays lit until something else happens').toEqual(['running']);
    expect(store.appends, 'the fan-out was bought by writing to the log').toEqual([]);
  });

  it('schedules nothing for a run with no card, and lets the deadline go when one is answered', async () => {
    // The control. Scheduling unconditionally would satisfy the arm above and put a timer behind
    // every run the app has ever seen.
    const store = new FakeRunStore();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const vm = new RunViewModel(store, () => new Date(), collect(timers));
    await vm.hydrate();
    const run = await vm.createRun({ task: 'book the flight' });

    expect(vm.list()[0]!.status).toBe('running');
    expect(timers).toHaveLength(0);

    await vm.requestDecision(run.id, { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' });
    expect(vm.list()[0]!.status).toBe('needs_you');
    expect(timers).toHaveLength(1);

    await vm.resolveDecision(run.id, 'd1', 'approved', 'human');
    expect(vm.list()[0]!.status).toBe('running');
    expect(timers, 'a deadline outlived the card it was for').toHaveLength(0);
  });

  it('lets go of every scheduled deadline when it is disposed', async () => {
    const store = new FakeRunStore();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const vm = new RunViewModel(store, () => new Date(), collect(timers));
    await vm.hydrate();
    const run = await vm.createRun({ task: 'book the flight' });
    await vm.requestDecision(run.id, { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' });
    vm.list();
    expect(timers).toHaveLength(1);

    vm.dispose();

    // A timer that outlives the app would announce a transition into destroyed surfaces.
    expect(timers).toHaveLength(0);
  });

  /**
   * The coalescing window is the OTHER timer this class owns, and dispose could not reach it: it was a
   * raw `setTimeout` with no handle kept, so nothing could clear it and no test could drive it.
   *
   * That matters most on the path dispose exists for. Shutdown ends every live run, so the last thing
   * before this call is a burst of terminal appends; whichever lands in the final 16 ms is owed the
   * trailing fan-out, and the tray was destroyed one line earlier. The window has to be on the
   * injected timer for the first claim below to be checkable at all, and cleared for the second.
   */
  it('clears the coalescing window on dispose, so a change inside it never fans out afterwards', async () => {
    const store = new FakeRunStore();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const vm = new RunViewModel(store, () => new Date(), collect(timers));
    await vm.hydrate();
    const run = await vm.createRun({ task: 'book the flight' });

    let fanOuts = 0;
    vm.onChange(() => { fanOuts++; });

    await vm.attachTab(run.id, 'tab-a'); // leading edge, and the window opens behind it
    expect(fanOuts).toBe(1);
    const window = timers.find((t) => t.ms === EMIT_COALESCE_MS);
    expect(window, 'the coalescing window is not on the injected timer, so nothing can clear it').toBeDefined();

    await vm.attachTab(run.id, 'tab-b'); // lands INSIDE the window — owed the fan-out that closes it
    expect(fanOuts, 'the window did not coalesce the second change').toBe(1);

    vm.dispose();

    expect(timers, 'dispose left the coalescing window running').not.toContain(window);
    // The window that a raw `setTimeout` would still be running. Firing it must reach nobody.
    window!.fire();
    await new Promise((resolve) => { setTimeout(resolve, EMIT_COALESCE_MS * 4); });
    expect(fanOuts, 'a fan-out reached listeners after dispose').toBe(1);
  });

  /**
   * A condensed run is the sharpest version of the same disagreement. It bypasses the memo entirely
   * — its answer is the kept projection — so stripping the expired card while leaving `status` alone
   * left one projection contradicting ITSELF: `status: needs_you` beside `pendingDecisions: []`, for
   * the rest of a live run's life.
   */
  it('moves a condensed run’s status with the card it can no longer project, and then re-reads the log', async () => {
    const store = new FakeRunStore();
    const seeded = await store.createRun({ task: 'a long one', sessionId: 'sess-long' });
    for (let i = 0; i < 12; i++) {
      await store.appendEvent(seeded.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } });
    }
    await store.appendEvent(seeded.id, {
      actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' },
    });
    store.bootEventCapPerRun = 4;

    let now = new Date();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const vm = new RunViewModel(store, () => now, collect(timers));
    await vm.hydrate();

    expect(vm.retainedEventCount(seeded.id), 'the log was sent whole, so this arm proves nothing').toBe(0);
    expect(vm.snapshot(seeded.id)!.status).toBe('needs_you');
    const card = vm.snapshot(seeded.id)!.pendingDecisions[0]!;
    expect(timers).toHaveLength(1);

    now = new Date(Date.parse(card.autoDenyAt));

    const narrowed = vm.snapshot(seeded.id)!;
    expect(narrowed.pendingDecisions).toEqual([]);
    expect(narrowed.status, 'a condensed run answered needs_you beside an empty card list').toBe('running');

    // …and the narrowing is only the answer until the log speaks. `needs_you` can also come from a
    // pause the kept projection no longer records, so a narrowed read replays the run rather than
    // leaving the app on a status it inferred. The deadline timer does the same for a run nobody
    // happens to read.
    await new Promise((r) => setImmediate(r));

    expect(vm.retainedEventCount(seeded.id), 'the condensed run was never re-read').toBeGreaterThan(0);
    expect(vm.snapshot(seeded.id)).toEqual(
      projectRun({ id: seeded.id, ...store.facts.get(seeded.id)! }, store.log.get(seeded.id)!, now),
    );
  });

  it('re-reads a condensed run at the deadline even when nobody read it first', async () => {
    // The unwatched case, which is the one the whole fix is about: a quiet run is exactly the run
    // no surface asks about, so the narrowing-on-read path never runs for it.
    const store = new FakeRunStore();
    const seeded = await store.createRun({ task: 'a long one' });
    for (let i = 0; i < 12; i++) {
      await store.appendEvent(seeded.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } });
    }
    await store.appendEvent(seeded.id, {
      actor: { kind: 'agent' }, type: 'decision.requested', payload: { decisionId: 'd1', kind: 'approval', prompt: 'proceed?' },
    });
    store.bootEventCapPerRun = 4;

    let now = new Date();
    const timers: Array<{ ms: number; fire: () => void }> = [];
    const vm = new RunViewModel(store, () => now, collect(timers));
    await vm.hydrate();
    const card = vm.snapshot(seeded.id)!.pendingDecisions[0]!;
    expect(vm.retainedEventCount(seeded.id)).toBe(0);
    expect(timers).toHaveLength(1);

    // Nothing reads. The clock moves, and the deadline is all that happens.
    now = new Date(Date.parse(card.autoDenyAt));
    timers[0]!.fire();
    await new Promise((r) => setImmediate(r));

    expect(vm.retainedEventCount(seeded.id), 'a run nobody read stayed on its condensed guess').toBeGreaterThan(0);
    expect(vm.snapshot(seeded.id)!.status).toBe('running');
  });
});

/**
 * A store whose answers can be held in flight, and whose live tail can drop one.
 *
 * Every read here computes its answer WHEN ASKED and delivers it WHEN RELEASED, because that is what
 * a round-trip through the broker child actually is: the page the child read is the page it read,
 * however long the pipe takes to hand it over. Both races below are about what this projection did
 * while a read was still on the wire, and neither is reachable from a store that answers instantly —
 * which is why they survived a suite of otherwise thorough arms.
 */
class ParkableStore implements RunStoreClient {
  private readonly handlers: Array<(runId: string, event: RunEvent) => void> = [];
  private readonly parked = new Map<string, Promise<void>>();
  private drops = 0;

  constructor(private readonly inner: FakeRunStore) {
    this.inner.onRunEvent((runId, event) => {
      if (this.drops > 0) { this.drops--; return; }
      for (const h of this.handlers) h(runId, event);
    });
  }

  /** The next `n` committed envelopes never reach the live tail — the dropped notify a gap means. */
  dropNextNotify(n = 1): void { this.drops = n; }

  /** Hold the next call to `method` AFTER it has computed its answer. Returns the release. */
  park(method: 'runFacts' | 'listRunLogs' | 'eventsSince'): () => void {
    let release!: () => void;
    this.parked.set(method, new Promise<void>((resolve) => { release = () => resolve(); }));
    return release;
  }

  private async hold<T>(method: string, answer: T): Promise<T> {
    const gate = this.parked.get(method);
    if (!gate) return answer;
    this.parked.delete(method);
    await gate;
    return answer;
  }

  createRun(input: CreateRunInput) { return this.inner.createRun(input); }
  appendEvent(runId: string, event: RunEventInput) { return this.inner.appendEvent(runId, event); }
  getRun(runId: string) { return this.inner.getRun(runId); }
  listRuns(opts?: ListRunsOptions) { return this.inner.listRuns(opts); }
  runExists(runId: string) { return this.inner.runExists(runId); }
  async listRunLogs(opts?: ListRunsOptions) { return this.hold('listRunLogs', await this.inner.listRunLogs(opts)); }
  async eventsSince(runId: string, since: number, limit: number) {
    return this.hold('eventsSince', await this.inner.eventsSince(runId, since, limit));
  }
  async runFacts(runId: string) { return this.hold('runFacts', await this.inner.runFacts(runId)); }
  onRunEvent(handler: (runId: string, event: RunEvent) => void): void { this.handlers.push(handler); }
}

/**
 * SD1 exit-6 findings 4 and 5 — two replays racing each other, each of which leaves the app's
 * projection permanently behind the store with no next envelope to correct it.
 *
 * Both matter for the same reason: the envelope they lose is usually the LAST one. A run whose
 * `run.completed` never lands here is `running` in the tray, in the dock badge and in the window the
 * presentation controller is deciding about, while REST — projecting from the store — says it is
 * done. One log, two answers, for as long as the app stays open.
 */
describe('RunViewModel — replays that race each other', () => {
  it('heals a gap even when the replay it deduped against was a non-replace one', async () => {
    const inner = new FakeRunStore();
    const store = new ParkableStore(inner);
    const vm = new RunViewModel(store);

    // The waking envelope for a run this projection has never seen starts a NON-replace adopt, and
    // this parks it mid-read — on the wire, exactly where a slow broker leaves it.
    const deliverFacts = store.park('runFacts');
    const run = await inner.createRun({ task: 'pay the invoice' });

    // …and meanwhile the log gets registered by a shorter path, which is what turns that parked
    // replay into a no-op when it finally resumes: it exits on `logs.has(runId) && !replace`.
    await vm.hydrate();
    expect(vm.snapshot(run.id)?.status).toBe('running');

    // A dropped notify opens the hole, and the envelope that reveals it is the run's LAST one.
    store.dropNextNotify();
    await inner.appendEvent(run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-2' } });
    await inner.appendEvent(run.id, { actor: { kind: 'system' }, type: 'run.completed', payload: {} });

    // The gap asked for a REPLACE replay; it was handed the parked non-replace one instead.
    deliverFacts();

    await vi.waitFor(() => expect(vm.snapshot(run.id)?.status, 'the run stayed running forever').toBe('done'));
    expect(vm.ownerOf('tab-2'), 'the heal replayed the tail, not the whole log').toBe(run.id);
  });

  it('does not let an older boot page rewind a log that has already folded a newer envelope', async () => {
    const inner = new FakeRunStore();
    const store = new ParkableStore(inner);
    const vm = new RunViewModel(store);

    const run = await inner.createRun({ task: 'file the return' });
    await vi.waitFor(() => expect(vm.list().map((r) => r.id)).toEqual([run.id]));

    // The boot page is read HERE — one envelope behind where the run is about to be.
    const deliverBootPage = store.park('listRunLogs');
    const booting = vm.hydrate();

    await inner.appendEvent(run.id, { actor: { kind: 'system' }, type: 'run.completed', payload: {} });
    expect(vm.snapshot(run.id)?.status, 'the terminal envelope never folded, so this arm proves nothing').toBe('done');

    // …and lands after it. A retain that simply overwrites rewinds `lastSeq` below the folded
    // envelope, and a terminal envelope lost this way has no successor to open a gap and heal it.
    deliverBootPage();
    await booting;

    expect(vm.snapshot(run.id)?.status, 'a stale boot page rewound a fresher log').toBe('done');
    expect(vm.retainedEventCount(run.id), 'the rewound log kept envelopes a sealed run has already dropped').toBe(0);
  });
});
