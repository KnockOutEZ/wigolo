import { ipcMain, type BrowserWindow } from 'electron';
import { IPC, type StudioState, type OverlayMarkMsg, type QuoteMsg, type RegionMsg } from '../shared/ipc';
import type { TabManager } from './tab-manager';
import type { RunViewModel } from './run-view-model';
import type { StudioHost } from './studio-host';
import type { StudioHostHandlers } from 'wigolo/studio';

/** The window surface the state push needs — narrowed so a test can drive it with a fake. */
type BroadcastWindow = Pick<BrowserWindow, 'isDestroyed' | 'webContents'>;

/**
 * main → chrome renderer state push, as a no-op once the window is gone.
 *
 * Tab teardown outlives the window: closing the app destroys the window while a tab's webContents
 * still emits, so `tabs.onChange` fires one more time with nothing left to send to. Reaching through
 * a destroyed window throws `Object has been destroyed` from the property access itself — and in the
 * main process that is an UNCAUGHT exception, which Electron shows as a modal crash dialog. Anything
 * driving the app then hangs against a dead window rather than failing, which is how one autonomous
 * screenshot probe sat frozen until its runner declared the session finished.
 *
 * `win.isDestroyed()` is checked FIRST: `win.webContents` is exactly the access that throws, so it
 * has to be short-circuited past rather than evaluated alongside. The `||` is what makes that safe —
 * the right-hand side is only reached once the window is known to be alive.
 *
 * The two objects have SEPARATE lifetimes, so the window's alone is not enough. `webContents.close()`
 * and a renderer that tore itself down leave the window alive with its contents already destroyed,
 * and `send` then throws the same `Object has been destroyed` — same uncaught main-process exception,
 * same modal dialog, same hang. That is the whole of what the second clause covers.
 *
 * A CRASHED render process is NOT one of them, and this guard does not skip that case. Electron keeps
 * a crashed webContents alive for reload — which is why `isCrashed()` and `render-process-gone` exist
 * as a separate API — so `isDestroyed()` stays false and the send goes ahead. Measured against the
 * engine: that send is benign, posting into a dead channel and returning without throwing, so no
 * crash condition is needed here. The state update is simply dropped, and the reloaded renderer picks
 * the state back up through `getState`. The measurement is a gate, not a one-off — the crash, close
 * and window-destroy lifetimes are all pinned in `tests/e2e/crash-push.spec.ts`, so if a future engine
 * version makes the crash-path send throw, that spec reds before this comment goes stale again.
 */
export function stateBroadcaster(win: BroadcastWindow, state: () => StudioState): () => void {
  return () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(IPC.stateChanged, state());
  };
}

export function registerIpc(win: BrowserWindow, tabs: TabManager, runs: RunViewModel): void {
  const state = (): StudioState => {
    // Ownership is stamped on here rather than held by the tab layer: `TabManager` knows which views
    // exist, the run log knows who they belong to, and only this projection needs both.
    const withOwners = tabs.listTabs().map((t) => {
      const runId = runs.ownerOf(t.id);
      return runId ? { ...t, runId } : t;
    });
    return {
      // LIVE runs, never the lifetime listing. This is pushed once per 16 ms coalescing window and
      // crosses a structured clone, and nothing here is ever forgotten — a finished run keeps its
      // projection — so `list()` made every broadcast cost every run the machine had ever seen: 253 KB
      // at 2,000 finished runs, 4.6 MB and 7 ms of the frame at 10,000, on the thread that paints.
      // A surface that wants history asks for it; it does not get it sixty times a second.
      runs: runs.listLive(),
      // Derived from the focused tab, never a pointer of its own. A separate "current run" would let
      // the chrome name one run while the window shows another's page — which is what it did.
      // `null` when the human is in their own tab: they are not inside any run.
      focusedRunId: withOwners.find((t) => t.active)?.runId ?? null,
      tabs: withOwners,
    };
  };
  const broadcast = stateBroadcaster(win, state);
  // Pre-existing, deliberately not reworked here: this subscription is never unsubscribed. The
  // callback is inert once the window is gone (the guard above), but it keeps `win` and `runs`
  // reachable through its closure for the lifetime of the TabManager.
  tabs.onChange(broadcast);
  // A run event moves ownership without touching the tab set, and a detach lands one turn AFTER the
  // close that caused it — so the tab strip needs both sources or it renders stale ownership.
  runs.onChange(broadcast);

  ipcMain.handle(IPC.getState, () => state());
  // Law 4: a tab the human opens joins the USER group, which is defined by having no `tab.attached`
  // event. Nothing is recorded here, and that absence is exactly what keeps it invisible to agents.
  ipcMain.handle(IPC.tabCreate, (_e, url: string) => tabs.createTab(url));
  ipcMain.handle(IPC.tabClose, (_e, id: string) => {
    tabs.closeTab(id);
    // No-op for a user tab; for an agent tab the human closed, this is the release the old registry
    // never recorded — `removeTab` was wired to the human path only, so agent tabs leaked forever.
    void runs.detachTab(id, 'closed').catch((err: unknown) => {
      process.stderr.write(`[studio] could not record the tab release: ${err instanceof Error ? err.message : String(err)}\n`);
    });
  });
  ipcMain.handle(IPC.tabFocus, (_e, id: string) => tabs.focusTab(id));
  ipcMain.handle(IPC.tabNavigate, (_e, id: string, url: string) => tabs.navigate(id, url));
}

