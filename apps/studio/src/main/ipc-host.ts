import { ipcMain, type BrowserWindow } from 'electron';
import { IPC, type StudioState, type OverlayMarkMsg, type QuoteMsg } from '../shared/ipc';
import type { TabManager } from './tab-manager';
import type { SessionRegistry } from './session-registry';
import type { StudioHost } from './studio-host';
import type { StudioHostHandlers } from 'wigolo/studio';

export function registerIpc(win: BrowserWindow, tabs: TabManager, sessions: SessionRegistry): void {
  const state = (): StudioState => ({
    sessionName: sessions.current().name,
    tabs: tabs.listTabs(),
  });
  const broadcast = () => win.webContents.send(IPC.stateChanged, state());
  tabs.onChange(broadcast);

  ipcMain.handle(IPC.getState, () => state());
  ipcMain.handle(IPC.tabCreate, (_e, url: string) => {
    const id = tabs.createTab(url);
    sessions.addTab(sessions.current().id, id);
    return id;
  });
  ipcMain.handle(IPC.tabClose, (_e, id: string) => {
    tabs.closeTab(id);
    sessions.removeTab(sessions.current().id, id);
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
  host: Pick<StudioHost, 'markElement' | 'addComment' | 'captureQuote'> & { handlers: Pick<StudioHostHandlers, 'marks'> };
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
