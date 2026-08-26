import { describe, it, expect, vi } from 'vitest';
import type { DebuggerLike } from '../../src/main/cdp-transport';
import { createDriveEngine } from '../../src/main/drive-engine';
import { createStudioHost, type HostTab } from '../../src/main/studio-host';
import { makeFakeBroker } from '../helpers/fake-broker';
import { RunViewModel } from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';
import type { StudioCloseOutput, StudioListOutput, StudioToolError } from 'wigolo/studio';

/**
 * SD1 law 4, at the host seam.
 *
 * The old `SessionRegistry` kept a `tabIds` array in Electron main and a `tabToSession` map in the host,
 * and neither was ever consulted to REFUSE anything — the agent close path did not even clear them. This
 * pins the two properties that array could never have: a tab belongs to exactly one run, and the tabs the
 * human opened are a group no agent-facing answer can reach.
 */

function fakeDebugger(): DebuggerLike {
  let attached = false;
  return {
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    isAttached: () => attached,
    sendCommand: async (method: string) => {
      switch (method) {
        case 'Accessibility.getFullAXTree': return { nodes: [] };
        case 'DOM.getDocument': return { root: { nodeName: '#document', backendNodeId: 1, children: [] } };
        case 'Page.getLayoutMetrics': return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        default: return {};
      }
    },
    on: () => {},
    removeListener: () => {},
  };
}

const viewport = () => ({ width: 800, height: 600 });

/**
 * A host over a shared "window" tab universe: `openUserTab` puts a tab in it the way the human's ⌘T does
 * — created, painting, and with no ownership recorded. `nextTabId` lets a test hand the host a tab id
 * that is already spoken for, which is the only way to reach the double-attach refusal from outside.
 */
function makeHost(opts: { nextTabId?: () => string; breakRunStore?: boolean; breakAttach?: boolean; onNavigate?: (url: string) => Promise<void> } = {}) {
  const engine = createDriveEngine();
  const store = new FakeRunStore();
  if (opts.breakRunStore) store.createRun = async () => { throw new Error('studio background service unavailable'); };
  // A broker hiccup between `createRun` and the attach: the run is minted, the attach append is not. Only
  // that one event type fails, so the terminal event the rollback owes the run can still be written —
  // a store that refuses EVERY append would make "the run was left running" untestable and unfixable.
  if (opts.breakAttach) {
    const append = store.appendEvent.bind(store);
    store.appendEvent = async (runId, event) => {
      if (event.type === 'tab.attached') throw new Error('studio background service unavailable');
      return append(runId, event);
    };
  }
  const runs = new RunViewModel(store);
  /** Every tab the window holds — agent tabs and the human's alike, exactly as TabManager would. */
  const universe: string[] = [];
  /** The per-tab drive, so a test can watch the preemption FSM the human-input route reaches. */
  const drives = new Map<string, Awaited<ReturnType<typeof engine.attachTab>>>();
  /** Every url the host actually asked a tab to load — the instrument for work done on a dead session. */
  const navigations: string[] = [];
  let n = 0;
  const host = createStudioHost({
    runs,
    broker: makeFakeBroker(),
    onParked: () => {},
    createTab: async ({ initialHolder, grant }) => {
      const tabId = opts.nextTabId ? opts.nextTabId() : `t${++n}`;
      const drive = await engine.attachTab(tabId, { debugger: fakeDebugger(), viewport, grant, initialHolder });
      drives.set(tabId, drive);
      universe.push(tabId);
      const state = {
        navigate: vi.fn(async (u: string) => { navigations.push(u); await opts.onNavigate?.(u); }),
        url: 'about:blank',
      };
      const tab: HostTab = {
        tabId,
        drive,
        browser: { navigate: (u) => state.navigate(u) },
        currentUrl: () => state.url,
        readHtml: async () => '<html></html>',
        storageState: async () => ({ cookies: [] as never, origins: [] }),
        applyStorageState: async () => {},
      };
      return tab;
    },
    tabUniverse: () => universe,
    closeTab: (tabId) => { const at = universe.indexOf(tabId); if (at >= 0) universe.splice(at, 1); void engine.detachTab(tabId); },
  });
  const openUserTab = (id: string): string => { universe.push(id); return id; };
  return { host, runs, store, universe, openUserTab, drives, navigations };
}

