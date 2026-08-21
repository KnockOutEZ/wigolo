import { describe, it, expect, vi } from 'vitest';
import { stateBroadcaster } from '../../src/main/ipc-host';
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
  const win = { isDestroyed: () => false, webContents: { send } };
  return { win: win as unknown as Parameters<typeof stateBroadcaster>[0], send };
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
});
