import { app, BrowserWindow, WebContentsView, ipcMain } from 'electron';
import { join } from 'node:path';
import { TabManager, type TabView, type Rect } from './tab-manager';
import { SessionRegistry } from './session-registry';
import { registerIpc, registerMarksIpc } from './ipc-host';
import { createDriveEngine } from './drive-engine';
import { createStudioHost, type HostTab } from './studio-host';
import { createBrokerClient } from './broker-client';
import { startGateway, type Gateway } from './gateway';
import type { DebuggerLike } from './cdp-transport';
import { IPC, type PendingApprovalDto, type CaptureDto } from '../shared/ipc';
import type { ControlParty, NavGrant } from 'wigolo/studio';

const CHROME_HEIGHT = 88; // titlebar (40) + toolbar (48)
const RAIL_WIDTH = 380; // the right Agent rail — kept in sync with .rail width in studio.css

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
    width: 1360,
    height: 880,
    show: false,
    // hidden-inset titlebar: the tab strip lives IN the titlebar with the macOS traffic lights inline
    // (the refined browser look). Falls back to a standard frame off macOS.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0c0c10',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // The Agent rail occupies a fixed right column; the WebContentsView stage is everything left of it,
  // below the chrome. Toggling the rail (from the renderer) reflows the stage to reclaim/yield the column.
  let railOpen = true;
  // P4: the drive banner is a chrome strip over the stage; when shown it insets the WebContentsView (like
  // the rail) so it never covers the driven page.
  let bannerOpen = false;
  const BANNER_H = 36; // keep in sync with .drive-banner height in studio.css
  const bounds = (): Rect => {
    const [width, height] = win.getContentSize();
    const top = CHROME_HEIGHT + (bannerOpen ? BANNER_H : 0);
    return { x: 0, y: top, width: width - (railOpen ? RAIL_WIDTH : 0), height: height - top };
  };
  const tabs = new TabManager(makeViewFactory(win), bounds);
  const sessions = new SessionRegistry();
  registerIpc(win, tabs, sessions);
  win.on('resize', () => tabs.relayout());

  // ── Agent line: drive engine + session host + loopback MCP gateway (spec §2/§7) ──
  const driveEngine = createDriveEngine();

  // P2 marking: correlate a session tab's webContents ↔ tabId (the overlay preload posts marks via
  // ipcMain; resolveTab maps event.sender → the session so mark creation reaches the right host session).
  const sessionTabWc = new Map<string, Electron.WebContents>();
  let lastSessionTabId: string | null = null;

  // P3 — the DB broker: a plain-Node child owns the cache DB so this Electron main never loads a native
  // module (spec §13.7/§13.9). It inherits WIGOLO_DATA_DIR from this process, so captures land in the
  // same local library the agent's cache/find_similar read. The host calls it for capture + find_similar.
  const broker = createBrokerClient();

  const studioHost = createStudioHost({
    broker,
    // The host writes region-clip media under the SAME data dir the broker uses (both honor WIGOLO_DATA_DIR).
    config: process.env.WIGOLO_DATA_DIR ? { dataDir: process.env.WIGOLO_DATA_DIR } : undefined,
    // Region clip: capture a viewport rect of the session tab as PNG bytes (the host hashes + persists).
    capturePage: async (tabId, rect) => {
      const wc = sessionTabWc.get(tabId);
      if (!wc) throw new Error('no such session tab');
      const img = await wc.capturePage(rect);
      return { png: img.toPNG(), url: wc.getURL(), title: wc.getTitle() };
    },
    onParked: (notice) => {
      const dto: PendingApprovalDto = { id: notice.approval_id, action: notice.action, risk: notice.risk };
      win.webContents.send(IPC.approvalParked, dto);
    },
    createTab: async ({ initialHolder, grant }: { initialHolder: ControlParty; grant: NavGrant }): Promise<HostTab> => {
      const view = new WebContentsView({
        // The per-tab marking overlay runs in this sandboxed, context-isolated tab's isolated world (P2).
        webPreferences: {
          preload: join(import.meta.dirname, '../preload/overlay.mjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
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
      sessionTabWc.set(tabId, wc);
      lastSessionTabId = tabId;
      sessions.addTab(sessions.current().id, tabId);
      // Arm the SSRF/redirect fence FIRST (awaited) — attachTab resolves only once Fetch.enable is acked.
      const drive = await driveEngine.attachTab(tabId, {
        debugger: wc.debugger as unknown as DebuggerLike,
        viewport: () => { const b = bounds(); return { width: b.width, height: b.height }; },
        grant,
        initialHolder,
        // P4 co-drive: fan control flips + agent acts to the chrome renderer (drive banner / provenance dots /
        // narration) and, for acts that resolved a target point, the session-tab overlay (ghost cursor). The
        // ghost cursor MUST render in the isolated-world overlay — renderer DOM sits behind the WebContentsView.
        broadcast: (msg) => {
          if (msg.t === 'control') {
            win.webContents.send(IPC.driveEvent, { tabId, t: 'control', holder: msg.holder as 'human' | 'agent', epoch: msg.epoch as number });
          } else if (msg.t === 'act') {
            win.webContents.send(IPC.driveEvent, {
              tabId, t: 'act',
              action: typeof msg.action === 'string' ? msg.action : undefined,
              narration: typeof msg.narration === 'string' ? msg.narration : undefined,
            });
          } else if (msg.t === 'point') {
            // act.ts emits the coords under `center` (NOT top-level x/y) — read them there.
            const c = msg.center as { x: number; y: number } | undefined;
            if (c) wc.send(IPC.overlayCursor, { x: c.x, y: c.y, caption: typeof msg.caption === 'string' ? msg.caption : '' });
          }
        },
      });
      // Only THEN load — and only the safe blank page. The agent's startUrl is navigated by studio_open
      // through the GATED path (guardNavigation), never a raw ungated load. NOTE: native-OS-input
      // preemption detection is deferred to P4 (co-drive polish): Electron's before-input-event fires for
      // BOTH native input AND the agent's own CDP-injected keystrokes (indistinguishable at that hook), so
      // a naive wire self-preempts the agent mid-type. The FSM preemption LOGIC (drive.fsm.onHumanInput,
      // unit/property-tested) is ready for a source-distinguishing signal in P4.
      void wc.loadURL('about:blank');
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
      sessionTabWc.delete(tabId);
      if (lastSessionTabId === tabId) lastSessionTabId = null;
      try { tabs.closeTab(tabId); } catch { /* already gone */ }
    },
  });

  // P2 marking IPC: overlay(tab) ↔ main ↔ chrome renderer. Mark creation reaches the host ONLY here
  // (human seam), never the agent gateway — the agent handler surface stays the sealed 7-key set.
  const broadcastMarks = async (): Promise<void> => {
    const r = await studioHost.listMarks();
    const marks = 'marks' in r ? r.marks.map((m) => ({ markId: m.markId, role: m.role, name: m.name, confidence: m.confidence, ...(m.ref ? { ref: m.ref } : {}) })) : [];
    win.webContents.send(IPC.marksChanged, marks);
  };
  registerMarksIpc({
    ipcMain,
    host: studioHost,
    resolveTab: (sender) => { for (const [id, wc] of sessionTabWc) if (wc === sender) return id; return undefined; },
    sendToTab: (tabId, channel, payload) => sessionTabWc.get(tabId)?.send(channel, payload),
    sendToRenderer: (channel, payload) => win.webContents.send(channel, payload),
    broadcastMarks,
    focusedSessionTab: () => lastSessionTabId ?? undefined,
  });

  // P3 capture rail: a live captured-item delta (agent clip / human quote / region screenshot) → the
  // Captures pane; on-open list + knowledge rail read through the host (→ broker, degrade to [] when down).
  broker.onArtifact((d) => {
    const dto: CaptureDto = { id: d.id, type: d.type, title: d.title, url: d.url, trusted: d.trusted, createdAt: d.created_at };
    win.webContents.send(IPC.captureAdded, dto);
  });
  ipcMain.handle(IPC.listCaptures, () => studioHost.listCaptures());
  ipcMain.handle(IPC.knowledgeSimilar, (_e, concept: string) => studioHost.knowledgeSimilar(String(concept ?? '')));

  ipcMain.handle(IPC.approvalDecide, (_e, id: string, decision: 'allow' | 'deny') => {
    studioHost.resolveApproval(id, decision);
  });

  ipcMain.handle(IPC.setRailOpen, (_e, open: boolean) => {
    railOpen = !!open;
    tabs.relayout(); // reflow the WebContentsView stage to match the new rail state
  });

  // P4 co-drive human seams (Electron-IPC only — NOT the agent gateway; PIN-SPLIT(b)).
  ipcMain.handle(IPC.driveReclaim, (_e, tabId: string) => {
    // Pause / take-over: an EXPLICIT human signal preempts the agent on this tab (token.reclaim → the
    // in-flight agent unit is fenced). This is the deliberate takeover, distinct from the deferred native
    // before-input-event hook (which cannot tell the agent's own CDP input apart from a human keystroke).
    studioHost.onHumanInput(String(tabId));
  });
  ipcMain.on(IPC.armClip, () => {
    const id = lastSessionTabId;
    if (id) sessionTabWc.get(id)?.send(IPC.clipArm);
  });
  ipcMain.handle(IPC.setBannerOpen, (_e, open: boolean) => {
    bannerOpen = !!open;
    tabs.relayout(); // reflow the WebContentsView stage to make room for / reclaim the banner
  });

  let gateway: Gateway | null = null;
  try {
    gateway = await startGateway({
      host: studioHost.handlers,
      sessions: studioHost.sessions,
      sessionId: `studio-${process.pid}`,
    });
  } catch (err) {
    // The gateway is the agent endpoint; if it cannot bind, the human UI still works. Surface the
    // failure on stderr (never stdout) rather than crashing the window — the agent simply cannot
    // discover this host until it is fixed.
    process.stderr.write(`[studio] agent gateway failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  }

  const shutdown = async (): Promise<void> => {
    try { await studioHost.shutdown(); } catch { /* best-effort */ }
    try { await gateway?.stop(); } catch { /* best-effort */ }
    try { await broker.stop(); } catch { /* best-effort */ }
  };
  app.on('before-quit', () => { void shutdown(); });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  win.show();
  win.focus(); // take foreground on launch (a background/CLI launch otherwise leaves the window unfocused)
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
