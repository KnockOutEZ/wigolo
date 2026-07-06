import {
  ControlToken,
  NavEpoch,
  NavInterceptor,
  SessionController,
  policyForHolder,
  type ControlParty,
  type NavGrant,
} from 'wigolo/studio';
import { webContentsDebuggerTransport, type CdpTransport, type DebuggerLike } from './cdp-transport';
import { debuggerInputSink } from './debugger-input-sink';
import { PreemptionFsm } from './preemption-fsm';

// Per-tab drive engine. For each tab it stands up the CDP transport (over the tab's
// webContents.debugger), the agent synthetic-input sink, and the salvaged domain
// fences — all sharing ONE control token so the preemption FSM and the agent input
// channel agree by construction. Attaching a tab is what ARMS the SSRF/nav
// interceptor: a tab is never drivable with the redirect fence disarmed.
//
// The engine holds the per-tab machinery; the studio host (T6) layers the observe/act
// handlers on top via getDrive(tabId).

/** What attachTab needs to stand a tab up (real WebContentsView.debugger in main; fake in tests). */
export interface AttachDeps {
  debugger: DebuggerLike;
  /** Live viewport size (CSS px) — the agent scroll/center aim reads it fresh. */
  viewport: () => { width: number; height: number };
  /** Per-session nav grant (the human's private-network allowance) — read pull-at-eval by the interceptor. */
  grant: NavGrant;
  /** §5: agent-spawned background tab starts under agent control; a human-attended tab stays human (default). */
  initialHolder?: ControlParty;
  /** Push control-state flips to the renderer (drive banner / provenance dots). Defaults to a no-op. */
  broadcast?: (msg: Record<string, unknown>) => void;
}

/** The live per-tab drive record the host acts through. */
export interface TabDrive {
  transport: CdpTransport;
  controlToken: ControlToken;
  fsm: PreemptionFsm;
  navEpoch: NavEpoch;
  navInterceptor: NavInterceptor;
  /** SessionController — the single token-gated agent input channel act.ts dispatches through. */
  channel: SessionController;
  grant: NavGrant;
}

export interface DriveEngine {
  attachTab(tabId: string, deps: AttachDeps): Promise<TabDrive>;
  getDrive(tabId: string): TabDrive | undefined;
  detachTab(tabId: string): Promise<void>;
}

export function createDriveEngine(): DriveEngine {
  const tabs = new Map<string, TabDrive>();

  return {
    async attachTab(tabId: string, deps: AttachDeps): Promise<TabDrive> {
      const transport = webContentsDebuggerTransport(deps.debugger);
      transport.attach();

      const inputSink = debuggerInputSink(transport, deps.viewport);
      const controlToken = new ControlToken(deps.initialHolder ? { initialHolder: deps.initialHolder } : {});
      const fsm = new PreemptionFsm(controlToken);
      const navEpoch = new NavEpoch();
      const channel = new SessionController(controlToken, inputSink, deps.broadcast ?? (() => {}));

      // PULL-AT-EVAL policy: the interceptor reads the LIVE holder at each hop, so a
      // control flip takes effect on the very next hop (no re-arm window). Allowed hops
      // bump the nav epoch (the capture-path TOCTOU fence); blocked hops never bump.
      const navInterceptor = new NavInterceptor(
        () => policyForHolder(controlToken.holder, deps.grant),
        () => navEpoch.bumpNavigation(),
      );
      // FAIL-CLOSED, ARMED-BEFORE-DRIVABLE: AWAIT the fence arm (Fetch.enable, scoped to Document
      // requests) BEFORE the drive is returned/registered — so the tab is never drivable, and no
      // initial navigation is ever issued, while the SSRF/redirect fence is disarmed. If arming
      // rejects, detach and throw so the caller REFUSES the session rather than exposing an
      // unguarded tab (matches the salvaged nav.ts fail-closed contract).
      try {
        await navInterceptor.start(transport);
      } catch (err) {
        transport.detach();
        throw err;
      }

      const drive: TabDrive = { transport, controlToken, fsm, navEpoch, navInterceptor, channel, grant: deps.grant };
      tabs.set(tabId, drive);
      return drive;
    },

    getDrive(tabId: string): TabDrive | undefined {
      return tabs.get(tabId);
    },

    async detachTab(tabId: string): Promise<void> {
      const drive = tabs.get(tabId);
      if (!drive) return;
      tabs.delete(tabId);
      await drive.navInterceptor.stop();
      drive.transport.detach();
    },
  };
}
