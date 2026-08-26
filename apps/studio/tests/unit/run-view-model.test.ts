import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_LIST_LIMIT,
  projectRun,
  type CreateRunInput,
  type ListRunsOptions,
  type RunEvent,
  type RunEventInput,
} from 'wigolo/studio';
import {
  ADOPT_RETRY_BASE_MS,
  ADOPT_RETRY_MAX_MS,
  EMIT_COALESCE_MS,
  MAX_ADOPT_RETRIES,
  REMATERIALIZE_MAX_EVENTS,
  RunNotOpenError,
  RunViewModel,
  TabOwnedError,
  type RunStoreClient,
} from '../../src/main/run-view-model';
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

  /**
   * SD1 exit-16, arm 1. `applyAttach` was the one lifecycle write on this class with no terminal-run
   * guard — its three siblings (`applyVisibility`, `applyRequestDecision`, `applyResolveDecision`) all
   * refuse past the terminal event per `wigolo-studio-run` issue 112, and the store below checks only that the run row exists.
   * So a run that had already ended could take a `tab.attached`, which is an out-of-order fact in an
   * append-only log with no prune path: `agentVisibleTabs` lists a tab on a cancelled run, `promote()`
   * focuses it, and every later replay reads a finished run owning a page.
   *
   * The refusal is a THROW rather than the silent return `requestDecision` uses, because attach is the
   * one of the four whose caller acts on the answer: `open()` hands the agent a `session_id` on the
   * strength of it, and a session id naming a run that never took the tab is a success response for
   * work that did not happen.
   */
  it('refuses to attach a tab to a run that has already ended, and writes no event', async () => {
    const run = await vm.createRun({ task: 'over already' });
    await vm.endRun(run.id, 'cancelled');
    store.appends.length = 0;

    await expect(vm.attachTab(run.id, 'tab-late')).rejects.toBeInstanceOf(RunNotOpenError);
    await expect(vm.attachTab(run.id, 'tab-late')).rejects.toMatchObject({ reason: 'ended' });
    expect(store.appends, 'a tab.attached landed past the terminal event').toEqual([]);
    expect(vm.ownerOf('tab-late')).toBeUndefined();
    expect(vm.tabsOf(run.id)).toEqual([]);
    // The claim is about ORDER in the log, not just about the count.
    expect(store.log.get(run.id)!.map((e) => e.type)).toEqual(['run.created', 'run.cancelled']);
  });

  /**
   * The vacuous half of the same guard, and the shape `applyResolveDecision` records for its own: a run
   * this process is not holding cannot be shown to be open, so law 4's ownership read below has nothing
   * to decide against. Appending anyway claims a tab for a run no reader here can see.
   */
  it('refuses to attach a tab to a run this process is not holding', async () => {
    store.appends.length = 0;
    await expect(vm.attachTab('rZZZ', 'tab-orphan')).rejects.toMatchObject({ name: 'RunNotOpenError', reason: 'unknown' });
    expect(store.appends).toEqual([]);
    expect(vm.ownerOf('tab-orphan')).toBeUndefined();
  });

  /**
   * SD1 exit-16. A second terminal append is the same defect from the other side, and the quit path
   * reaches it: `open()`'s rollback ends the run it created, and a `shutdown()` that already cancelled
   * that run leaves the rollback writing `run.cancelled` on top of `run.cancelled`. Decided on the run
   * lane, so it is serialised against the terminal append rather than racing it.
   */
  it('writes nothing when a run that has already ended is ended again', async () => {
    const run = await vm.createRun({ task: 'ends once' });
    await vm.attachTab(run.id, 'tab-a');
    await vm.endRun(run.id, 'cancelled');
    store.appends.length = 0;

    await vm.endRun(run.id, 'completed');
    expect(store.appends, 'the log took a second terminal event for one ending').toEqual([]);
    expect(vm.snapshot(run.id)!.status).toBe('cancelled');
    expect(store.log.get(run.id)!.map((e) => e.type))
      .toEqual(['run.created', 'tab.attached', 'tab.detached', 'run.cancelled']);
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
 * perf SD1 exit-7 — what the FIRST live envelope after boot costs a condensed run.
 *
 * A run is condensed because it is long, and a live long run is exactly the one that emits next — so
 * this is the expected path, not the corner. It used to route through `adopt(replace)` → `replay` →
 * `readLog` from seq 0 with no total cap, and then retain with no projection, so nothing condensed it
 * again: one envelope after boot handed back the entire bound. At a hundred thousand envelopes that is
 * two hundred sequential broker round-trips and a hundred thousand `JSON.parse`s on the thread that
 * paints, and then the envelopes stay for the rest of the run's life.
 *
 * The instrument is the READ, not the resulting projection: the projection is identical either way,
 * which is precisely why this was invisible to every other arm in this file.
 */
describe('RunViewModel — a condensed live run stays condensed', () => {
  const restProjection = (store: FakeRunStore, runId: string) =>
    projectRun({ id: runId, ...store.facts.get(runId)! }, store.log.get(runId)!);

  /** A run past the re-materialization bound, condensed at boot, with a view-model watching it. */
  async function seedLong(): Promise<{ store: FakeRunStore; vm: RunViewModel; runId: string; tail: number }> {
    const store = new FakeRunStore();
    const run = await store.createRun({ task: 'a very long one', sessionId: 'sess-long' });
    for (let i = 0; i < REMATERIALIZE_MAX_EVENTS + 1; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    store.bootEventCapPerRun = 4;
    const vm = new RunViewModel(store);
    await vm.hydrate();
    return { store, vm, runId: run.id, tail: store.log.get(run.id)!.length };
  }

  it('answers one live envelope with a re-read of the projection, not of the log', async () => {
    const { store, vm, runId, tail } = await seedLong();
    expect(vm.retainedEventCount(runId), 'the oversize log was sent whole, so this arm proves nothing').toBe(0);
    expect(tail).toBeGreaterThan(REMATERIALIZE_MAX_EVENTS);
    store.reads.length = 0;
    store.eventReads.length = 0;

    // The production path: the store commits and fans the envelope out to the live tail.
    await store.appendEvent(runId, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-live' } });
    await vi.waitFor(() => expect(vm.ownerOf('tab-live')).toBe(runId));

    // Nothing re-read the log at all — and if a future implementation does read it, it must start at
    // or after the tail this projection already had, never from envelope zero.
    expect(store.eventReads.filter((r) => r.runId === runId), 'the log was paged back in').toHaveLength(0);
    for (const read of store.eventReads) {
      expect(read.since, 'the whole log was re-materialized from seq 0 by one live envelope').toBeGreaterThanOrEqual(tail);
    }
    // No round-trip at all: the envelope is at exactly `lastSeq + 1`, so it is folded into the kept
    // projection here. SD1 exit-12 answered this with `['getRun']`, which is the per-envelope cost exit-13
    // measured and this issue removes.
    expect(store.reads, 'a foldable envelope on a condensed run still bought a round-trip').toEqual([]);

    // The kept state survives the replay: still condensed, still the answer REST gives for this run.
    expect(vm.retainedEventCount(runId), 'the run was re-materialized and now holds its whole log').toBe(0);
    expect(vm.snapshot(runId)).toEqual(restProjection(store, runId));
    expect(vm.snapshot(runId)!.lastSeq).toBe(tail + 1);
    // The two facts a projection cannot rebuild for itself have to survive it too.
    expect(vm.sessionIdOf(runId)).toBe('sess-long');
    expect(vm.runForSession('sess-long')).toBe(runId);
  });

  it('never pages the log back in, however long the burst', async () => {
    const { store, vm, runId } = await seedLong();
    const burst = 20;
    store.reads.length = 0;
    store.eventReads.length = 0;

    for (let i = 0; i < burst; i++) {
      await store.appendEvent(runId, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    await vi.waitFor(() => expect(vm.snapshot(runId)!.cost.browserActions).toBe(REMATERIALIZE_MAX_EVENTS + burst + 1));

    // No read of any kind. SD1 exit-12 left this at "at most one round-trip per envelope", which is what
    // exit-13 measured as one round-trip per envelope forever; the fold makes it zero.
    expect(store.eventReads, 'a burst paged the log back in').toHaveLength(0);
    expect(store.reads, 'a burst past the bound still cost round-trips').toEqual([]);
    expect(vm.retainedEventCount(runId)).toBe(0);
  });

  /**
   * SD1 exit-13 — the read COUNT for a STREAM, which is the quantity SD1 exit-12's arms never inspected.
   *
   * The accepted steady state was "one bounded `getRun` per burst", and a burst window is one broker
   * round-trip: `adopt`'s in-flight coalescing paces the loop at 1/RTT, it does not end it. So a run
   * emitting one `cost.recorded` per browser action — the fifty-thousand-action run SD1 exit-12's own commit
   * message names — paid a projection read, on the child that serialises every other DB call, for
   * every envelope it would ever emit. This arm is the instrument: envelopes in, `getRun`s out.
   */
  it('costs no reads at all for a long stream past the bound', async () => {
    const { store, vm, runId } = await seedLong();
    const stream = 200;
    store.reads.length = 0;
    store.eventReads.length = 0;

    for (let i = 0; i < stream; i++) {
      await store.appendEvent(runId, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    await vi.waitFor(() => expect(vm.snapshot(runId)!.cost.browserActions).toBe(REMATERIALIZE_MAX_EVENTS + stream + 1));

    // On the shipped code this was 200 — one per envelope, for the life of the run.
    expect(store.reads.filter((r) => r === 'getRun'), 'the stream paid a projection read per envelope').toEqual([]);
    expect(store.reads, 'the stream read the store at all').toEqual([]);
    expect(store.eventReads, 'the stream paged the log back in').toHaveLength(0);
    // …and the two properties SD1 exit-12 bought are still bought: bounded memory, and the same answer REST
    // gives for the same log.
    expect(vm.retainedEventCount(runId), 'the fold started retaining envelopes again').toBe(0);
    expect(vm.snapshot(runId)).toEqual(restProjection(store, runId));
  });

  /**
   * The fold is `projectRun`'s own rules or it is a second source of truth (law 1). One mixed stream,
   * every projection-moving type the fold handles plus a type it must ignore and still advance past,
   * checked against the projection the store — and therefore REST — computes for the same log.
   */
  it('folds a mixed stream to exactly the projection the store computes', async () => {
    const { store, vm, runId } = await seedLong();
    store.reads.length = 0;

    const emit = async (type: string, payload: Record<string, unknown>): Promise<void> => {
      await store.appendEvent(runId, { actor: { kind: 'agent' }, type, payload });
    };
    await emit('tab.attached', { tabId: 'tab-a' });
    await emit('tab.attached', { tabId: 'tab-b' });
    await emit('cost.recorded', { kind: 'tokens_in', amount: 40 });
    await emit('presentation.promoted', { by: 'human' });
    await emit('tab.detached', { tabId: 'tab-a', reason: 'closed' });
    await emit('mark.placed', { mark: 7 });
    await emit('cost.recorded', { kind: 'spend_usd', amount: 1.5 });
    await emit('tab.attached', { tabId: 'tab-c' });
    await emit('presentation.demoted', { by: 'human' });

    const tail = store.log.get(runId)!.length;
    await vi.waitFor(() => expect(vm.snapshot(runId)!.lastSeq).toBe(tail));

    expect(vm.snapshot(runId)).toEqual(restProjection(store, runId));
    // The tab index moves with the fold, or law 4's refusal fires on a fact that is not in the log.
    expect(vm.ownerOf('tab-b')).toBe(runId);
    expect(vm.ownerOf('tab-c')).toBe(runId);
    expect(vm.ownerOf('tab-a'), 'a detach folded in place left the run owning the tab').toBeUndefined();
    expect(store.reads, 'a mixed foldable stream bought a round-trip').toEqual([]);
  });

  /**
   * The named exception, and the reason it is one. `Run` carries `status` but not the `pausedReason`
   * `statusFrom` decides it from, so a pause/resume/decision envelope cannot be folded onto a kept
   * projection without GUESSING which of two states produced `needs_you`. Guessing puts a wrong status
   * on a run, which is worse than a round-trip on an event that happens at human scale. So those types
   * keep SD1 exit-12's re-read — and it stays exactly one, and the run stays condensed.
   */
  it('buys one round-trip for a status-moving envelope, and only one', async () => {
    const { store, vm, runId } = await seedLong();
    store.reads.length = 0;
    store.eventReads.length = 0;

    await store.appendEvent(runId, { actor: { kind: 'system' }, type: 'run.paused', payload: { reason: 'cost_cap' } });
    await vi.waitFor(() => expect(vm.snapshot(runId)!.status).toBe('needs_you'));

    expect(store.reads, 'a status envelope on a condensed run cost more than the projection read').toEqual(['getRun']);
    expect(store.eventReads, 'a status envelope paged the log back in').toHaveLength(0);
    expect(vm.retainedEventCount(runId)).toBe(0);
    expect(vm.snapshot(runId)).toEqual(restProjection(store, runId));

    // And the fold resumes for free straight afterwards — the round-trip is per status event, not a
    // door back into the per-envelope loop.
    store.reads.length = 0;
    await store.appendEvent(runId, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    await vi.waitFor(() => expect(vm.snapshot(runId)!.lastSeq).toBe(store.log.get(runId)!.length));
    expect(store.reads, 'the fold did not resume after a status envelope').toEqual([]);
    expect(vm.snapshot(runId)).toEqual(restProjection(store, runId));
  });

  /**
   * A gap is still the one thing that buys the round-trip — the non-goal in this issue, kept as an
   * assertion rather than as prose. A fold that absorbed an envelope from the future would leave a log
   * silently disagreeing with the store, which is the defect the gap arm exists to prevent.
   */
  it('still replays a condensed run on a real seq gap', async () => {
    const { store, vm, runId } = await seedLong();
    const tail = store.log.get(runId)!.length;
    store.reads.length = 0;
    store.eventReads.length = 0;

    vm.applyEvent(runId, {
      seq: tail + 4, ts: new Date().toISOString(), actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-phantom' },
    });

    await vi.waitFor(() => expect(store.reads).toEqual(['getRun']));
    expect(store.eventReads, 'the gap re-read a log it was about to drop').toHaveLength(0);
    expect(vm.ownerOf('tab-phantom'), 'the phantom envelope was folded in as if nothing were missing').toBeUndefined();
    expect(vm.snapshot(runId)!.lastSeq).toBe(tail);
    expect(vm.retainedEventCount(runId)).toBe(0);
  });

  /**
   * The control, and the reason the bound is on LENGTH rather than on "was it condensed".
   *
   * Condensing is not only about one run's size: a short run at the end of a full boot page is
   * condensed by the page's budget. That one is far better off holding its envelopes and folding the
   * next one for free, so it is materialized — which is also what keeps the clock-driven status
   * re-read of a short condensed run working the way the auto-deny arms below pin it.
   */
  it('still materializes a condensed run whose log is under the bound', async () => {
    const store = new FakeRunStore();
    const run = await store.createRun({ task: 'an ordinary one' });
    for (let i = 0; i < 12; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } });
    }
    store.bootEventCapPerRun = 4;
    const vm = new RunViewModel(store);
    await vm.hydrate();
    expect(vm.retainedEventCount(run.id)).toBe(0);
    store.eventReads.length = 0;

    await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-new' } });
    await vi.waitFor(() => expect(vm.ownerOf('tab-new')).toBe(run.id));

    expect(vm.retainedEventCount(run.id), 'a short condensed run was left unable to fold its next envelope').toBeGreaterThan(0);
    expect(store.eventReads.some((r) => r.since === 0), 'the short log was never actually read back').toBe(true);
    expect(vm.snapshot(run.id)).toEqual(restProjection(store, run.id));
  });
});

/**
 * perf SD1 exit-12 (F1) — what a run that was never condensed costs while it is still running.
 *
 * The bound above was only ever consulted for a run that BOOTED condensed. A run created in this
 * process, or adopted while it was small, kept `kept === undefined` forever, so nothing re-applied
 * it: `applyEvent` appended every folded envelope and `seal` emptied the array only at a terminal
 * event. `cost.recorded` is one envelope per browser action by design, so a fifty-thousand-action
 * agent run held fifty thousand envelopes — order twenty megabytes — on the thread that paints, and
 * re-folded all of them on every memo miss for as long as it kept emitting. The run that pays this is
 * the busiest one on the machine, and it pays for the whole time a human is watching it.
 *
 * The instrument is what the process RETAINS, not the projection: the projection is identical either
 * way, which is why every other arm in this file is blind to it.
 */
describe('RunViewModel — a live run stops retaining envelopes at the bound', () => {
  const restProjection = (store: FakeRunStore, runId: string) =>
    projectRun({ id: runId, ...store.facts.get(runId)! }, store.log.get(runId)!);

  it('re-condenses a materialized run whose log crosses the bound while it is live', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'a fifty-thousand-action one', sessionId: 'sess-live' });

    const actions = REMATERIALIZE_MAX_EVENTS + 25;
    store.reads.length = 0;
    for (let i = 0; i < actions; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    await vi.waitFor(() => expect(vm.snapshot(run.id)!.cost.browserActions).toBe(actions));

    // The whole claim: the array does not grow with the run. On the shipped code it held every
    // envelope the run had ever emitted, so this equalled `actions + 1`.
    expect(
      vm.retainedEventCount(run.id),
      'a live run retained one envelope per browser action for its whole life',
    ).toBeLessThanOrEqual(REMATERIALIZE_MAX_EVENTS);
    // SD1 exit-13's instrument, on the arm that used to look only at retention: crossing the bound
    // costs the round-trips that CONDENSE the run, and the twenty-five envelopes behind the crossing
    // cost none. SD1 exit-12 paid one per envelope past the bound, so this was ~25.
    expect(store.reads.every((r) => r === 'getRun'), 'crossing the bound read something other than the projection').toBe(true);
    expect(
      store.reads.length,
      'the envelopes past the bound each paid a projection read',
    ).toBeLessThanOrEqual(2);
    // …and the run is still fully answerable, in the state every reader already handles for a run
    // that booted condensed — same projection REST gives, same tail, same session link.
    expect(vm.snapshot(run.id)).toEqual(restProjection(store, run.id));
    expect(vm.snapshot(run.id)!.lastSeq).toBe(store.log.get(run.id)!.length);
    expect(vm.sessionIdOf(run.id)).toBe('sess-live');
    expect(vm.runForSession('sess-live')).toBe(run.id);
  });

  /**
   * The control: the bound must not fire on the ordinary run, which is every run in this file. A short
   * live run keeps its envelopes and folds the next one for free — the same reason a short condensed
   * run is re-materialized rather than left condensed.
   */
  it('leaves a live run under the bound holding its envelopes', async () => {
    const store = new FakeRunStore();
    const vm = new RunViewModel(store);
    await vm.hydrate();
    const run = await vm.createRun({ task: 'an ordinary one' });
    store.reads.length = 0;

    for (let i = 0; i < 12; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}` } });
    }
    await vi.waitFor(() => expect(vm.ownerOf('tab-11')).toBe(run.id));

    expect(vm.retainedEventCount(run.id), 'the bound fired on a run nowhere near it').toBe(13);
    expect(store.reads, 'folding a short live run cost a round-trip').toEqual([]);
    expect(vm.snapshot(run.id)).toEqual(restProjection(store, run.id));
  });

  /**
   * The other half of the same gap: `replayOnce` asks `overBound` FIRST, and for a materialized run it
   * used to answer false whatever the log's length. So a dropped notify on a huge live run took
   * `readLog` — sequential broker pages at five hundred a time, parsed on the thread that paints — and
   * then retained every envelope it had just read, which is the state this issue exists to end.
   */
  it('condenses a gap replay on a materialized over-bound run instead of paging its log back in', async () => {
    const store = new FakeRunStore();
    const run = await store.createRun({ task: 'a long one', sessionId: 'sess-gap' });
    for (let i = 0; i < REMATERIALIZE_MAX_EVENTS; i++) {
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    const vm = new RunViewModel(store);
    await vm.hydrate();
    const tail = store.log.get(run.id)!.length;
    expect(
      vm.retainedEventCount(run.id),
      'boot condensed this run, so the materialized arm proves nothing',
    ).toBeGreaterThan(REMATERIALIZE_MAX_EVENTS);
    store.reads.length = 0;
    store.eventReads.length = 0;

    // An envelope from the future, as a tail that dropped the ones before it would deliver.
    vm.applyEvent(run.id, {
      seq: tail + 4, ts: new Date().toISOString(), actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: 'tab-phantom' },
    });

    await vi.waitFor(() => expect(vm.retainedEventCount(run.id)).toBe(0));
    expect(store.eventReads, 'the gap re-read a log it was about to drop').toHaveLength(0);
    expect(store.reads, 'the gap cost more than the one read that asks for the projection').toEqual(['getRun']);
    expect(vm.snapshot(run.id)).toEqual(restProjection(store, run.id));
    expect(vm.snapshot(run.id)!.lastSeq).toBe(tail);
    expect(vm.ownerOf('tab-phantom'), 'the phantom envelope was folded in as if nothing were missing').toBeUndefined();
    expect(vm.sessionIdOf(run.id)).toBe('sess-gap');
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
  private tailGate: Promise<void> | undefined;
  private drops = 0;

  constructor(private readonly inner: FakeRunStore) {
    this.inner.onRunEvent((runId, event) => {
      if (this.drops > 0) { this.drops--; return; }
      for (const h of this.handlers) h(runId, event);
    });
  }

  /** The next `n` committed envelopes never reach the live tail — the dropped notify a gap means. */
  dropNextNotify(n = 1): void { this.drops = n; }

  /**
   * Hold the next EMPTY `eventsSince` answer — the last page of a replay, the one that tells
   * `readLog` it has reached the tail.
   *
   * `park('eventsSince')` cannot express this: it holds the FIRST page, and `readLog` then asks for
   * the next one against a store that has moved on, so the envelope the test is trying to lose gets
   * picked up by the same read and the race never happens. The wire state that loses it is the other
   * end of the same read — every page fetched, the terminating empty one still crossing the pipe —
   * because that is the answer `retain` is about to pin `lastSeq` to.
   */
  parkTailPage(): () => void {
    let release!: () => void;
    this.tailGate = new Promise<void>((resolve) => { release = () => resolve(); });
    return release;
  }

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
    const page = await this.inner.eventsSince(runId, since, limit);
    if (page.length === 0 && this.tailGate) {
      const gate = this.tailGate;
      this.tailGate = undefined;
      await gate;
    }
    return this.hold('eventsSince', page);
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

/**
 * SD1 exit-9 finding K2 — the OTHER adoption race, the one `describe` above did not cover.
 *
 * That one is about a gap: a replace replay deduped against a non-replace one. This one is about a
 * run this projection has never seen at all, which `applyEvent` answers with a NON-replace adopt.
 * That arm is reached once per envelope until the adoption retains a log, so a second envelope
 * landing while the first one's read is on the wire used to coalesce into a replay that had already
 * read past it — and `again` was set by `opts.replace` alone, so nothing asked for the pass that
 * would have picked it up. `retain` then pins `lastSeq` below the envelope, and a heal needs a LATER
 * envelope to open a gap, so when the lost one was the run's last there is no later envelope and
 * never will be.
 *
 * A run created over REST reaches this path and only this path: its envelopes arrive through
 * `store.onRunEvent` with nothing in this process having written them.
 */
describe('RunViewModel — an envelope that lands while an unknown run is being adopted', () => {
  it('still heals when the racing envelope was the run’s last', async () => {
    const inner = new FakeRunStore();
    const store = new ParkableStore(inner);
    // Created before this projection existed, by another writer. `hydrate` is never called, so the
    // only way this run can ever appear here is the unknown-run arm of `applyEvent`.
    const run = await inner.createRun({ task: 'settle the invoice' });
    const vm = new RunViewModel(store);
    expect(vm.list(), 'the run was already known, so the unknown-run arm is not what runs').toEqual([]);

    const deliverTail = store.parkTailPage();
    // A — the envelope that wakes the run. Its adoption pages to the tail and parks there.
    await inner.appendEvent(run.id, { actor: { kind: 'agent', driver: 'studio' }, type: 'tab.attached', payload: { tabId: 'tab-9' } });
    await vi.waitFor(() => expect(inner.eventReads.map((r) => r.since)).toEqual([0, 2]));

    // B — committed while that read is still on the wire. `applyEvent` finds no log yet, so it asks
    // to adopt again; the store has moved, the read in flight has not, and B is terminal.
    await inner.appendEvent(run.id, { actor: { kind: 'system' }, type: 'run.completed', payload: {} });
    deliverTail();

    await vi.waitFor(() => expect(vm.snapshot(run.id)?.status, 'the app said running for a run the store had already finished').toBe('done'));
    expect(vm.ownerOf('tab-9'), 'the heal dropped the envelope that started the adoption').toBe(run.id);
    // The REST surface projects the SAME log fresh on every request. One log, one answer (law 1).
    expect(vm.snapshot(run.id)!.status).toBe((await inner.getRun(run.id))!.status);
  });

  it('ends the adopted log gapless when the racing envelope was not the last', async () => {
    const inner = new FakeRunStore();
    const store = new ParkableStore(inner);
    const run = await inner.createRun({ task: 'reconcile the ledger' });
    const vm = new RunViewModel(store);

    const deliverTail = store.parkTailPage();
    await inner.appendEvent(run.id, { actor: { kind: 'agent', driver: 'studio' }, type: 'tab.attached', payload: { tabId: 'tab-9' } });
    await vi.waitFor(() => expect(inner.eventReads.map((r) => r.since)).toEqual([0, 2]));

    await inner.appendEvent(run.id, { actor: { kind: 'agent', driver: 'studio' }, type: 'tab.attached', payload: { tabId: 'tab-b' } });
    deliverTail();

    await vi.waitFor(() => expect(vm.tabsOf(run.id)).toEqual(['tab-9', 'tab-b']));
    // The hole itself, not a symptom of it: a live run holds its envelopes, so what it holds and
    // what the store holds are the same count or the log has a gap in it.
    expect(vm.retainedEventCount(run.id), 'the adopted log is missing a seq').toBe(inner.log.get(run.id)!.length);
  });
});

/**
 * SD1 exit-9 finding K6 — a fan-out is not a request. Nothing retries it and nothing replays it.
 *
 * `publishRunEvent` on the core side has isolated its subscribers from each other since it was
 * written, with the rationale in a comment above it. The Electron-main fan-out did not, and it is
 * the one that matters more: it is called from `applyEvent`, which is the broker's live-tail
 * callback, so a listener's throw had no caller to reach and became an uncaught exception on the
 * main event loop — the process that owns the menu bar going down because a surface had a bug.
 */
describe('RunViewModel — one listener cannot take the fan-out down with it', () => {
  const collect = (into: Array<{ ms: number; fire: () => void }>) => (cb: () => void, ms: number): (() => void) => {
    const entry = { ms, fire: cb };
    into.push(entry);
    return () => { into.splice(into.indexOf(entry), 1); };
  };

  it('isolates every listener: a throw reaches neither the caller nor the siblings', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const store = new FakeRunStore();
      // Collected timers, so the 16 ms coalescing window closes when this test says so and the
      // second fold below is a second FAN-OUT rather than one folded into the first.
      const timers: Array<{ ms: number; fire: () => void }> = [];
      const vm = new RunViewModel(store, () => new Date(), collect(timers));
      const fired: string[] = [];
      // The three real subscribers, in the order `index.ts` registers them.
      vm.onChange(() => { fired.push('state-push'); });
      vm.onChange(() => { throw new Error('the menu template blew up'); });
      vm.onChange(() => { fired.push('presentation'); });

      const run = await vm.createRun({ task: 'fan out' });
      expect(fired, 'the throwing listener starved the one after it').toEqual(['state-push', 'presentation']);

      // …and the next fold too, which is the half a one-off try/catch at the call site would miss.
      fired.length = 0;
      await vm.attachTab(run.id, 'tab-a');
      timers.filter((t) => t.ms === EMIT_COALESCE_MS).forEach((t) => { t.fire(); });
      expect(fired).toEqual(['state-push', 'presentation']);

      expect(stderr.mock.calls.join(''), 'the throw was swallowed silently').toMatch(/run-projection listener threw/);
    } finally {
      stderr.mockRestore();
    }
  });
});

/**
 * SD1 exit-9 finding P1 — the boot allowance was a LOCAL of each page, so paging multiplied it.
 *
 * The store bounds one boot frame: `runListLogs` spends an event allowance over the runs on its page
 * and answers the rest with projections, so no single frame can stall the thread that paints. But
 * `hydrate` follows the listing cursor for up to two hundred pages, and every one of those calls
 * started its allowance again from full — so what boot loaded and held was `pages × the per-frame
 * bound`, and nothing evicts afterwards. The listing carries no status filter either, so runs that
 * ended months ago were read, parsed and retained exactly like live ones.
 *
 * The instrument is what is RETAINED, not what is projected: every arm below sees the same
 * projections either way, which is exactly why this survived the rest of this file.
 */
describe('RunViewModel — the boot allowance is carried across pages, not reset per page', () => {
  const PAGE_RUNS = 4;
  const EVENTS_PER_RUN = 3;
  /** The store's per-CALL allowance — `MAX_BOOT_EVENTS_TOTAL`, forced small. */
  const PER_CALL = 6;
  const PAGES = 5;

  /** `PAGES` pages of `PAGE_RUNS` runs, each holding `EVENTS_PER_RUN` envelopes. Newest last. */
  async function seedPages(): Promise<FakeRunStore> {
    const store = new FakeRunStore();
    store.listLimit = PAGE_RUNS;
    store.bootEventCapTotal = PER_CALL;
    for (let i = 0; i < PAGE_RUNS * PAGES; i++) {
      const run = await store.createRun({ task: `run ${i}`, sessionId: `sess-${i}` });
      for (let e = 1; e < EVENTS_PER_RUN; e++) {
        await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'tab.attached', payload: { tabId: `tab-${i}-${e}` } });
      }
    }
    return store;
  }

  const retainedTotal = (store: FakeRunStore, vm: RunViewModel) =>
    [...store.facts.keys()].reduce((n, id) => n + vm.retainedEventCount(id), 0);

  it('bounds what the whole hydration retains, rather than the per-page allowance times the pages', async () => {
    const store = await seedPages();
    const vm = new RunViewModel(store);
    store.reads.length = 0;

    const budget = PER_CALL + 1;
    await vm.hydrate({ eventBudget: budget });

    // The bound is the allowance plus at most ONE page: the page that spends the last of it is
    // finished rather than torn in half, because an entry refused mid-page has no projection to keep
    // in place of its envelopes.
    const retained = retainedTotal(store, vm);
    expect(retained, 'the hydration retained more than its allowance plus the page that spent it').toBeLessThanOrEqual(budget + PER_CALL);
    // …and the inversion this arm exists for. With the allowance reset per call — the shipped
    // behaviour before this — every one of the five pages retained a full `PER_CALL` of envelopes.
    expect(retained, 'the allowance was still being handed out once per page').toBeLessThan(PER_CALL * PAGES);
    // The frames stop too, not just the retention: once the allowance is spent the remaining pages
    // come from `listRuns`, so the envelopes never cross the pipe and are never parsed.
    expect(store.reads.filter((r) => r === 'listRunLogs').length, 'a page still asked for envelopes it would not keep').toBeLessThan(PAGES);
    expect(store.reads.filter((r) => r === 'listRuns').length, 'no page fell back to projections at all').toBeGreaterThan(0);
  });

  it('still names every run, and projects a run it did not keep envelopes for exactly as REST does', async () => {
    const store = await seedPages();
    const vm = new RunViewModel(store);
    await vm.hydrate({ eventBudget: PER_CALL + 1 });

    // Law 1: the bound is on what is HELD, never on which runs exist. Every seeded run is still named
    // and still projects to the store's own answer — that is what makes this a cost bound and not a
    // second account of the machine.
    const ids = [...store.facts.keys()];
    expect(vm.list()).toHaveLength(ids.length);
    for (const id of ids) expect(vm.snapshot(id)).toEqual(await store.getRun(id));

    // The run on the LAST page is the one the allowance never reached, so it is held as a projection
    // — and its tabs are still indexed from that projection, which is law 4 answered off a run whose
    // envelopes this process never saw.
    const last = ids[ids.length - 1]!;
    expect(vm.retainedEventCount(last), 'the last page kept its envelopes, so the allowance never tripped').toBe(0);
    expect(vm.ownerOf(`tab-${ids.length - 1}-1`)).toBe(last);
  });

  it('does not lose a session link a previous hydration already found', async () => {
    const store = await seedPages();
    const vm = new RunViewModel(store);
    const last = [...store.facts.keys()][store.facts.size - 1]!;
    const session = `sess-${store.facts.size - 1}`;

    // A first hydration with room for every page learns every session link — from `run.created` for
    // a run whose envelopes came, and from the store's own condensed entry for one whose did not.
    await vm.hydrate();
    expect(vm.runForSession(session)).toBe(last);

    // …and a second one that answers this run from `listRuns` must not UNSET it. A projection carries
    // no `run.created`, and the link is a fact fixed at creation, so a read that cannot see it is not
    // a read that says it is gone.
    store.reads.length = 0;
    await vm.hydrate({ eventBudget: PER_CALL + 1 });
    expect(store.reads.filter((r) => r === 'listRuns').length, 'no page fell back to projections, so this arm proves nothing').toBeGreaterThan(0);
    expect(vm.runForSession(session), 'the re-hydration dropped a session link it already had').toBe(last);
  });
});

/**
 * The corpus the event allowance is blind to: runs with FEW envelopes and LARGE payloads.
 *
 * The store charges its allowances at the READ, so a run it materializes and then condenses is paid
 * for in the child and arrives here with `events: []`. The hydration charged `entry.events.length` —
 * zero for exactly those runs — so its allowance never moved, `hydrate` kept taking the log branch for
 * all `MAX_HYDRATION_PAGES` of them, and every page handed the store a freshly reset per-call char
 * budget. Worst case was the page cap TIMES that budget, synchronously, in the child that serialises
 * every other read during boot.
 *
 * The instrument has to be the store's own read total across the WHOLE hydration. Retention cannot
 * see this — nothing is retained. One page cannot see it either: every individual page was already
 * within the store's budget, and the defect is that there were two hundred of them.
 */
describe('RunViewModel — a boot over condensed runs is bounded by what the store READ', () => {
  const PAGE_RUNS = 4;
  const PAGES = 5;
  /** The store's per-CALL char allowance — `MAX_BOOT_FRAME_CHARS`, forced small. */
  const PER_CALL_CHARS = 500;
  /**
   * So large that the event allowance cannot be what stops the loop. This arm is only about the char
   * one, and an event budget a condensed corpus could exhaust would let it pass for the wrong reason.
   */
  const EVENT_BUDGET = 1_000_000;

  /**
   * `PAGES` pages of `PAGE_RUNS` runs, each two envelopes long and each over `PER_CALL_CHARS` on its
   * own — so every run is read, charged, and then condensed. Two envelopes is the point: on a count,
   * this whole corpus is twenty runs and forty events, which is nothing.
   */
  async function seedCondensedPages(): Promise<FakeRunStore> {
    const store = new FakeRunStore();
    store.listLimit = PAGE_RUNS;
    store.bootCharCapTotal = PER_CALL_CHARS;
    const blob = 'x'.repeat(PER_CALL_CHARS);
    for (let i = 0; i < PAGE_RUNS * PAGES; i++) {
      const run = await store.createRun({ task: `run ${i}`, sessionId: `sess-${i}` });
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'run.progress', payload: { blob } });
    }
    return store;
  }

  it('stops paging on the store’s reported spend, not on the envelopes it was handed', async () => {
    const store = await seedCondensedPages();
    const vm = new RunViewModel(store);
    store.reads.length = 0;
    store.readEvents = 0;
    store.readChars = 0;

    await vm.hydrate({ eventBudget: EVENT_BUDGET, charBudget: PER_CALL_CHARS + 1 });

    // The premise, checked rather than assumed: the corpus really is one the event allowance cannot
    // stop. If it had spent that budget, this arm would pass on the mechanism it is not about.
    expect(store.readChars, 'nothing was read, so there is no spend for this arm to bound').toBeGreaterThan(0);
    expect(store.readEvents, 'the event allowance was spent, so the char one is not what stopped this')
      .toBeLessThan(EVENT_BUDGET);
    expect(vm.retainedEventCount([...store.facts.keys()][0]!), 'a run was retained, so nothing was condensed').toBe(0);

    // The bound: the allowance plus at most the page that spent the last of it — the same shape the
    // event allowance carries, for the same reason. A page is finished rather than torn in half.
    expect(store.readChars, 'the hydration read more than its allowance plus the page that spent it')
      .toBeLessThanOrEqual(PER_CALL_CHARS + 1 + PER_CALL_CHARS);
    // …and the inversion. Before this, `events.length` charged zero for every condensed entry, so the
    // allowance never moved and all five pages asked for envelopes — each against a fresh per-call
    // budget. That is the multiplication, and it is what this number would be.
    expect(store.readChars, 'the store’s per-call budget was still being handed out once per page')
      .toBeLessThan(PER_CALL_CHARS * PAGES);
    expect(store.reads.filter((r) => r === 'listRunLogs').length, 'a page still asked for envelopes the store would only condense')
      .toBeLessThan(PAGES);
    expect(store.reads.filter((r) => r === 'listRuns').length, 'no page fell back to projections at all').toBeGreaterThan(0);
  });

  it('still names every run and projects it exactly as the store does', async () => {
    const store = await seedCondensedPages();
    const vm = new RunViewModel(store);
    await vm.hydrate({ eventBudget: EVENT_BUDGET, charBudget: PER_CALL_CHARS + 1 });

    // Law 1: the bound is on cost, never on which runs exist. Every seeded run is still named, and
    // still projects to the store's own answer — including the ones the char allowance never reached.
    const ids = [...store.facts.keys()];
    expect(vm.list()).toHaveLength(ids.length);
    for (const id of ids) expect(vm.snapshot(id)).toEqual(await store.getRun(id));
  });
});

/**
 * The corpus the store answers WITHOUT materializing anything: every run rejected by the size probe.
 *
 * The store rules a run out with a scan of its stored payloads before it reads a single envelope, so
 * this boot ships no envelopes and parses no logs — and it still costs the child a full payload scan
 * per page. That scan used to be charged only on the branch it guards, so a page of runs the probe
 * itself rejected reported zero, the hydration's allowance never moved, and `hydrate` took the log
 * branch for all `MAX_HYDRATION_PAGES` of them — each one handing the store a freshly reset per-call
 * budget to scan against.
 *
 * The instrument is the store's read total across the WHOLE hydration, as above. What separates this
 * arm from that one is that nothing here is ever materialized: `readEvents` stays zero, so any bound
 * that comes from the event allowance or from retention cannot be what stopped it.
 */
describe('RunViewModel — a boot the store answers from the size probe alone is still bounded', () => {
  const PAGE_RUNS = 4;
  const PAGES = 5;
  /** The store's per-CALL char allowance — `MAX_BOOT_FRAME_CHARS`, forced small. */
  const PER_CALL_CHARS = 500;
  const EVENT_BUDGET = 1_000_000;

  /**
   * `PAGES` pages of one-envelope runs whose single stored payload is over `PER_CALL_CHARS` on its
   * own — so the probe rejects each of them without the log ever being read.
   */
  async function seedProbeRejectedPages(): Promise<FakeRunStore> {
    const store = new FakeRunStore();
    store.listLimit = PAGE_RUNS;
    store.bootCharCapTotal = PER_CALL_CHARS;
    const blob = 'x'.repeat(PER_CALL_CHARS);
    for (let i = 0; i < PAGE_RUNS * PAGES; i++) {
      const run = await store.createRun({ task: `run ${i}`, sessionId: `sess-${i}` });
      await store.appendEvent(run.id, { actor: { kind: 'agent' }, type: 'run.progress', payload: { blob } });
    }
    return store;
  }

  it('stops paging on what the probe scanned, not on what the probe let through', async () => {
    const store = await seedProbeRejectedPages();
    const vm = new RunViewModel(store);
    store.reads.length = 0;
    store.readEvents = 0;
    store.readChars = 0;

    await vm.hydrate({ eventBudget: EVENT_BUDGET, charBudget: PER_CALL_CHARS + 1 });

    // The premise, checked rather than assumed: the store scanned, and it materialized nothing. An
    // arm that let a single log be read would be the previous one wearing a different name.
    expect(store.readChars, 'nothing was scanned, so there is no spend for this arm to bound').toBeGreaterThan(0);
    expect(store.readEvents, 'a log was materialized, so the probe is not what rejected these runs').toBe(0);

    // The bound: the allowance plus at most the page that spent the last of it.
    expect(store.readChars, 'the hydration scanned more than its allowance plus the page that spent it')
      .toBeLessThanOrEqual(PER_CALL_CHARS + 1 + PER_CALL_CHARS * 2);
    // …and the inversion. With the probe uncharged every page reported zero, so the allowance never
    // moved and all `PAGES` of them asked for envelopes — each against a per-call budget handed out
    // fresh. That multiplication is what this counts.
    expect(store.reads.filter((r) => r === 'listRunLogs').length, 'a page still asked for envelopes the store would only condense')
      .toBeLessThan(PAGES);
    expect(store.reads.filter((r) => r === 'listRuns').length, 'no page fell back to projections at all').toBeGreaterThan(0);

    // Law 1 again: the bound is on cost, never on which runs exist.
    const ids = [...store.facts.keys()];
    expect(vm.list()).toHaveLength(ids.length);
    for (const id of ids) expect(vm.snapshot(id)).toEqual(await store.getRun(id));
  });
});

/**
 * A store that can be taken away and given back, so a read failure is a state a test can FORCE
 * rather than a flake it has to wait for.
 *
 * The notify tail keeps working while the reads are down, which is the shape that matters: the
 * broker fans an envelope out over its notify channel before — and independently of — answering any
 * read, so "the run's only envelope arrived" and "the read that would adopt it failed" are two
 * facts that coincide rather than contradict. A store that lost its notifies at the same moment
 * would never deliver the envelope at all, and the defect would be unreachable.
 */
class UnreachableStore implements RunStoreClient {
  private readonly handlers: Array<(runId: string, event: RunEvent) => void> = [];
  /** Every read refused while the store was down, in order — the instrument for "it really failed". */
  readonly refused: string[] = [];
  down = false;

  constructor(private readonly inner: FakeRunStore) {
    this.inner.onRunEvent((runId, event) => { for (const h of this.handlers) h(runId, event); });
  }

  private guard(method: string): void {
    if (!this.down) return;
    this.refused.push(method);
    throw new Error('broker unreachable');
  }

  createRun(input: CreateRunInput) { return this.inner.createRun(input); }
  appendEvent(runId: string, event: RunEventInput) { return this.inner.appendEvent(runId, event); }
  listRuns(opts?: ListRunsOptions) { return this.inner.listRuns(opts); }
  runExists(runId: string) { return this.inner.runExists(runId); }
  async getRun(runId: string) { this.guard('getRun'); return this.inner.getRun(runId); }
  async runFacts(runId: string) { this.guard('runFacts'); return this.inner.runFacts(runId); }
  async listRunLogs(opts?: ListRunsOptions) { this.guard('listRunLogs'); return this.inner.listRunLogs(opts); }
  async eventsSince(runId: string, since: number, limit: number) {
    this.guard('eventsSince');
    return this.inner.eventsSince(runId, since, limit);
  }
  onRunEvent(handler: (runId: string, event: RunEvent) => void): void { this.handlers.push(handler); }

  private readonly readyHandlers: Array<() => void> = [];
  onReady(handler: () => void): void { this.readyHandlers.push(handler); }
  /**
   * The respawn edge, driven by hand. The real client publishes this on the child's `ready` notify,
   * which arrives at boot and again after every respawn — so firing it is reproducing "the background
   * service came back", which is the one fact backoff could never learn.
   */
  announceReady(): void { for (const h of [...this.readyHandlers]) h(); }
}

/** A drivable clock for the retry backoff — the retries are the only timers these arms schedule. */
function retryTimers() {
  const pending: Array<{ ms: number; fire: () => void; cancelled: boolean }> = [];
  const setTimer = (cb: () => void, ms: number): (() => void) => {
    const entry = { ms, fire: cb, cancelled: false };
    pending.push(entry);
    return () => { entry.cancelled = true; };
  };
  /** Fire every timer scheduled so far, oldest first, skipping the ones that were cancelled. */
  const fireDue = (): number => {
    const due = pending.splice(0);
    let fired = 0;
    for (const t of due) if (!t.cancelled) { t.fire(); fired++; }
    return fired;
  };
  const live = () => pending.filter((t) => !t.cancelled);
  return { pending, setTimer, fireDue, live };
}

/**
 * Let an adoption finish failing.
 *
 * `refused` is pushed inside the store's guard, BEFORE the throw has propagated back through
 * `replay`'s catch to the line that schedules the retry — so waiting on the refusal count can arrive
 * a microtask early and read a chain that has not been armed yet. Everything between the two is a
 * microtask (the fake store does no I/O), so one macrotask turn drains all of it; several, so the
 * arms below never depend on counting the hops.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => { setTimeout(resolve, 0); });
}

/**
 * SD1 exit-final-1 — a failed adoption was never retried, so a REST-created run could be invisible
 * for the life of the app.
 *
 * `replay` swallowed the store's failure with "a later event retries", which is true for a run this
 * projection is already folding — the next envelope opens a gap and heals it — and FALSE for the one
 * class of run the unknown-run arm exists to catch. A run created over REST has exactly one envelope
 * the REST surface will ever append: its `run.created`. If the broker read that would adopt it fails
 * at that moment, no later envelope is coming, so nothing ever retries and the run is in the store,
 * in REST's own answer, and in no surface this app owns — not `list`, not `listLive`, not the tray,
 * not the state push — until the app is restarted. One log, two answers; law 1, and the SD1 exit
 * clause "run id visible everywhere" failing for exactly the run class the gate is about.
 */
describe('RunViewModel — an adoption the store refused is retried, not dropped', () => {
  it('makes a run visible once the store is reachable again, with no further envelope and no restart', async () => {
    const inner = new FakeRunStore();
    const store = new UnreachableStore(inner);
    const timers = retryTimers();
    const vm = new RunViewModel(store, () => new Date(), timers.setTimer);
    let pushes = 0;
    vm.onChange(() => { pushes++; });

    // The race, forced: the broker's reads are down at the moment the run's ONLY envelope is fanned
    // out. Nothing else will ever append to this run — that is what makes it the REST-created class.
    store.down = true;
    const run = await inner.createRun({ task: 'created over REST' });

    await settle();
    expect(store.refused.length, 'the read never actually failed, so this arm proves nothing').toBeGreaterThan(0);
    expect(vm.list(), 'the adoption succeeded despite the store being down').toEqual([]);
    expect(vm.listLive(), 'the run was live somewhere while the adoption had failed').toEqual([]);

    // The store comes back — and stays silent. Only the retry the failure scheduled can find the run.
    const scheduled = timers.live().map((t) => t.ms);
    store.down = false;
    timers.fireDue();
    await settle();

    expect(vm.list().map((r) => r.id), 'the run stayed invisible after the store recovered').toEqual([run.id]);
    expect(scheduled, 'the run was found by something other than one backoff step').toEqual([ADOPT_RETRY_BASE_MS]);
    expect(vm.snapshot(run.id)?.task).toBe('created over REST');
    expect(vm.listLive().map((r) => r.id), 'the run recovered into `list` but not into the live set the tray reads').toEqual([run.id]);
    expect(pushes, 'the surfaces were never told the projection had moved').toBeGreaterThan(0);
  });

  it('stops retrying a store that never comes back, rather than spinning on a dead broker', async () => {
    const inner = new FakeRunStore();
    const store = new UnreachableStore(inner);
    const timers = retryTimers();
    const vm = new RunViewModel(store, () => new Date(), timers.setTimer);

    store.down = true;
    const run = await inner.createRun({ task: 'the broker is gone' });
    await settle();
    expect(store.refused.length, 'the read never actually failed, so this arm proves nothing').toBeGreaterThan(0);

    // Drive the whole chain. Each attempt fails and schedules the next, so this terminates only
    // because the count is bounded — the loop guard is what would catch it if it were not.
    const delays: number[] = [];
    for (let round = 0; round <= MAX_ADOPT_RETRIES + 2; round++) {
      const next = timers.live();
      if (next.length === 0) break;
      expect(next, 'one failure scheduled more than one retry').toHaveLength(1);
      delays.push(next[0]!.ms);
      timers.fireDue();
      await settle();
    }

    expect(delays, 'the backoff neither doubled nor stopped at the ceiling').toEqual([250, 500, 1000, 2000, 4000, 8000, 16000, 30000]);
    expect(delays).toHaveLength(MAX_ADOPT_RETRIES);
    expect(delays[delays.length - 1]).toBe(ADOPT_RETRY_MAX_MS);
    expect(timers.live(), 'the retry chain never terminated').toHaveLength(0);
    expect(vm.list()).toEqual([]);

    // …and an exhausted chain is not re-armed by the next envelope that fails the same way, or a
    // half-dead broker — one that still fans notifies out while its reads refuse — would buy a fresh
    // chain of eight timers per envelope, which is more spin than the swallow it replaced.
    const refusedBefore = store.refused.length;
    await inner.appendEvent(run.id, { actor: { kind: 'daemon' }, type: 'tab.attached', payload: { tabId: 'tab-1' } });
    await settle();
    expect(store.refused.length, 'the later envelope did not reach the store at all').toBeGreaterThan(refusedBefore);
    expect(timers.live(), 'an exhausted chain was re-armed by a later failing envelope').toHaveLength(0);
  });

  /**
   * SD1 exit-16 — the hole the count bound left, and the trigger that closes it.
   *
   * Eight attempts is about 62 seconds. A run created over REST has exactly one envelope the REST
   * surface will ever append, so a brownout that outlasts the chain leaves it with nothing to
   * re-trigger the adoption: the arm above pins that a later FAILING envelope must not re-arm it, and
   * for this run class there is no later envelope at all. The run is then in the store, in REST's own
   * answer, and in no surface this app owns until the app is restarted — which is the exact defect
   * the retry chain was added to remove, arriving one brownout later.
   *
   * `ADOPT_RETRY_BASE_MS` names the missing signal itself: "a health signal from the broker would be
   * the sharper trigger, and there is no such signal to subscribe to… reverse this the day the broker
   * publishes a reachability event." This is that day, and it is a strictly narrower trigger than the
   * one the arm above refuses — once per respawn, not once per refused envelope.
   */
  it('re-arms an exhausted adoption when the background service comes back, with no further envelope and no restart', async () => {
    const inner = new FakeRunStore();
    const store = new UnreachableStore(inner);
    const timers = retryTimers();
    const vm = new RunViewModel(store, () => new Date(), timers.setTimer);

    // The REST-created class: the reads are down when the run's ONLY envelope is fanned out.
    store.down = true;
    const run = await inner.createRun({ task: 'created over REST during a brownout' });
    await settle();

    // Force the exhaustion rather than wait for it — eight real backoff steps are 62 seconds.
    for (let round = 0; round <= MAX_ADOPT_RETRIES; round++) {
      if (timers.live().length === 0) break;
      timers.fireDue();
      await settle();
    }
    expect(timers.live(), 'the chain had not actually run out, so this arm proves nothing').toHaveLength(0);
    expect(store.refused.length, 'the reads never failed, so nothing was exhausted').toBeGreaterThan(MAX_ADOPT_RETRIES);
    expect(vm.list(), 'the run was adopted despite every read failing').toEqual([]);
    expect(vm.listLive(), 'the run was live somewhere while every adoption had failed').toEqual([]);

    // The service comes back and says so. Nothing else happens: no envelope is appended, no timer is
    // outstanding, and the app is not restarted — the respawn edge is the only thing that can find it.
    store.down = false;
    store.announceReady();
    await settle();

    expect(vm.list().map((r) => r.id), 'the run stayed invisible after the service came back').toEqual([run.id]);
    expect(vm.listLive().map((r) => r.id), 'the run recovered into `list` but not into the live set the tray reads').toEqual([run.id]);
    expect(vm.snapshot(run.id)?.task).toBe('created over REST during a brownout');
  });

  it('starts a fresh chain if the service goes down again, rather than re-arming into an exhausted one', async () => {
    // The re-arm is a new question, not a continuation: the store answered its `ready`, so a refusal
    // after it is a new outage. A re-arm that left the attempt count at nine would have been a single
    // no-op — one read per respawn forever, with the run never recovering from the second brownout.
    const inner = new FakeRunStore();
    const store = new UnreachableStore(inner);
    const timers = retryTimers();
    const vm = new RunViewModel(store, () => new Date(), timers.setTimer);

    store.down = true;
    const run = await inner.createRun({ task: 'two brownouts' });
    await settle();
    for (let round = 0; round <= MAX_ADOPT_RETRIES; round++) {
      if (timers.live().length === 0) break;
      timers.fireDue();
      await settle();
    }
    expect(timers.live()).toHaveLength(0);

    // The service announces itself while still refusing reads — a respawn into a second brownout.
    store.announceReady();
    await settle();
    expect(timers.live().map((t) => t.ms), 'the re-armed chain did not restart at the base backoff').toEqual([ADOPT_RETRY_BASE_MS]);

    store.down = false;
    timers.fireDue();
    await settle();
    expect(vm.list().map((r) => r.id)).toEqual([run.id]);
  });

  it('leaves a live chain alone when the service announces itself', async () => {
    // The trigger is for chains that have GIVEN UP. A re-arm that fired for every entry would cancel
    // a scheduled retry and issue an immediate read in its place — a broker flapping through respawns
    // would then be read once per flap, which is the spin the count bound exists to prevent.
    const inner = new FakeRunStore();
    const store = new UnreachableStore(inner);
    const timers = retryTimers();
    const vm = new RunViewModel(store, () => new Date(), timers.setTimer);

    store.down = true;
    await inner.createRun({ task: 'still retrying' });
    await vi.waitFor(() => expect(timers.live()).toHaveLength(1));

    const readsBefore = inner.reads.length;
    store.announceReady();
    await settle();

    expect(timers.live(), 'the pending retry was cancelled by an unrelated respawn').toHaveLength(1);
    expect(inner.reads.length, 'a respawn read the store behind a chain that was already going to').toBe(readsBefore);
  });

  it('cancels a pending retry once the run has been adopted by some other path', async () => {
    const inner = new FakeRunStore();
    const store = new UnreachableStore(inner);
    const timers = retryTimers();
    const vm = new RunViewModel(store, () => new Date(), timers.setTimer);

    store.down = true;
    const run = await inner.createRun({ task: 'adopted from elsewhere' });
    await vi.waitFor(() => expect(timers.live()).toHaveLength(1));

    // A boot reconcile finds the run first. The scheduled retry is now owed nothing, and firing it
    // must neither re-read the store nor leave a chain behind it.
    store.down = false;
    await vm.hydrate();
    expect(vm.list().map((r) => r.id)).toEqual([run.id]);

    const readsBefore = inner.reads.length;
    timers.fireDue();
    await vi.waitFor(() => expect(timers.live()).toHaveLength(0));
    expect(inner.reads.length, 'the cancelled retry still went to the store').toBe(readsBefore);
  });

  it('lets go of a pending retry at shutdown', async () => {
    const inner = new FakeRunStore();
    const store = new UnreachableStore(inner);
    const timers = retryTimers();
    const vm = new RunViewModel(store, () => new Date(), timers.setTimer);

    store.down = true;
    await inner.createRun({ task: 'quit while unreachable' });
    await vi.waitFor(() => expect(timers.live()).toHaveLength(1));

    vm.dispose();

    // A retry that outlives the app would read the store and fan out into torn-down listeners — the
    // same reason `dispose` already releases the horizons and the coalescing window.
    expect(timers.live(), 'a retry survived dispose').toHaveLength(0);
    store.down = false;
    const readsBefore = inner.reads.length;
    timers.fireDue();
    await vi.waitFor(() => expect(inner.reads.length).toBe(readsBefore));
  });
});

/**
 * Did a resolution actually COMMIT, whatever its reply did?
 *
 * A broker round-trip can fail after the write landed, and the retry behind `run-decisions`' durable
 * answer needs to tell that apart from a write that never happened — a retry that cannot appends a
 * second `decision.resolved` for one card. The projection cannot answer it: `pendingDecisions` drops
 * a card at its two-minute deadline as well as at its resolution.
 */
describe('RunViewModel — has a card\'s resolution reached the durable log', () => {
  let store: FakeRunStore;
  let vm: RunViewModel;
  let runId: string;

  beforeEach(async () => {
    store = new FakeRunStore();
    vm = new RunViewModel(store);
    await vm.hydrate();
    runId = (await vm.createRun({ task: 'buy the thing', sessionId: 'sess-1' })).id;
  });

  it('says no while the card is only requested, and yes once it is resolved', async () => {
    const floor = vm.lastSeqOf(runId);
    await vm.requestDecision(runId, { decisionId: 'ap-1', kind: 'money', prompt: 'pay $40' });

    expect(await vm.resolutionLanded(runId, 'ap-1', floor)).toBe(false);

    await vm.resolveDecision(runId, 'ap-1', 'approved', 'human');

    expect(await vm.resolutionLanded(runId, 'ap-1', floor)).toBe(true);
    // Scoped to the card, not to the run: a resolution for a DIFFERENT card is not this one's.
    expect(await vm.resolutionLanded(runId, 'ap-2', floor)).toBe(false);
  });

  /**
   * The trap `REPLAY_PAGE_SIZE` already records, on a second read: a SHORT page is what a server-side
   * per-frame ceiling looks like from here, so a probe that stopped on one would answer "not landed"
   * for a resolution sitting one envelope past the ceiling — and buy the double-append it exists to
   * prevent. It stops on an EMPTY page instead.
   */
  it('reads past a server-side page ceiling instead of stopping at the first short page', async () => {
    const floor = vm.lastSeqOf(runId);
    await vm.requestDecision(runId, { decisionId: 'ap-1', kind: 'money', prompt: 'pay $40' });
    // Filler envelopes between the floor and the resolution, so the window has to be PAGED to reach
    // it. Appended through the store because this is about the read, not about who wrote them.
    for (let i = 0; i < 6; i += 1) {
      await store.appendEvent(runId, { actor: { kind: 'system' }, type: 'cost.recorded', payload: { kind: 'browser_action', amount: 1 } });
    }
    await vm.resolveDecision(runId, 'ap-1', 'approved', 'human');

    store.eventsPageCeiling = 1; // every page the store can send is one envelope long
    store.eventReads.length = 0;

    expect(await vm.resolutionLanded(runId, 'ap-1', floor)).toBe(true);
    expect(store.eventReads.length).toBeGreaterThan(1);
  });
});
