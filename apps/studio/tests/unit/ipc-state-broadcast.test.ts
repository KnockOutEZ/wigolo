import { describe, it, expect, vi, beforeEach } from 'vitest';

// `registerIpc` registers handlers on the real `ipcMain`, which exists only inside a live main
// process. Faking it is what lets the WIRING be exercised here rather than only read as text.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { ipcMain } from 'electron';
import { registerIpc, stateBroadcaster } from '../../src/main/ipc-host';
import { RunViewModel } from '../../src/main/run-view-model';
import { FakeRunStore } from '../helpers/fake-run-store';
import { IPC } from '../../src/shared/ipc';
import type { StudioState } from '../../src/shared/ipc';

/**
 * Why this exists, in the failure's own terms.
 *
 * Closing the app destroys the window while a tab's webContents is still emitting, so
 * `tabs.onChange` fires once more with nothing to send to. The unguarded push reached through the
 * dead window, which throws `Object has been destroyed` from the PROPERTY ACCESS — an uncaught
 * main-process exception, surfaced by Electron as a modal crash dialog. The app then hangs instead
 * of exiting, and anything driving it (a Playwright probe, an e2e spec, an agent) waits on a window
 * that will never answer. That is the shape of the bug: not a lost state update, a hang.
 *
 * So the assertion that matters is NOT "send was skipped" — it is "the call did not throw and the
 * dead window was never reached". A test that only counted sends would pass against a version that
 * threw before sending.
 */

const state = (): StudioState => ({ runs: [], focusedRunId: null, tabs: [] });

/**
 * A window whose `webContents` THROWS on access, exactly as Electron's does after destruction.
 * Using a plain `{ send }` object would make the guard untestable: the unguarded code would quietly
 * succeed and the test could never fail.
 */
function destroyedWindow(): { win: Parameters<typeof stateBroadcaster>[0]; touched: () => boolean } {
  let touched = false;
  const win = {
    isDestroyed: () => true,
    get webContents(): never {
      touched = true;
      throw new TypeError('Object has been destroyed');
    },
  };
  return { win: win as unknown as Parameters<typeof stateBroadcaster>[0], touched: () => touched };
}

function liveWindow() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } };
  return { win: win as unknown as Parameters<typeof stateBroadcaster>[0], send };
}

/**
 * A window that is ALIVE while its webContents is destroyed — the lifetime pair the fakes above
 * cannot express, because each of them moves the two together.
 *
 * The two objects are destroyed independently. `webContents.close()` and a renderer that tore itself
 * down both leave `win.isDestroyed()` returning false with the contents already gone, and `send` on a
 * dead webContents throws the SAME `Object has been destroyed` — from the call this time rather than
 * the property access, but uncaught in the main process either way, so it produces the identical
 * modal crash dialog and the identical hang. Both halves of that are measured against the real engine
 * in `tests/e2e/crash-push.spec.ts`; this fixture is the cheap restatement, not the evidence.
 *
 * A CRASHED render process is NOT this shape — see `windowAliveContentsCrashed` below.
 *
 * Coupling the two lifetimes in every fixture is how a suite bakes in the blind spot it was written
 * to close: a guard that reads only the window passes every one of them.
 */
function windowAliveContentsDestroyed(): {
  win: Parameters<typeof stateBroadcaster>[0];
  send: () => boolean;
} {
  let sent = false;
  const win = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => true,
      send: () => {
        sent = true;
        throw new TypeError('Object has been destroyed');
      },
    },
  };
  return { win: win as unknown as Parameters<typeof stateBroadcaster>[0], send: () => sent };
}

/**
 * The CRASH shape, which the guard deliberately does not catch: window alive, contents alive but
 * crashed. Electron keeps a crashed webContents around for reload — that is why `isCrashed()` and
 * `render-process-gone` exist as a separate API — so `isDestroyed()` is false and neither clause of
 * the guard fires. Measured against the real engine in `tests/e2e/crash-push.spec.ts`, along with the
 * fact that the resulting send is benign: it posts into a dead channel and returns.
 *
 * `send` here therefore does NOT throw, unlike the destroyed fixture above. Making it throw would be
 * writing the engine's behaviour to match the comment instead of the other way round, which is the
 * error this issue exists to undo.
 */
