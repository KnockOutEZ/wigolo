import { app, BrowserWindow, Menu, Tray, WebContentsView, ipcMain, nativeImage, nativeTheme } from 'electron';
import { join } from 'node:path';
import { applyCdpDebugPortFence } from './cdp-fence';
import { chromeWebPreferences, resolveHiddenMode, tabWebPreferences } from './hidden-mode';
import { RunPresentationController } from './run-presentation';
import { createDecisionMirror } from './run-decisions';
import { createRunTray, TRAY_ICON_1X, TRAY_ICON_2X, type RunTrayHandle, type TrayPort } from './run-tray';
import { livingTrayPort } from './tray-lifetime';
import { applyUaIdentityToTab, resolveHostHints, studioUaIdentity, HOST_HINTS_EXPR, type HostHints } from './ua-identity';
import { TabManager, type TabView, type Rect } from './tab-manager';
import { RunViewModel, createBrokerRunStoreClient } from './run-view-model';
import { bridgeRunEventsToBus, createBrokerRunsStore } from './run-rest-store';
import { registerIpc, registerMarksIpc } from './ipc-host';
import { createDriveEngine } from './drive-engine';
import { createStudioHost, type HostTab } from './studio-host';
import { createBrokerClient } from './broker-client';
import { startGateway, type Gateway } from './gateway';
import { readStorageState, applyStorageState, type CookieJar } from './electron-storage';
import type { DebuggerLike } from './cdp-transport';
import { IPC, type PendingApprovalDto, type CaptureDto, type ChatMsgDto } from '../shared/ipc';
import { tokenValue, type Register } from '../renderer/tokens';
import { ProfileStore } from 'wigolo/studio';
import type { ControlParty, NavGrant } from 'wigolo/studio';

const CHROME_HEIGHT = 88; // titlebar (40) + toolbar (48)
const RAIL_WIDTH = 380; // the right Agent rail — kept in sync with .rail width in studio.css

// The remote-debugging port is a development seam (the e2e suite drives it) on a process that
// holds the user's signed-in profile. Packaged builds refuse it outright; see cdp-fence.ts.
applyCdpDebugPortFence(
  { isPackaged: app.isPackaged, appendSwitch: (n, v) => app.commandLine.appendSwitch(n, v) },
  process.env,
  (line) => process.stderr.write(line),
);

// ONE identity for the whole process. `app.userAgentFallback` is what every session inherits, so the
// human's own omnibox tabs and the app shell present the same string the agent's driven tabs will —
// see ua-identity.ts for why a window presenting two identities out of one cookie jar is a sharper
// signal than the Electron token this removes. Driven tabs additionally carry the CDP override, which
// is the only mechanism that also moves the brands and `Sec-CH-UA`.
const uaIdentity = studioUaIdentity({
  nativeUserAgent: app.userAgentFallback,
  chromeVersion: process.versions.chrome,
  platform: process.platform,
});
app.userAgentFallback = uaIdentity.userAgent;