describe('studio host — a run owns its tabs (law 4)', () => {
  it('records the session’s tab as an attach on the run the session spawned', async () => {
    const { host, runs, store } = makeHost();
    const { session_id } = await host.handlers.spawn({ startUrl: 'https://example.com/' }) as { session_id: string };

    const runId = runs.runForSession(session_id);
    expect(runId, 'opening a session minted no run — the session is the unit again').toBeTruthy();
    expect(runs.tabsOf(runId!)).toEqual(['t1']);
    expect(store.appends.map((a) => a.type)).toContain('tab.attached');
    // §7.3's linkage is a recorded fact, not a map the host keeps in step.
    expect(runs.sessionIdOf(runId!)).toBe(session_id);
  });

  // SD1 exit-9 (C1). Law 8's shared address space is only shared if the AGENT can read the id, and
  // `studio_list` is the one seam it reads it from — the id it needs to correlate its session to
  // `/v1/runs/{id}`. `runId` is optional on StudioSessionView, so dropping the key from the list spread,
  // or `runForSession` going undefined for a live session, typechecks clean and stays green everywhere
  // else; the sibling `tabIds` is pinned but this was not. `expected` is asserted truthy first so the
  // comparison cannot pass by both sides being undefined.
  it('names the session’s run id in the agent-visible listing, byte-equal to the run the session drives', async () => {
    const { host, runs } = makeHost();
    const { session_id } = await host.handlers.spawn({}) as { session_id: string };
    const expected = runs.runForSession(session_id);
    expect(expected, 'the control: the live session drives no run at all').toBeTruthy();

    const listed = await host.handlers.list() as StudioListOutput;
    const session = listed.sessions.find((s) => s.id === session_id)!;

    expect(session, 'the live session is missing from studio_list entirely').toBeTruthy();
    expect(session.runId, 'studio_list named no run id — the agent cannot reach /v1/runs/{id}').toBe(expected);
  });

  // SD1 exit-7. `studio_open`'s startUrl is agent-supplied and lands in an append-only log that has no
  // prune path by design and is served over `GET /v1/runs/{id}/events` plus the SSE tail. Hand the agent a
  // magic link and the whole secret is stored forever and readable by every client past the REST gate. The
  // assertion is on the STORED row, not on the input, because the input is what the leak travels in.
  it('stores the startUrl’s origin only, so a magic link’s token never enters the run log', async () => {
    const { host, store } = makeHost();
    await host.handlers.spawn({ startUrl: 'https://mail.example.com/login/verify?token=s3cr3t-reset&uid=42#inbox' });

    const attached = store.appends.find((a) => a.type === 'tab.attached');
    expect(attached, 'the session recorded no attach at all').toBeTruthy();
    expect(attached!.payload.url).toBe('https://mail.example.com');
    expect(JSON.stringify(store.appends), 'the token reached the durable run log').not.toContain('s3cr3t-reset');
  });

  it('gives two concurrent sessions two runs with disjoint tab groups', async () => {
    const { host, runs } = makeHost();
    const a = await host.handlers.spawn({}) as { session_id: string };
    const b = await host.handlers.spawn({}) as { session_id: string };
    const runA = runs.runForSession(a.session_id)!;
    const runB = runs.runForSession(b.session_id)!;

    expect(runA).not.toBe(runB);
    expect(runs.tabsOf(runA)).toEqual(['t1']);
    expect(runs.tabsOf(runB)).toEqual(['t2']);
    expect(runs.agentVisibleTabs(runA)).not.toContain('t2');
  });

  // Two agents never share a tab. A tab factory that hands back an id another run holds is the shape this
  // can take in production (a recycled id, a view adopted twice), and the seam refuses it outright rather
  // than reassigning — a silent steal would put one agent on another agent's page.
  it('refuses to open a session onto a tab another run already owns', async () => {
    const { host, runs, store } = makeHost({ nextTabId: () => 'recycled' });
    const first = await host.handlers.spawn({}) as { session_id: string };
    const runA = runs.runForSession(first.session_id)!;

    // A designed refusal, not an unhandled throw at the gateway (law 9).
    const second = await host.handlers.spawn({}) as StudioToolError;
    expect(second.error_reason).toBe('tab_already_owned');
    expect(second.hint).toMatch(/never share a tab/i);
    expect(runs.ownerOf('recycled'), 'the second session stole the first run’s tab').toBe(runA);
    expect(runs.sessionIdOf(runs.ownerOf('recycled')!)).toBe(first.session_id);
    // The half-open session is rolled back — one live session, not two, and the first still drives.
    expect(((await host.handlers.list()) as StudioListOutput).sessions.filter((x) => x.status === 'live')).toHaveLength(1);
    // …and so is the run the refused open minted a line before the attach was refused (SD1 exit-9, K1).
    const refused = [...store.facts.keys()].find((id) => id !== runA)!;
    expect((await store.getRun(refused))!.status, 'the refused open left a zombie run at running').toBe('cancelled');
    expect((await store.getRun(runA))!.status, 'the refusal ended the wrong run').toBe('running');
  });

  // A run that cannot be recorded is a run no surface can see and law 4 cannot police, so the session is
  // refused rather than started untracked — and refused as a tool result the agent can read.
  it('refuses to open a session at all when the run record cannot be written', async () => {
    const { host, universe } = makeHost({ breakRunStore: true });

    const out = await host.handlers.spawn({}) as StudioToolError;
    expect(out.error_reason).toBe('run_unavailable');
    expect(universe, 'a tab was left behind by the refused session').toEqual([]);
    expect(((await host.handlers.list()) as StudioListOutput).sessions).toEqual([]);
  });

  /**
   * SD1 exit-9 (K1). The refusals above roll back the session and the tab, and both were always right.
   * The leak is behind them: the run minted a line earlier is the one artifact that is DURABLE and
   * append-only, and nothing reaps it — so a run left at `running` here describes a session that no
   * longer exists and owns no tab, forever. It is counted in the tray, returned by
   * `GET /v1/runs?status=running`, and listed in the renderer.
   *
   * The assertion is therefore on the STORED run, not on the refusal the handler returned: the handler's
   * answer is identical either side of this fix, and the zombie is invisible to any test that reads it.
   */
  it('ends the run it just created when the attach fails, rather than leaving it running forever', async () => {
    const { host, store, universe } = makeHost({ breakAttach: true });

    const out = await host.handlers.spawn({}) as StudioToolError;
    expect(out.error_reason).toBe('run_unavailable');

    const ids = [...store.facts.keys()];
    expect(ids, 'the arm is only interesting if the run was created BEFORE the attach failed').toHaveLength(1);
    const run = (await store.getRun(ids[0]))!;
    expect(run.status, 'a refused open left a zombie run at running').toBe('cancelled');
    // Law 4 is unchanged by the rollback: the tab is gone from the window and owned by nobody.
    expect(run.tabIds ?? []).toEqual([]);
    expect(universe, 'a tab was left behind by the refused session').toEqual([]);
    expect(((await host.handlers.list()) as StudioListOutput).sessions).toEqual([]);
    // The projection REST serves: `GET /v1/runs?status=running` has nothing to hand a client.
    const running = (await store.listRuns()).runs.filter((r) => r.status === 'running');
    expect(running.map((r) => r.id), 'the zombie is still on the wire to every client').toEqual([]);
  });

  it('releases the tab and ends the run when the session closes', async () => {
    const { host, runs, store } = makeHost();
    const { session_id } = await host.handlers.spawn({}) as { session_id: string };
    const runId = runs.runForSession(session_id)!;

    await host.handlers.close({ session_id });

    expect(runs.ownerOf('t1'), 'the closed session still owns its tab — the old registry’s exact leak').toBeUndefined();
    expect(store.appends.map((a) => a.type)).toEqual(['tab.attached', 'tab.detached', 'run.completed']);
    expect(runs.tabsOf(runId)).toEqual([]);
  });

  /**
   * SD1 exit-9 (K8). The window destroys a tab the instant the human closes it; the release is a broker
   * round-trip behind that, queued on the tab's own lane. In that window the log still says the run owns
   * the tab, so an ownership-only answer hands the agent an id that no longer exists — and its next act
   * against it fails deeper in the stack, as an engine error rather than as a designed one.
   *
   * `agentVisibleTabs` takes the universe for exactly this. The listing is the one agent-facing seam that
   * enumerates tabs, and it was the one call site not passing it.
   *
   * The parked append is what makes this the in-flight window rather than the settled one, and the
   * `tabsOf` control asserts the parking took: with the append committed, ownership is already gone and
   * every arm below passes without narrowing anything.
   */
  it('does not list a tab the human already closed while its detach is still on the wire', async () => {
    const { host, runs, store, universe } = makeHost();
    const { session_id } = await host.handlers.spawn({}) as { session_id: string };
    const runId = runs.runForSession(session_id)!;

    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    const append = store.appendEvent.bind(store);
    store.appendEvent = async (rid, event) => {
      if (event.type === 'tab.detached') await parked;
      return append(rid, event);
    };

    // The human closes the agent's tab from the tab strip: the view is gone from the window at once,
    // the release is not.
    universe.splice(universe.indexOf('t1'), 1);
    const detaching = runs.detachTab('t1', 'closed');

    const listed = await host.handlers.list() as StudioListOutput;
    const session = listed.sessions.find((s) => s.id === session_id)!;

    expect(runs.tabsOf(runId), 'the control: the detach committed, so this is the settled window, not the in-flight one').toContain('t1');
    expect(session.tabIds, 'studio_list handed the agent a tab the human already closed').not.toContain('t1');
    expect(session.tabIds, 'the run has no other tab, so the listing is empty rather than merely t1-free').toEqual([]);

    release();
    await detaching;
    expect(runs.tabsOf(runId), 'the release never landed once unparked').toEqual([]);
  });

  // The tab is already destroyed by the time the terminal event is written, so a store that refuses it
  // must not take the rest of the teardown with it — the human already got their close.
  it('still finishes closing a session when the terminal event cannot be written', async () => {
    const { host, store } = makeHost();
    const { session_id } = await host.handlers.spawn({}) as { session_id: string };
    store.appendEvent = async () => { throw new Error('studio background service unavailable'); };

    const out = await host.handlers.close({ session_id }) as StudioCloseOutput;
    expect(out.closed).toBe(true);
    expect(host.sessions.getSessionDrive(session_id), 'the session survived its own close').toBeUndefined();
    expect(((await host.handlers.list()) as StudioListOutput).sessions).toEqual([]);
  });
});

