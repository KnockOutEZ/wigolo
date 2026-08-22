import type { TrayPort } from './run-tray';

/**
 * The menu-bar item's lifetime guard — the tray's half of what `stateBroadcaster` already does for
 * windows in `ipc-host.ts`.
 *
 * WHY IT EXISTS. The OS item outlives nothing and is outlived by everything: the run projection fans
 * a change out to every listener, quitting ends every run, and the platform tears the status item
 * down on its own schedule during that same quit. So a redraw can reach an item the OS has already
 * destroyed, and on the real engine that THROWS. It throws inside a listener, synchronously, on the
 * main process's stack — which Electron answers with a modal "A JavaScript error occurred in the main
 * process" dialog, and a modal is a process that can never exit. Twenty-one orphaned instances,
 * oldest alive two hours, each holding a window and its RAM, ignoring SIGTERM because the dialog was
 * up. The throw is a nuisance; the modal is the outage.
 *
 * WHY AT THE SEAM. `createRunTray` already refuses to redraw after its OWN teardown, and that flag is
 * still right — but it only knows about the teardown it performed. It cannot know the platform
 * destroyed the item underneath it, and neither can any of the four call sites. Only the object
 * holding the item can answer, so the question is asked exactly once, here, and a destroyed item
 * makes every method a no-op for everyone. Guarding at call sites means the next call site added is
 * the next outage.
 *
 * WHAT THE ENGINE ACTUALLY DOES, measured on Electron 43 and pinned by `tests/e2e/tray-lifetime.spec.ts`
 * so this paragraph cannot quietly go stale:
 *   - `isDestroyed()` stays READABLE after destroy and reports `true`. This is the load-bearing
 *     difference from `BrowserWindow`, where reading `.webContents` on a dead window throws and the
 *     guard's clause ordering has to work around it. Here one plain read suffices.
 *   - `setTitle`, `setToolTip` and `setContextMenu` all throw `Tray is destroyed`. All three are
 *     therefore guarded, not just the `setTitle` the crash report happened to name.
 *   - a second `destroy()` does NOT throw. It is guarded anyway: a no-op means a no-op, and a seam
 *     with one method exempted is a seam a reader has to check rather than trust.
 */

/** The OS item's lifetime, narrowed to the single question this seam asks of it. */
export interface TrayLifetime {
  isDestroyed(): boolean;
}

/**
 * Wrap a port so that a destroyed OS item silently absorbs every call instead of throwing one back
 * into the run log's fan-out. A live item is untouched — the guard adds a boolean read, not a policy.
 */
export function livingTrayPort(item: TrayLifetime, port: TrayPort): TrayPort {
  return {
    setLabel: (text) => {
      if (item.isDestroyed()) return;
      port.setLabel(text);
    },
    setToolTip: (text) => {
      if (item.isDestroyed()) return;
      port.setToolTip(text);
    },
    setMenu: (items) => {
      if (item.isDestroyed()) return;
      port.setMenu(items);
    },
    destroy: () => {
      if (item.isDestroyed()) return;
      port.destroy();
    },
  };
}