function makeViewFactory(win: BrowserWindow): () => TabView {
  return () => {
    const view = new WebContentsView({ webPreferences: tabWebPreferences() });
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

const hidden = resolveHiddenMode({ argv: process.argv, env: process.env });

/**
 * The window's own ground, resolved from the SAME token definition the renderer resolves against.
 *
 * This colour is painted by the OS before the renderer has a frame and behind the stage while the
 * WebContentsView is between pages, so a hard-coded value here is a seam that only shows up in the
 * register the developer was not looking at — the whole point of one token layer is that there is no
 * second place holding a copy of `--bg`.
 */
function windowRegister(): Register {
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

/** The dev-only read of the menu-bar menu (see `mountRunTray`). */
interface RunMenuProbe {
  labels(): string[];
  checked(): boolean[];
  click(index: number): void;
}

/**
 * Pin 5's menu-bar item. Kept out of `createWindow` because the OS item is the ONE surface that has to
 * exist while no window is presented, and because a status area that refuses to accept an item must not
 * be able to stop the app from booting — a headless run does not need a menu bar to run, only to be found.
 */
function osTrayPort(): TrayPort {
  try {
    const icon = nativeImage.createFromBuffer(TRAY_ICON_1X, { scaleFactor: 1 });
    icon.addRepresentation({ scaleFactor: 2, buffer: TRAY_ICON_2X });
    // Monochrome, tinted by the OS — one asset for both registers, the same rule the token layer follows.
    icon.setTemplateImage(true);
    const item = new Tray(icon);
    // The item is destroyed by the platform during quit while runs are still ending, and every one of
    // those endings is a redraw — so the lifetime is asked about here, once, rather than at each call.
    // See `tray-lifetime.ts`: an unguarded redraw of a dead item is a main-process throw, and Electron
    // answers that with a modal the process can never get past.
    return livingTrayPort(item, {
      setLabel: (text) => item.setTitle(text),
      setToolTip: (text) => item.setToolTip(text),
      setMenu: (items) => item.setContextMenu(Menu.buildFromTemplate(items)),
      destroy: () => item.destroy(),
    });
  } catch (err) {
    // No status area on this system (a bare X11 session, a locked-down desktop). The item is a
    // discovery surface, not a dependency: the dock badge and every other surface still work, and a
    // headless run must not fail to start because there is nowhere to draw an icon.
    process.stderr.write(`[studio] no menu-bar item is available on this system: ${err instanceof Error ? err.message : String(err)}\n`);
    return { setLabel: () => {}, setToolTip: () => {}, setMenu: () => {}, destroy: () => {} };
  }
}

function mountRunTray(runs: RunViewModel, presentation: RunPresentationController): RunTrayHandle {
  const handle = createRunTray({
    tray: osTrayPort(),
    // Absent off macOS; the count in the menu bar is what carries there.
    dock: app.dock ? { setBadge: (text) => app.dock?.setBadge(text) } : undefined,
    runs,
    setVisibility: (runId, next) =>
      next === 'visible'
        ? presentation.promote(runId, 'human', 'tray')
        : presentation.demote(runId, 'human'),
    onError: (err) => process.stderr.write(`[studio] could not change what is on screen: ${err instanceof Error ? err.message : String(err)}\n`),
  });

  // The menu is drawn by the OS, so no driver can click it and the promote path would otherwise be
  // the one affordance no test can reach. This exposes the menu ALREADY BUILT — same items, same
  // handlers, nothing the human cannot do — to the main process, in dev builds only.
  if (!app.isPackaged) {
    (globalThis as typeof globalThis & { __wigoloRunMenu?: RunMenuProbe }).__wigoloRunMenu = {
      labels: () => handle.menu().map((i) => i.label ?? ''),
      checked: () => handle.menu().map((i) => i.checked === true),
      click: (index: number) => handle.menu()[index]?.click?.(),
    };
  }
  return handle;
}

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    show: false,
    // hidden-inset titlebar: the tab strip lives IN the titlebar with the macOS traffic lights inline
    // (the refined browser look). Falls back to a standard frame off macOS.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: tokenValue('--bg', windowRegister()),
    webPreferences: chromeWebPreferences(join(import.meta.dirname, '../preload/index.cjs')),
  });

  // The renderer follows `prefers-color-scheme` live; the frame has to move with it or a register
  // switch leaves the old ground showing around the stage until the next navigation.
  const onNativeThemeUpdated = (): void => {
    if (!win.isDestroyed()) win.setBackgroundColor(tokenValue('--bg', windowRegister()));
  };
  nativeTheme.on('updated', onNativeThemeUpdated);
  win.on('closed', () => nativeTheme.off('updated', onNativeThemeUpdated));

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

  // SD1 spine 1: runs live in the daemon and this projects them. Replacing SessionRegistry, which kept
  // run-shaped facts (identity, tab membership) in a process that any run outlives.
  const runStoreClient = createBrokerRunStoreClient(broker);
  // §6 — this process is the live run-store owner while the app runs, so its gateway serves
  // `/v1/runs*` from the broker and its in-process bus carries what the broker commits. Bridge
  // FIRST: a subscriber that attaches before any append cannot miss one.
  bridgeRunEventsToBus(runStoreClient);
  const runs = new RunViewModel(runStoreClient);
  registerIpc(win, tabs, runs);
  win.on('resize', () => tabs.relayout());

  // Law 2 — headless is the default, and promote/demote is a runtime transition rather than the boot
  // boolean it used to be. `hidden` is now only the BOOT default; which runs are being watched is a
  // fact in the run log, and this moves the window to match it.
  const presentation = new RunPresentationController({
    runs,
    window: win,
    focusTab: (tabId) => tabs.focusTab(tabId),
    bootHidden: hidden,
  });

  // Runs created before this window existed are already in the log; replay them so the chrome opens
  // showing what is actually running. A broker that is not up yet simply leaves the projection empty —
  // the live tail fills it in, and no run is lost by it.
  void runs.hydrate()
    // Presentation is per-app-lifetime: a run that was being watched when the app last quit is written
    // back to hidden, so the log never claims a window the human cannot see.
    .then(() => presentation.reconcile())
    .catch((err: unknown) => {
      process.stderr.write(`[studio] could not replay the run log: ${err instanceof Error ? err.message : String(err)}\n`);
    });

  // Applied here as well as at the end of boot, and only in the withheld direction: a window that is
  // being withheld must be MAPPED as early as possible, because one that never acquired a compositor
  // surface starves its tabs of frames — and there is nothing to flash, since it is transparent. A
  // window the human asked for is shown at the end of boot instead, once the shell has painted.
  if (hidden) presentation.apply();

  const runTray = mountRunTray(runs, presentation);
  const onDecisionError = (err: unknown): void => {
    process.stderr.write(`[studio] could not record an approval on its run: ${err instanceof Error ? err.message : String(err)}\n`);
  };
  const decisions = createDecisionMirror({ runs, onError: onDecisionError });

  // Resolved after the shell loads (below) and read pull-at-eval by createTab. A tab created before the
  // shell finishes loading simply omits the high-entropy hints rather than waiting on them.
  let hostHints: HostHints | null = null;

  const studioHost = createStudioHost({
    broker,
    runs,
    // The host writes region-clip media under the SAME data dir the broker uses (both honor WIGOLO_DATA_DIR).
    config: process.env.WIGOLO_DATA_DIR ? { dataDir: process.env.WIGOLO_DATA_DIR } : undefined,
    // P5: the encrypted origin-scoped profile store (keychain-KEK'd AES-256-GCM; defaults dataDir to getConfig()).
    profileStore: new ProfileStore(process.env.WIGOLO_DATA_DIR ? { dataDir: process.env.WIGOLO_DATA_DIR } : {}),
    // P5: push the login-wall handoff state to the human's login card (only {state, origin?}).
    onLoginHandoff: (msg) => win.webContents.send(IPC.loginHandoff, msg),
    // Region clip: capture a viewport rect of the session tab as PNG bytes (the host hashes + persists).
    capturePage: async (tabId, rect) => {
      const wc = sessionTabWc.get(tabId);
      if (!wc) throw new Error('no such session tab');
      const img = await wc.capturePage(rect);
      return { png: img.toPNG(), url: wc.getURL(), title: wc.getTitle() };
    },
    // S9/D9 §5.1: a card is answerable only when a human can see it. A hidden or minimised window is the
    // background case the amended spec calls the NORMAL path for scheduled work, not an edge case.
    approvalSurfaceAttached: () => !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
    onParked: (notice) => {
      const dto: PendingApprovalDto = { id: notice.approval_id, action: notice.action, risk: notice.risk };
      // Onto the run FIRST, so a run with a card waiting reads `needs_you` everywhere — including the
      // dock badge, which is the only attention affordance a withheld window has.
      //
      // Before the renderer is told, not after, and the order is the whole point: `parked` claims the
      // card's turn synchronously, and the answer to a card the human has not been shown yet cannot
      // arrive before that claim. Told first, a fast click landed while `parked` was still mid
      // round-trip, found no link and no pending card, and was dropped — and two minutes later the log
      // recorded `auto_denied` for a card the broker had approved.
      void decisions.parked(notice).catch(onDecisionError);
      win.webContents.send(IPC.approvalParked, dto);
    },
    // P4: the agent posted a chat message (studio_say) → the chat rail. Agent-authored text; the renderer
    // renders it as an inert text node.
    onSay: (m) => {
      const dto: ChatMsgDto = { author: 'agent', text: m.text, ...(m.markId ? { markId: m.markId } : {}), ts: m.ts };
      win.webContents.send(IPC.chatMessage, dto);
    },
    // P4: the active session changed (open/close) → the renderer re-backfills captures + resets the grant/chat
    // UI for the new session. Also push the fresh grant state (a new session starts un-granted).
    onActiveSessionChange: (sessionId) => {
      win.webContents.send(IPC.sessionChanged, { sessionId });
      win.webContents.send(IPC.grantState, { granted: studioHost.localhostGranted() });
    },
    createTab: async ({ initialHolder, grant, partition }: { initialHolder: ControlParty; grant: NavGrant; partition: string }): Promise<HostTab> => {
      const view = new WebContentsView({
        // The per-tab marking overlay runs in this sandboxed, context-isolated tab's isolated world (P2).
        webPreferences: {
          preload: join(import.meta.dirname, '../preload/overlay.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          // P5 (D-P5-2): an IN-MEMORY per-session partition (NO `persist:` prefix) — storage is isolated
          // per session and lives only in RAM; the only disk state is the AES-256-GCM ProfileStore blob.
          partition,
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
      // Ownership is NOT recorded here. The host attaches the tab to the run it opened the session for,
      // so law 4's one-run-per-tab check runs at one seam instead of at every tab factory.
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
          } else if (msg.t === 'audit') {
            // P6 F4: a recorded agent action → the live Timeline. The host already shaped it page-text-free
            // (auditToWire); forward the whole summary minus the routing tag.
            const { t: _t, ...dto } = msg;
            win.webContents.send(IPC.auditEntry, dto);
          }
        },
      });
      // Only THEN load — and only the safe blank page. The agent's startUrl is navigated by studio_open
      // through the GATED path (guardNavigation), never a raw ungated load. NOTE: native-OS-input
      // preemption detection is deferred to P4 (co-drive polish): Electron's before-input-event fires for
      // BOTH native input AND the agent's own CDP-injected keystrokes (indistinguishable at that hook), so
      // a naive wire self-preempts the agent mid-type. The FSM preemption LOGIC (drive.fsm.onHumanInput,
      // unit/property-tested) is ready for a source-distinguishing signal in P4.
      // The blank load and the identity override are one step, in this order: an `Emulation` command
      // issued against a webContents that has never navigated NEVER RESOLVES, so the override must
      // follow the about:blank load and must never move into attachTab, which runs before any
      // navigation exists. Both complete before this tab is returned, so the agent's first real
      // navigation is the first request that leaves the machine.
      await applyUaIdentityToTab({
        identity: uaIdentity,
        platform: process.platform,
        hints: hostHints,
        loadBlank: () => wc.loadURL('about:blank'),
        sendCdp: (method, params) => drive.transport.send(method, params),
        warn: (line) => process.stderr.write(line),
      });
      return {
        tabId,
        drive,
        browser: { navigate: (url: string) => wc.loadURL(url) },
        currentUrl: () => wc.getURL(),
        readHtml: async () => String(await wc.executeJavaScript('document.documentElement.outerHTML')),
        // P5: HOST-ONLY session storage read/apply (never agent-facing, never logged). `wc.session` is the
        // per-session in-memory partition; cookies R/W via its Cookies API, localStorage read via executeJS.
        storageState: () =>
          readStorageState(
            wc.session.cookies as unknown as CookieJar,
            ((code: string) => wc.executeJavaScript(code)) as never,
            wc.getURL() || undefined,
          ),
        applyStorageState: (state) => applyStorageState(wc.session.cookies as unknown as CookieJar, state),
      };
    },
    // The live tab set, straight off the tab layer — the same one the state broadcast projects ownership
    // onto. A tab is gone from here the moment it is destroyed, which is what lets the listing narrow a
    // still-owned-per-the-log tab out while its release is on the wire.
    tabUniverse: () => tabs.listTabs().map((t) => t.id),
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
  ipcMain.handle(IPC.listAudit, () => studioHost.listAudit());
  ipcMain.handle(IPC.synthesize, () => studioHost.synthesizeSession());
  ipcMain.handle(IPC.knowledgeSimilar, (_e, concept: string) => studioHost.knowledgeSimilar(String(concept ?? '')));

  ipcMain.handle(IPC.approvalDecide, (_e, id: string, decision: 'allow' | 'deny') => {
    studioHost.resolveApproval(id, decision);
    void decisions.resolved(id, decision === 'allow' ? 'approved' : 'denied').catch(onDecisionError);
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
  // P4: the human's chat composer → a trusted `chat` event on the active session (agent drains it in observe).
  ipcMain.on(IPC.chatSend, (_e, text: string) => { void studioHost.postHumanChat(String(text ?? '')); });
  // P6 F1 grab-all: a human "Extract" affordance → the same host handler the agent's studio_extract_set uses.
  // The resulting extraction artifact fans to the captures rail via the existing onArtifact → captureAdded path.
  ipcMain.on(IPC.extractSet, (_e, input: { tab_id: string; mark_id: string; exclude_refs?: string[]; follow_pagination?: boolean }) => {
    void studioHost.handlers.extractSet(input);
  });
  // §13.8c: one-click localhost/private-net grant for the agent on the active session (revocable). Echo the
  // resulting state so the grant card reflects it. link_local/cloud-metadata stays hard-blocked regardless.
  ipcMain.handle(IPC.grantLocalhost, () => { const ok = studioHost.grantLocalhost(); win.webContents.send(IPC.grantState, { granted: studioHost.localhostGranted() }); return ok; });
  ipcMain.handle(IPC.revokeLocalhost, () => { const ok = studioHost.revokeLocalhost(); win.webContents.send(IPC.grantState, { granted: studioHost.localhostGranted() }); return ok; });

  let gateway: Gateway | null = null;
  try {
    gateway = await startGateway({
      host: studioHost.handlers,
      sessions: studioHost.sessions,
      sessionId: `studio-${process.pid}`,
      runStore: createBrokerRunsStore(runStoreClient),
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
    // Last, and after the host: ending every run is a projection change, and the item redraws on each
    // one. Destroying it first left the run log fanning events into a dead OS object, which took the
    // rest of this sequence with it and left the app unable to quit at all.
    try { runTray?.destroy(); } catch { /* best-effort */ }
    decisions.dispose();
    // The projection schedules its own fan-out at each run's auto-deny deadline; after the tray is
    // gone one of those would announce a transition into destroyed surfaces.
    runs.dispose();
  };
  /**
   * Law 1: the log IS the run, so a quit that races its own terminal appends leaves the log and every
   * projection of it permanently disagreeing — a run stuck `running` forever (boot `reconcile()`
   * rewrites visibility, never status) and a `decision.requested` that no surface can ever resolve.
   * `before-quit` is fire-and-forget by default and Electron tears the process down while `shutdown()`
   * is still awaiting its `endRun` appends, on the most ordinary path in the product: Cmd-Q, or the
   * last window closing. So the first quit is CANCELLED and re-issued once shutdown has actually landed.
   *
   * Bounded, because the opposite failure is the worse one: a wedged broker child must not be able to
   * make the app unquittable. A crash is already survivable — the log is append-only and the next boot
   * reads what got there — an app the user cannot close is not. On expiry we leave via `app.exit`,
   * which by contract emits neither `before-quit` nor `will-quit` and so cannot re-enter this handler.
   *
   * The bound is a backstop for a WEDGED broker, so it must sit well clear of what a healthy quit
   * costs — a deadline ordinary use brushes against is not a backstop, it is a truncation with a
   * timer. Measured: eight live sessions cost ~4.2s here, because `shutdown()` walks them serially and
   * each detach and append is a broker round trip. 10s leaves that headroom and still sits under the
   * 15s the e2e lane bounds `close()` at, so a slow quit cannot turn into a red lane either.
   */
  const SHUTDOWN_DEADLINE_MS = 10_000;
  let quitState: 'idle' | 'shutting-down' | 'cleared' = 'idle';
  app.on('before-quit', (event) => {
    if (quitState === 'cleared') return; // our own re-quit below: this is the one that must go through
    event.preventDefault();
    // An impatient second Cmd-Q lands here mid-shutdown. Swallowing it is deliberate: the deadline
    // already bounds the wait, and honouring it would reintroduce exactly the truncated append above.
    if (quitState === 'shutting-down') return;
    quitState = 'shutting-down';
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), SHUTDOWN_DEADLINE_MS);
    });
    const landed = shutdown().catch(() => undefined).then(() => 'landed' as const);
    void Promise.race([landed, expired]).then((outcome) => {
      clearTimeout(timer);
      quitState = 'cleared';
      if (outcome === 'expired') {
        process.stderr.write(`[studio] shutdown did not finish within ${SHUTDOWN_DEADLINE_MS}ms; exiting anyway\n`);
        app.exit(0);
        return;
      }
      app.quit();
    });
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  // The host's own client hints, read ONCE from the shell — a secure context with a real origin.
  // Reading them per-tab off `about:blank` never worked: `navigator.userAgentData` is undefined there,
  // so every tab silently omitted the hints the read-through exists to preserve. These describe the
  // machine rather than the tab, so one read shared by every tab is also the more correct shape.
  hostHints = await resolveHostHints(() => win.webContents.executeJavaScript(HOST_HINTS_EXPR), {
    warn: (line) => process.stderr.write(line),
  });
  // Headless by default: the window is mapped but never presented. GPU stays on and the compositor
  // stays real (this is not offscreen rendering) — only the presentation is withheld, so a background
  // fetch keeps the same renderer, codec and API surface a visible window has. It must be MAPPED, not
  // merely unshown: a never-shown window has no compositor surface, which measurably stops the frame
  // clock for its child views (rAF 0fps) and flips `document.visibilityState` to `hidden`. See
  // hidden-mode.ts for the measurement, and run-presentation.ts for the transition that applies it.
  presentation.apply();
  if (hidden) {
    process.stderr.write('[studio] running hidden: no window is presented; the agent line is live. Promote a run from the menu bar to watch it.\n');
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
