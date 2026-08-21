import { describe, it, expect, vi } from 'vitest';

// `registerIpc` registers handlers on the real `ipcMain`, which exists only inside a live main
// process. Faking it is what lets the WIRING be exercised here rather than only read as text.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));

import { registerIpc, stateBroadcaster } from '../../src/main/ipc-host';
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

const state = (): StudioState => ({ sessionName: 's', tabs: [] });

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
 * The two objects are destroyed independently. `webContents.close()`, a renderer that tore itself
 * down, or a crashed render process all leave `win.isDestroyed()` returning false with the contents
 * already gone, and `send` on a dead webContents throws the SAME `Object has been destroyed` — from
 * the call this time rather than the property access, but uncaught in the main process either way,
 * so it produces the identical modal crash dialog and the identical hang.
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

describe('stateBroadcaster', () => {
  it('pushes the state to a live window', () => {
    const { win, send } = liveWindow();
    stateBroadcaster(win, state)();
    expect(send).toHaveBeenCalledWith(IPC.stateChanged, { sessionName: 's', tabs: [] });
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
    const sessions = { current: () => ({ id: 'sess1', name: 's' }) };
    return { listeners, tabs, sessions };
  }

  it('subscribes the guarded push to tab changes, not an unguarded one', () => {
    const { listeners, tabs, sessions } = fakeDeps();
    const { win, touched } = destroyedWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      sessions as unknown as Parameters<typeof registerIpc>[2],
    );
    expect(listeners, 'nothing subscribed to tab changes — the state push is dead').toHaveLength(1);
    expect(() => listeners[0]!()).not.toThrow();
    expect(touched(), 'the tab-change subscriber reached through a destroyed window').toBe(false);
  });

  it('subscribes a push that survives a destroyed webContents too', () => {
    const { listeners, tabs, sessions } = fakeDeps();
    const { win, send } = windowAliveContentsDestroyed();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      sessions as unknown as Parameters<typeof registerIpc>[2],
    );
    expect(() => listeners[0]!()).not.toThrow();
    expect(send()).toBe(false);
  });

  it('the subscriber it registers really is the one that pushes state', () => {
    // The control for the two above: a subscriber that no longer sends anything would satisfy both
    // "did not throw" assertions vacuously. Against a live window the same callback must push.
    const { listeners, tabs, sessions } = fakeDeps();
    const { win, send } = liveWindow();
    registerIpc(
      win as unknown as Parameters<typeof registerIpc>[0],
      tabs as unknown as Parameters<typeof registerIpc>[1],
      sessions as unknown as Parameters<typeof registerIpc>[2],
    );
    listeners[0]!();
    expect(send).toHaveBeenCalledWith(IPC.stateChanged, { sessionName: 's', tabs: [] });
  });
});