function windowAliveContentsCrashed() {
  const send = vi.fn();
  const win = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, isCrashed: () => true, send },
  };
  return { win: win as unknown as Parameters<typeof stateBroadcaster>[0], send };
}

describe('stateBroadcaster', () => {
  it('pushes the state to a live window', () => {
    const { win, send } = liveWindow();
    stateBroadcaster(win, state)();
    expect(send).toHaveBeenCalledWith(IPC.stateChanged, { runs: [], focusedRunId: null, tabs: [] });
  });

  it('does not throw when the window was destroyed before the tab event landed', () => {
    const { win } = destroyedWindow();
    expect(() => stateBroadcaster(win, state)()).not.toThrow();
  });

  it('never touches webContents on a destroyed window', () => {
    const { win, touched } = destroyedWindow();
    stateBroadcaster(win, state)();
    expect(touched(), 'the destroyed window was reached through — the guard ran too late').toBe(false);
  });

  it('does not compute state for a destroyed window', () => {
    const { win } = destroyedWindow();
    const spy = vi.fn(state);
    stateBroadcaster(win, spy)();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not throw when the window outlives its own webContents', () => {
    // The window is alive, so the guard cannot short-circuit on it and MUST look further.
    const { win } = windowAliveContentsDestroyed();
    expect(() => stateBroadcaster(win, state)()).not.toThrow();
  });

  it('never sends through a destroyed webContents', () => {
    // Same reason as the window case: the assertion that matters is that the dead object was not
    // reached, not that a state update went missing.
    const { win, send } = windowAliveContentsDestroyed();
    stateBroadcaster(win, state)();
    expect(send(), 'the destroyed webContents was sent through — the guard reads the window only').toBe(false);
  });

  it('still pushes through a crashed-but-not-destroyed contents, because that send is benign', () => {
    // Pins the claim the file comment makes. A guard grown a `|| win.webContents.isCrashed()` clause
    // reds here — and should, until an engine measurement says the crash-path send throws.
    const { win, send } = windowAliveContentsCrashed();
    expect(() => stateBroadcaster(win, state)()).not.toThrow();
    expect(send, 'the crash path was skipped — the guard now claims coverage the comment denies').toHaveBeenCalledWith(
      IPC.stateChanged,
      { runs: [], focusedRunId: null, tabs: [] },
    );
  });
});

/**
 * The wiring, exercised rather than read.
 *
 * Every assertion above drives `stateBroadcaster` directly, so all of them stay green against a
 * `registerIpc` that subscribes its OWN inline `win.webContents.send(…)` closure to `tabs.onChange` —
 * which is the exact shape the crash had before the guard existed. The guard is only worth anything
 * if it is the thing tab changes actually reach, so that is what this pins: register for real against
 * a fake `ipcMain`, take the callback `registerIpc` handed to `tabs.onChange`, and fire it at a dead
 * window.
 */