/**
 * SD1 exit-16. `open()` publishes the session BEFORE the run exists: `contexts.set(sessionId, ctx)` with
 * status `live` happens ahead of the `createRun`/`attachTab` awaits, and there was no re-check when those
 * awaits resumed. `shutdown()` snapshots whatever is live at the instant it runs, so a user quitting
 * inside that window is not exotic — it is one ⌘Q against a session that is still standing up.
 *
 * Both arms are FORCED interleaves rather than repeated clean runs: the quit is driven from inside the
 * run-spine call `open()` is parked on, which is where a broker round-trip puts it in the real app. N
 * clean opens prove nothing about either window, because neither is reachable without the delay.
 */
describe('studio host — a quit racing an in-flight open (SD1 exit-16)', () => {
  /**
   * Arm 1. The run is created and folded, the quit lands, `shutdown()` finds the live context and ends
   * the run `cancelled` — and then `open()` resumed and attached a tab to it. The durable log read
   * `['run.created','run.cancelled','tab.attached']`: a cancelled run owning a page, in an append-only
   * log with no prune path, which every later replay and every REST reader sees. The agent's half was
   * worse than the log's — it got `{ session_id }` naming a session `contexts.clear()` had already
   * destroyed, so its every next call failed `wrong_session` with nothing saying why.
   *
   * The assertions are on the LOG's order and on the handler's answer together, because either alone
   * passes at base: a refusal with the attach still in it is the same zombie, and a clean log handed
   * back as a session id is a success response for a session that does not exist.
   */
  it('reports a structured failure instead of a session id when the quit lands between open’s awaits', async () => {
    const { host, runs, store, universe } = makeHost();
    let quit: Promise<void> | undefined;
    const realCreate = runs.createRun.bind(runs);
    // The quit lands after the run is durable and folded — `runForSession` answers, so `shutdown()`
    // ends it — but before `open()` resumes into the attach.
    runs.createRun = async (input) => {
      const run = await realCreate(input);
      quit ??= host.shutdown();
      await quit;
      return run;
    };

    const out = await host.handlers.spawn({ startUrl: 'https://example.com/' });

    expect('session_id' in out, 'the agent got a session id for a session the quit already destroyed').toBe(false);
    expect((out as StudioToolError).error_reason).toBe('host_closing');
    const ids = [...store.facts.keys()];
    expect(ids, 'the arm is only interesting if the run was created before the quit').toHaveLength(1);
    expect(
      store.log.get(ids[0]!)!.map((e) => e.type),
      'a tab.attached landed past the terminal event',
    ).toEqual(['run.created', 'run.cancelled']);
    expect((await store.getRun(ids[0]!))!.status).toBe('cancelled');
    expect(runs.ownerOf('t1'), 'a cancelled run still owns a tab').toBeUndefined();
    expect(universe, 'the half-open session left its tab in the window').toEqual([]);
  });

  /**
   * Arm 2, and the worse one: the quit lands BEFORE `createRun` resolves. `shutdown()`'s
   * `runForSession(ctx.sessionId)` finds nothing — the run is still on the wire — so it returns without
   * ending anything, and the run `open()` then creates sits `running` forever. Nothing reaps it: it is
   * counted by the tray and returned by `GET /v1/runs?status=running`, describing a session the quit
   * destroyed and owning no tab. Exactly the orphan `open()`'s own rollback comment exists to prevent.
   *
   * Fixed by the resumed `open()` ending what it created rather than by `shutdown()` awaiting in-flight
   * opens: the quit walk is bounded by a constant deadline (`SHUTDOWN_DEADLINE_MS`) and an open can be
   * parked in `gatedNavigate` for seconds, so awaiting it there would spend a budget `wigolo-studio-run` issues 98 and 119
   * calibrated — and this issue's non-goals keep that budget fixed.
   */
  it('leaves no run stuck running when the quit lands before createRun resolves', async () => {
    const { host, runs, store, universe } = makeHost();
    let quit: Promise<void> | undefined;
    const realCreate = runs.createRun.bind(runs);
    runs.createRun = async (input) => {
      quit ??= host.shutdown();
      await quit;
      return realCreate(input);
    };

    const out = await host.handlers.spawn({});

    expect('session_id' in out).toBe(false);
    expect((out as StudioToolError).error_reason).toBe('host_closing');
    const ids = [...store.facts.keys()];
    expect(ids, 'the arm is only interesting if the run was created after the quit').toHaveLength(1);
    // The claim REST serves: the orphan is invisible to any assertion about the handler's answer.
    const running = (await store.listRuns()).runs.filter((r) => r.status === 'running');
    expect(running.map((r) => r.id), 'a run the quit never ended is still running on every surface').toEqual([]);
    expect((await store.getRun(ids[0]!))!.status).toBe('cancelled');
    expect(store.log.get(ids[0]!)!.map((e) => e.type)).toEqual(['run.created', 'run.cancelled']);
    expect(universe).toEqual([]);
    expect(((await host.handlers.list()) as StudioListOutput).sessions).toEqual([]);
  });

  /**
   * The half of arm 1 that the guard on `applyAttach` cannot reach, and the reason `endRun` waits for
   * attaches on the wire.
   *
   * Here the quit lands while the `tab.attached` append is TRAVELLING. The attach's terminal check has
   * already passed against a projection `run.cancelled` is about to move, so a refusal there is a guard
   * on one side of a race — and the lanes cannot close the other side, since this write is ordered per
   * tab and the terminal event per run. Unbarriered, `endRun`'s membership read finds no tab, the
   * terminal event lands, the attach commits behind it, and the durable log reads
   * `['run.created','run.cancelled','tab.attached']` — a cancelled run owning a page, permanently.
   *
   * The ORDER is the whole claim; a count passes either way. And the parked append is what makes this
   * the in-flight window rather than the settled one, which the `run.cancelled`-is-last assertion is
   * the control for.
   */
  it('never lets an attach on the wire commit behind the terminal event a quit writes', async () => {
    const { host, runs, store, universe } = makeHost();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    let quit: Promise<void> | undefined;
    const append = store.appendEvent.bind(store);
    store.appendEvent = async (rid, event) => {
      if (event.type === 'tab.attached') {
        // The quit is issued while this append is still on the wire, and only released afterwards.
        quit ??= host.shutdown();
        await parked;
      }
      return append(rid, event);
    };

    const opening = host.handlers.spawn({});
    await new Promise((r) => setTimeout(r, 10)); // let the attach reach the store and the quit start
    release();
    const out = await opening;
    await quit;

    expect('session_id' in out).toBe(false);
    expect((out as StudioToolError).error_reason).toBe('host_closing');
    const ids = [...store.facts.keys()];
    expect(ids).toHaveLength(1);
    expect(
      store.log.get(ids[0]!)!.map((e) => e.type),
      'a tab.attached committed behind the terminal event',
    ).toEqual(['run.created', 'tab.attached', 'tab.detached', 'run.cancelled']);
    expect((await store.getRun(ids[0]!))!.status).toBe('cancelled');
    expect(runs.ownerOf('t1'), 'a cancelled run still owns the tab').toBeUndefined();
    expect(universe).toEqual([]);
  });

  /**
   * The claim the row above cannot make, and the one the re-check AFTER the attach is for.
   *
   * There the session had no startUrl, so nothing was left to do and the final check caught it. With a
   * startUrl there is: a profile load and a real page load, both against a `WebContentsView` the quit
   * already destroyed. Refusing only at the END of `open()` still returns the right answer, so every
   * assertion in the row above passes with this check gone — while the host drives a torn-down tab on
   * the way there, which surfaces as an engine error rather than as a designed one (law 9). The
   * navigation is the observable: it is the last thing `open()` does and the only one a test can see.
   *
   * `navigations` is asserted against the CONTROL below, not merely as empty, because an arm where the
   * nav never got as far as being attempted would pass vacuously.
   */
  it('never navigates a session the quit destroyed while its attach was on the wire', async () => {
    const { host, store, navigations } = makeHost();
    let release!: () => void;
    const parked = new Promise<void>((resolve) => { release = resolve; });
    let quit: Promise<void> | undefined;
    const append = store.appendEvent.bind(store);
    store.appendEvent = async (rid, event) => {
      if (event.type === 'tab.attached') {
        quit ??= host.shutdown();
        await parked;
      }
      return append(rid, event);
    };

    const opening = host.handlers.spawn({ startUrl: 'https://example.com/' });
    await new Promise((r) => setTimeout(r, 10));
    release();
    const out = await opening;
    await quit;

    expect((out as StudioToolError).error_reason).toBe('host_closing');
    expect(navigations, 'the host loaded a page into a tab the quit had already destroyed').toEqual([]);

    // The control: the same startUrl on a session no quit touches IS navigated, so the assertion above
    // is about the refusal rather than about a nav this fixture never performs.
    const clean = makeHost();
    await clean.host.handlers.spawn({ startUrl: 'https://example.com/' });
    expect(clean.navigations).toEqual(['https://example.com/']);
  });

  /**
   * The third window, and the widest: the gated navigation of the agent's `startUrl` is a real page
   * load, so it is where a quit is likeliest to land — and it sits OUTSIDE the try/catch on purpose,
   * because a blocked or failed nav still opens the session. Both awaits before it can be re-checked by
   * the catch; this one cannot, so an unwind here is the only thing standing between the agent and a
   * session id into a cleared host. The run really is attached by this point, so this is also the arm
   * where the rollback has a tab to release.
   */
  it('reports a structured failure when the quit lands during the gated startUrl navigation', async () => {
    let quitting: (() => Promise<void>) | undefined;
    const { host, runs, store, universe } = makeHost({ onNavigate: async () => { await quitting?.(); } });
    let quit: Promise<void> | undefined;
    quitting = async () => { quit ??= host.shutdown(); await quit; };

    const out = await host.handlers.spawn({ startUrl: 'https://example.com/' });

    expect('session_id' in out, 'the agent got a session id after the window closed under the nav').toBe(false);
    expect((out as StudioToolError).error_reason).toBe('host_closing');
    const ids = [...store.facts.keys()];
    expect(ids).toHaveLength(1);
    expect((await store.getRun(ids[0]!))!.status).toBe('cancelled');
    // The attach DID commit here, so the terminal event owes the tab a release — and exactly one.
    expect(store.log.get(ids[0]!)!.map((e) => e.type))
      .toEqual(['run.created', 'tab.attached', 'tab.detached', 'run.cancelled']);
    expect(runs.ownerOf('t1')).toBeUndefined();
    expect(universe).toEqual([]);
    expect(((await host.handlers.list()) as StudioListOutput).sessions).toEqual([]);
  });

  /**
   * Both interleaves at once, against ONE quit — the shape the session cap makes ordinary, since a host
   * can be standing several sessions up when the window closes. One open is parked before its run
   * exists and the other after, so `shutdown()` sees one context it can end and one it cannot, and both
   * resume into a cleared map. Neither may come back as a session id and neither run may be left
   * running.
   */
  it('leaves neither run running when one quit races two opens in different interleaves', async () => {
    const { host, runs, store } = makeHost();
    let quit: Promise<void> | undefined;
    const realCreate = runs.createRun.bind(runs);
    let nth = 0;
    runs.createRun = async (input) => {
      const first = ++nth === 1;
      if (first) {
        // Parked after the run is folded: this is the context `shutdown()` can find a run for.
        const run = await realCreate(input);
        quit ??= host.shutdown();
        await quit;
        return run;
      }
      // Parked before the run exists: `runForSession` will answer nothing for this one.
      quit ??= host.shutdown();
      await quit;
      return realCreate(input);
    };

    const [a, b] = await Promise.all([host.handlers.spawn({}), host.handlers.spawn({})]);

    expect('session_id' in a).toBe(false);
    expect('session_id' in b).toBe(false);
    expect((a as StudioToolError).error_reason).toBe('host_closing');
    expect((b as StudioToolError).error_reason).toBe('host_closing');
    expect([...store.facts.keys()], 'both opens should have minted a run before they unwound').toHaveLength(2);
    const runs_ = (await store.listRuns()).runs;
    expect(runs_.map((r) => r.status), 'a quit racing two opens left a run behind').toEqual(['cancelled', 'cancelled']);
    expect(((await host.handlers.list()) as StudioListOutput).sessions).toEqual([]);
  });
});

