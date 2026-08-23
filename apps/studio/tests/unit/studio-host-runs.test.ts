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
function makeHost(opts: { nextTabId?: () => string; breakRunStore?: boolean } = {}) {
  const engine = createDriveEngine();
  const store = new FakeRunStore();
  if (opts.breakRunStore) store.createRun = async () => { throw new Error('studio background service unavailable'); };
  const runs = new RunViewModel(store);
  /** Every tab the window holds — agent tabs and the human's alike, exactly as TabManager would. */
  const universe: string[] = [];
  /** The per-tab drive, so a test can watch the preemption FSM the human-input route reaches. */
  const drives = new Map<string, Awaited<ReturnType<typeof engine.attachTab>>>();
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
      const state = { navigate: vi.fn(async (_u: string) => {}), url: 'about:blank' };
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
    closeTab: (tabId) => { const at = universe.indexOf(tabId); if (at >= 0) universe.splice(at, 1); void engine.detachTab(tabId); },
  });
  const openUserTab = (id: string): string => { universe.push(id); return id; };
  return { host, runs, store, universe, openUserTab, drives };
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
    const { host, runs } = makeHost({ nextTabId: () => 'recycled' });
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

  it('releases the tab and ends the run when the session closes', async () => {
    const { host, runs, store } = makeHost();
    const { session_id } = await host.handlers.spawn({}) as { session_id: string };
    const runId = runs.runForSession(session_id)!;

    await host.handlers.close({ session_id });

    expect(runs.ownerOf('t1'), 'the closed session still owns its tab — the old registry’s exact leak').toBeUndefined();
    expect(store.appends.map((a) => a.type)).toEqual(['tab.attached', 'tab.detached', 'run.completed']);
    expect(runs.tabsOf(runId)).toEqual([]);
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