describe('registerIpc', () => {
  function fakeDeps() {
    const listeners: Array<() => void> = [];
    const tabs = { onChange: (fn: () => void) => listeners.push(fn), listTabs: () => [] };
    // The REAL view-model over a faithful store, not a stub: `registerIpc` now reads run state through
    // it, so a stub would let a projection bug through the one test that exercises the wiring.
    const runs = new RunViewModel(new FakeRunStore());
    return { listeners, tabs, runs };
  }

  it('subscribes the guarded push to tab changes, not an unguarded one', () => {
    const { listeners, tabs, runs } = fakeDeps();
    const { win, touched } = destroyedWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs as unknown as Parameters<typeof registerIpc>[2],
    );
    expect(listeners, 'nothing subscribed to tab changes — the state push is dead').toHaveLength(1);
    expect(() => listeners[0]!()).not.toThrow();
    expect(touched(), 'the tab-change subscriber reached through a destroyed window').toBe(false);
  });

  it('subscribes a push that survives a destroyed webContents too', () => {
    const { listeners, tabs, runs } = fakeDeps();
    const { win, send } = windowAliveContentsDestroyed();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs as unknown as Parameters<typeof registerIpc>[2],
    );
    expect(() => listeners[0]!()).not.toThrow();
    expect(send()).toBe(false);
  });

  it('the subscriber it registers really is the one that pushes state', () => {
    // The control for the two above: a subscriber that no longer sends anything would satisfy both
    // "did not throw" assertions vacuously. Against a live window the same callback must push.
    const { listeners, tabs, runs } = fakeDeps();
    const { win, send } = liveWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs as unknown as Parameters<typeof registerIpc>[2],
    );
    listeners[0]!();
    expect(send).toHaveBeenCalledWith(IPC.stateChanged, { runs: [], focusedRunId: null, tabs: [] });
  });

  /**
   * The one place law 4's two groups actually meet: `TabManager` holds every tab the window has, agent
   * and human alike, and this is where ownership gets stamped onto them. A push that labelled the whole
   * universe with the focused run would put the human's own tabs inside an agent's group on screen.
   */
  it('stamps the owning run onto agent tabs and leaves the human’s unmarked', async () => {
    const listeners: Array<() => void> = [];
    const universe = [
      { id: 'agent-tab', url: 'https://example.com/', title: 'Example', active: true },
      { id: 'human-inbox', url: 'https://mail.example/', title: 'Inbox', active: false },
    ];
    const tabs = { onChange: (fn: () => void) => listeners.push(fn), listTabs: () => universe };
    const runs = new RunViewModel(new FakeRunStore());
    const run = await runs.createRun({ task: 'check the order' });
    await runs.attachTab(run.id, 'agent-tab');

    const { win, send } = liveWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs as unknown as Parameters<typeof registerIpc>[2],
    );
    listeners[0]!();

    const [, state] = send.mock.calls.at(-1) as [string, StudioState];
    expect(state.tabs.find((t) => t.id === 'agent-tab')?.runId).toBe(run.id);
    expect(state.tabs.find((t) => t.id === 'human-inbox'), 'the human’s own tab was filed under a run').toEqual({
      id: 'human-inbox', url: 'https://mail.example/', title: 'Inbox', active: false,
    });
    expect(state.runs).toEqual([
      { id: run.id, task: 'check the order', status: 'running', tabIds: ['agent-tab'], visibility: 'hidden' },
    ]);
  });

  /**
   * Caught in the running app: with a "current run" pointer of its own, the chrome named the FIRST run
   * ever created while the window was showing the second one's page. Focus is the owner of the focused
   * tab and nothing else — and when the human is in their own tab, no run is focused at all.
   */
  it('names the run whose tab is focused, not the first one created', async () => {
    const listeners: Array<() => void> = [];
    const universe = [
      { id: 'tab-a', url: 'https://a.example/', title: 'A', active: false },
      { id: 'tab-b', url: 'https://b.example/', title: 'B', active: true },
      { id: 'human-inbox', url: 'https://mail.example/', title: 'Inbox', active: false },
    ];
    const tabs = { onChange: (fn: () => void) => listeners.push(fn), listTabs: () => universe };
    const runs = new RunViewModel(new FakeRunStore());
    const first = await runs.createRun({ task: 'first' });
    const second = await runs.createRun({ task: 'second' });
    await runs.attachTab(first.id, 'tab-a');
    await runs.attachTab(second.id, 'tab-b');

    const { win, send } = liveWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs as unknown as Parameters<typeof registerIpc>[2],
    );
    listeners[0]!();
    const focused = () => (send.mock.calls.at(-1) as [string, StudioState])[1].focusedRunId;
    expect(focused(), 'the chrome named a run other than the one on screen').toBe(second.id);

    // The human moves to their own tab: they are inside no run, and the chrome must not claim otherwise.
    universe[1]!.active = false;
    universe[2]!.active = true;
    listeners[0]!();
    expect(focused()).toBeNull();
  });
});

/**
 * Two lines in `registerIpc` were registered and never executed by anything: the `tabClose` handler's
 * `runs.detachTab(id, 'closed')`, and the `runs.onChange(broadcast)` subscription. The electron mock
 * above records handlers, and until now nothing pulled one back out and called it — so deleting
 * either line left the whole suite green, while both lines' own comments name the regression that
 * put them there. A comment is not a guard.
 *
 * These arms execute them. Both are asserted through an observable the deletion actually changes:
 * the append that reaches the store, and the state that reaches the window.
 */