/** Minimal ipcMain surface (injected so the marks routing is unit-testable with a fake). */
interface IpcMainLike {
  on(channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => void): void;
  handle(channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => unknown): void;
}

export interface MarksIpcDeps {
  ipcMain: IpcMainLike;
  /** Mark creation / comments / quote capture live on the StudioHost object (human seam); reads via handlers.marks. */
  host: Pick<StudioHost, 'markElement' | 'addComment' | 'captureQuote' | 'captureRegion'> & { handlers: Pick<StudioHostHandlers, 'marks'> };
  /** Correlate the sending tab's webContents → its session tabId (null if not a session tab). */
  resolveTab(sender: unknown): string | undefined;
  /** main → a specific tab's overlay preload. */
  sendToTab(tabId: string, channel: string, payload: unknown): void;
  /** main → the chrome renderer (generic push, e.g. the generalize preview). */
  sendToRenderer(channel: string, payload: unknown): void;
  /** Recompute the active session's marks and push them to the rail (marksChanged). */
  broadcastMarks(): void | Promise<void>;
  /** The currently-focused session tab (armMarkMode targets it). */
  focusedSessionTab(): string | undefined;
}

/**
 * Wire the P2 marking IPC. Mark CREATION reaches the host ONLY through this human Electron-IPC seam
 * (correlated by event.sender), never the agent's loopback gateway — the agent surface stays the
 * sealed 7-key handler set (PIN-SPLIT(a)).
 */
export function registerMarksIpc(deps: MarksIpcDeps): void {
  const { ipcMain: ipc, host, resolveTab, sendToTab, sendToRenderer, broadcastMarks, focusedSessionTab } = deps;

  // overlay(tab) → main: the human committed a mark.
  ipc.on(IPC.overlayMark, (event, raw) => {
    void (async () => {
      const tabId = resolveTab(event.sender);
      if (!tabId) return; // not a session tab → nowhere to route
      const msg = raw as OverlayMarkMsg;
      const r = await host.markElement({ tabId, path: msg.path, payload: msg.payload });
      if ('markId' in r) {
        const number = Number(r.markId.replace(/^m/, '')) || 0; // chip number mirrors the markId suffix
        sendToTab(tabId, IPC.overlayMarkAssigned, { nonce: msg.nonce, markId: r.markId, number });
      }
      await broadcastMarks();
    })();
  });

  // overlay(tab) action bar → main: preview the repeating set → push to the renderer.
  ipc.on(IPC.overlayGeneralize, (_event, raw) => {
    void (async () => {
      const { markId } = raw as { markId: string };
      const preview = await host.handlers.marks({ op: 'generalize', markId });
      sendToRenderer(IPC.generalizePreview, preview);
    })();
  });

  // overlay(tab) → main: the human captured a text selection as a cited quote (⌘⇧C). Persists via the
  // broker as a clip; the captures panel updates through the broker's artifact delta (index.ts).
  ipc.on(IPC.overlayQuote, (event, raw) => {
    void (async () => {
      const tabId = resolveTab(event.sender);
      if (!tabId) return; // not a session tab → nowhere to route
      await host.captureQuote(tabId, raw as QuoteMsg);
    })();
  });

  // overlay(tab) → main: the human dragged a rectangle to clip a region → screenshot artifact.
  ipc.on(IPC.overlayRegion, (event, raw) => {
    void (async () => {
      const tabId = resolveTab(event.sender);
      if (!tabId) return;
      await host.captureRegion(tabId, (raw as RegionMsg).rect);
    })();
  });

  // renderer(chrome) → main: arm the focused tab's marking overlay (⌘M / ◈).
  ipc.on(IPC.armMarkMode, () => {
    const tabId = focusedSessionTab();
    if (tabId) sendToTab(tabId, IPC.overlayArm, undefined);
  });

  // renderer(chrome) → main (invoke): pin a human comment on a mark.
  ipc.handle(IPC.markComment, async (_event, markIdRaw, textRaw) => {
    const r = await host.addComment({ markId: markIdRaw as string, text: textRaw as string });
    await broadcastMarks();
    return r;
  });

  // renderer(chrome) → main (invoke): preview the repeating set for a mark.
  ipc.handle(IPC.markGeneralize, (_event, markIdRaw) => host.handlers.marks({ op: 'generalize', markId: markIdRaw as string }));
}