describe('studio host — the user’s tabs are invisible to agents (law 4)', () => {
  it('never lists a tab the human opened, even though the window is holding it', async () => {
    const { host, openUserTab, universe } = makeHost();
    const { session_id } = await host.handlers.spawn({}) as { session_id: string };
    openUserTab('human-inbox');
    openUserTab('human-bank');

    const listed = await host.handlers.list() as StudioListOutput;
    const session = listed.sessions.find((s) => s.id === session_id)!;

    expect(universe, 'the control: the human tabs really are in the window').toEqual(['t1', 'human-inbox', 'human-bank']);
    expect(session.tabIds).toEqual(['t1']);
    const everyTabNamed = listed.sessions.flatMap((s) => s.tabIds ?? []);
    expect(everyTabNamed).not.toContain('human-inbox');
    expect(everyTabNamed).not.toContain('human-bank');
  });

  it('refuses an explicit tab_id pointing at one of the human’s tabs', async () => {
    const { host, openUserTab } = makeHost();
    await host.handlers.spawn({});
    openUserTab('human-inbox');

    const out = await host.handlers.extractSet({ tab_id: 'human-inbox', mark_id: 'm1' }) as StudioToolError;
    expect(out.error_reason).toBe('wrong_session');
  });

  it('ignores human input on a tab no run owns instead of routing it into a session', async () => {
    const { host, drives, openUserTab } = makeHost();
    await host.handlers.spawn({});
    const fsm = drives.get('t1')!.fsm;
    const before = fsm.state();
    openUserTab('human-inbox');

    host.onHumanInput('human-inbox');
    expect(fsm.state(), 'typing in the human’s own tab preempted the agent’s session').toEqual(before);

    // The control: the same call on the run's OWN tab does reach the session.
    host.onHumanInput('t1');
    expect(fsm.state()).not.toEqual(before);
  });

  it('refuses to mark an element in a tab no run owns', async () => {
    const { host, openUserTab } = makeHost();
    await host.handlers.spawn({});
    openUserTab('human-inbox');

    const out = await host.markElement({ tabId: 'human-inbox', path: [0, 0], payload: { tag: 'button', id: 'pay', classes: [], attrs: {}, dataset: {}, text: 'Pay', component: null, source: null } }) as StudioToolError;
    expect(out.error_reason).toBe('no_active_session');
  });
});