describe('registerIpc — the seams that only run in the live app', () => {
  /**
   * The handler as `ipcMain` holds it. Typed locally rather than through electron's `IpcMain`,
   * because the only part of the invoke event these handlers touch is nothing at all.
   */
  type InvokeHandler = (event: unknown, ...args: unknown[]) => unknown;

  const handlerFor = (channel: string): InvokeHandler => {
    const call = vi.mocked(ipcMain.handle).mock.calls.find(([ch]) => ch === channel);
    if (!call) throw new Error(`nothing handles ${channel}`);
    return call[1] as unknown as InvokeHandler;
  };

  const tabUniverse = () => [
    { id: 'agent-tab', url: 'https://example.com/', title: 'Example', active: true },
    { id: 'human-inbox', url: 'https://mail.example/', title: 'Inbox', active: false },
  ];

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
  });

  /**
   * Law 4's release. `removeTab` was wired to the human path only, so an agent tab the human closed
   * stayed attached to its run forever — the run went on owning a tab that no longer existed, and no
   * other run could ever be given that id. The fix is this one `detachTab`, and until now no test
   * invoked the handler that carries it.
   */
  it('records the release when the human closes an agent tab', async () => {
    const closed: string[] = [];
    const tabs = { onChange: () => {}, listTabs: tabUniverse, closeTab: (id: string) => { closed.push(id); } };
    const store = new FakeRunStore();
    const runs = new RunViewModel(store);
    const run = await runs.createRun({ task: 'check the order' });
    await runs.attachTab(run.id, 'agent-tab');

    const { win } = liveWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs,
    );
    handlerFor(IPC.tabClose)({}, 'agent-tab');
    await vi.waitFor(() => expect(runs.ownerOf('agent-tab')).toBeUndefined());

    expect(closed, 'the tab itself was never closed').toEqual(['agent-tab']);
    expect(store.appends.at(-1), 'the release was never written to the log').toEqual({
      runId: run.id,
      type: 'tab.detached',
      payload: { tabId: 'agent-tab', reason: 'closed' },
    });
  });

  /**
   * The control. A `detachTab` on every close would be just as green above and would be wrong: a tab
   * nobody owns is the human's, and closing it is not a run fact at all.
   */
  it('writes nothing to any log when the human closes their own tab', async () => {
    const tabs = { onChange: () => {}, listTabs: tabUniverse, closeTab: () => {} };
    const store = new FakeRunStore();
    const runs = new RunViewModel(store);
    const run = await runs.createRun({ task: 'check the order' });
    await runs.attachTab(run.id, 'agent-tab');
    store.appends.length = 0;

    const { win } = liveWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs,
    );
    handlerFor(IPC.tabClose)({}, 'human-inbox');
    await vi.waitFor(() => expect(store.appends).toEqual([]));

    expect(runs.ownerOf('agent-tab'), 'closing a user tab released somebody else’s').toBe(run.id);
  });

  /**
   * The second subscription, and the reason it is not redundant with `tabs.onChange`: detaching is an
   * async append, so a tab closing and its run releasing it are two separate moments, and only the
   * second one carries the new ownership. Nothing touches the tab set here — `tabs.onChange` is never
   * fired — so the push can only be the run subscription's.
   */
  it('pushes state when a run event moves ownership, with the tab set untouched', async () => {
    const tabs = { onChange: () => {}, listTabs: tabUniverse, closeTab: () => {} };
    const runs = new RunViewModel(new FakeRunStore());
    const run = await runs.createRun({ task: 'check the order' });

    const { win, send } = liveWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      runs,
    );
    send.mockClear();

    await runs.attachTab(run.id, 'agent-tab');
    await vi.waitFor(() => expect(send, 'a run event moved ownership and the chrome was never told').toHaveBeenCalled());

    const [, pushed] = send.mock.calls.at(-1) as [string, StudioState];
    expect(pushed.tabs.find((t) => t.id === 'agent-tab')?.runId).toBe(run.id);
    expect(pushed.focusedRunId, 'the chrome was pushed a state that still had no owner for the focused tab').toBe(run.id);
  });
});
