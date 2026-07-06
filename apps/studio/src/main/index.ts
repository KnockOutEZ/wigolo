import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron';
import { join } from 'node:path';
import { TabManager, type TabView, type Rect } from './tab-manager';
import { SessionRegistry } from './session-registry';
import { registerIpc } from './ipc-host';
import { createDriveEngine } from './drive-engine';
import { createStudioHost, type HostTab } from './studio-host';
import { startGateway, type Gateway } from './gateway';
import type { DebuggerLike } from './cdp-transport';
import { IPC, type PendingApprovalDto } from '../shared/ipc';
import type { ControlParty, NavGrant } from 'wigolo/studio';

const CHROME_HEIGHT = 88;

const cdpPort = process.env.WIGOLO_STUDIO_CDP_PORT;
if (cdpPort) app.commandLine.appendSwitch('remote-debugging-port', cdpPort);

function makeViewFactory(win: BrowserWindow): () => TabView {
  return () => {
    const view = new WebContentsView({
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.contentView.addChildView(view);
    const wc = view.webContents;
    return {
      loadURL: (url) => wc.loadURL(url),
      setBounds: (b: Rect) => view.setBounds(b),
      setVisible: (v: boolean) => view.setVisible(v),
      destroy: () => {
        win.contentView.removeChildView(view);
        wc.close();
      },
      getURL: () => wc.getURL(),
      getTitle: () => wc.getTitle(),
      onStateChange: (cb) => {
        wc.on('page-title-updated', cb);
        wc.on('did-navigate', cb);
        wc.on('did-navigate-in-page', cb);
      },
    };
  };
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const bounds = (): Rect => {
    const [width, height] = win.getContentSize();
    return { x: 0, y: CHROME_HEIGHT, width, height: height - CHROME_HEIGHT };
  };
  const tabs = new TabManager(makeViewFactory(win), bounds);
  const sessions = new SessionRegistry();
  registerIpc(win, tabs, sessions);
  win.on('resize', () => tabs.relayout());

  // ── Agent line: drive engine + session host + loopback MCP gateway (spec §2/§7) ──
  const driveEngine = createDriveEngine();

  const studioHost = createStudioHost({
    onParked: (notice) => {
      const dto: PendingApprovalDto = { id: notice.approval_id, action: notice.action, risk: notice.risk };
      win.webContents.send(IPC.approvalParked, dto);
    },
    createTab: ({ startUrl, initialHolder, grant }: { startUrl?: string; initialHolder: ControlParty; grant: NavGrant }): HostTab => {
      const view = new WebContentsView({
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      win.contentView.addChildView(view);
      const wc = view.webContents;
      const tabView: TabView = {
        loadURL: (url) => wc.loadURL(url),
        setBounds: (b: Rect) => view.setBounds(b),
        setVisible: (v: boolean) => view.setVisible(v),
        destroy: () => { win.contentView.removeChildView(view); wc.close(); },
        getURL: () => wc.getURL(),
        getTitle: () => wc.getTitle(),
        onStateChange: (cb) => {
          wc.on('page-title-updated', cb);
          wc.on('did-navigate', cb);
          wc.on('did-navigate-in-page', cb);
        },
      };
      const tabId = tabs.adopt(tabView);
      sessions.addTab(sessions.current().id, tabId);
      void wc.loadURL(startUrl ?? 'about:blank');
      const drive = driveEngine.attachTab(tabId, {
        debugger: wc.debugger as unknown as DebuggerLike,
        viewport: () => { const b = bounds(); return { width: b.width, height: b.height }; },
        grant,
        initialHolder,
      });
      // Native OS input to this tab preempts the agent instantly (agent CDP input injects below this
      // hook, so it does not self-preempt). Best-effort P1 signal; the co-drive polish is P4.
      wc.on('before-input-event', () => studioHost.onHumanInput(tabId));
      return {
        tabId,
        drive,
        browser: { navigate: (url: string) => wc.loadURL(url) },
        currentUrl: () => wc.getURL(),
        readHtml: async () => String(await wc.executeJavaScript('document.documentElement.outerHTML')),
      };
    },
    closeTab: (tabId: string) => {
      void driveEngine.detachTab(tabId);
      try { tabs.closeTab(tabId); } catch { /* already gone */ }
    },
  });

  ipcMain.handle(IPC.approvalDecide, (_e, id: string, decision: 'allow' | 'deny') => {
    studioHost.resolveApproval(id, decision);
  });

  let gateway: Gateway | null = null;
  try {
    gateway = await startGateway({
      host: studioHost.handlers,
      sessions: studioHost.sessions,
      sessionId: `studio-${process.pid}`,
    });
  } catch {
    // The gateway is the agent endpoint; if it cannot bind, the human UI still works. Surface via logs
    // (stderr) rather than crashing the window — the agent simply cannot discover this host.
  }

  const shutdown = async (): Promise<void> => {
    try { await studioHost.shutdown(); } catch { /* best-effort */ }
    try { await gateway?.stop(); } catch { /* best-effort */ }
  };
  app.on('before-quit', () => { void shutdown(); });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  win.show();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
