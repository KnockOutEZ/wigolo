import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { DaemonHttpServer } from '../daemon/http-server.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { checkBindHost } from '../studio/bind.js';
import { resolveHostToken } from '../studio/auth.js';
import { SessionRegistry } from '../studio/registry.js';
import type { Session } from '../studio/session.js';
import { SessionBrowser, type SessionBrowserLauncher, type StorageStateInput } from '../studio/session-browser.js';
import { ProfileStore } from '../studio/profile-store.js';
import { ScreencastBridge } from '../studio/screencast.js';
import { ControlToken } from '../studio/control-token.js';
import { InputForwarder } from '../studio/input.js';
import { SessionController } from '../studio/session-control.js';
import { NavInterceptor, navigateSession } from '../studio/nav.js';
import { policyForHolder, type NavGrant } from '../studio/nav-policy.js';
import { StudioWsHub } from '../studio/ws-hub.js';
import { writeHandle, removeHandle, studioHandlePath, setMyInstanceId, type SessionHandle } from '../studio/handle.js';
import { closeDaemonBrowser } from '../fetch/playwright-tier.js';
import { PageSnapshotter, buildSnapshot, flattenDom, type AxNode, type DomNode } from '../studio/perception/snapshot.js';
import { createResolver } from '../studio/perception/resolve.js';
import { StudioEventQueue } from '../studio/event-queue.js';
import { createObserver } from '../studio/observe.js';
import { createActHandler } from '../studio/act.js';
import { createCaptureHandler } from '../studio/capture/handler.js';
import { getDatabase } from '../cache/db.js';
import { SessionAuditLog } from '../studio/audit.js';
import { SessionApprovals } from '../studio/approvals.js';
import { createInspector } from '../studio/mark/inspect.js';
import { MarkStore, type StudioMark } from '../studio/mark/store.js';
import { isCredentialContext } from '../studio/credential.js';
import { LoginHandoff } from '../studio/handoff.js';
import { buildTarget, buildTargetFromFlat, indexAxByBackendNode, type StructuredTarget } from '../studio/mark/target.js';
import { heal, type HealResult } from '../studio/mark/heal.js';
import { generalize, applyGeometry, type GenBox } from '../studio/mark/generalize.js';
import type {
  StudioObserveInput,
  StudioObserveOutput,
  StudioActInput,
  StudioActOutput,
  StudioMarksInput,
  StudioMarksOutput,
  StudioMarkView,
  StudioGeneralizeOutput,
  StudioToolError,
} from '../daemon/studio-dispatch.js';
import { randomUUID } from 'node:crypto';

/** Bounded human-event buffer; overflow is fail-loud (drained events surface a dropped count → resync). */
const STUDIO_EVENT_QUEUE_MAX = 256;
/** Total byte budget the spill-dir GC enforces (snapshots + diffs + vision PNGs). In-code, not operator-tunable. */
const STUDIO_SPILL_MAX_BYTES = 64 * 1024 * 1024;

const logger = createLogger('cli');

function log(msg: string): void {
  process.stderr.write(`[wigolo studio] ${msg}\n`);
}

export interface StudioArgs {
  port: number;
  host: string;
  allowRemote: boolean;
}

export function parseStudioArgs(args: string[]): StudioArgs {
  const config = getConfig();
  let port = config.daemonPort;
  let host = config.daemonHost;
  let allowRemote = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed)) port = parsed;
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--allow-remote') {
      allowRemote = true;
    }
  }

  return { port, host, allowRemote };
}

export interface StudioHostOptions extends StudioArgs {
  /** Override the data dir for the session handle (tests). Defaults to config. */
  dataDir?: string;
  /** Inject a registry (tests). Defaults to a fresh in-memory registry. */
  registry?: SessionRegistry;
  /** Inject the session-browser launcher (tests). Defaults to the real Playwright launcher. */
  browserLauncher?: SessionBrowserLauncher;
  /** Slice 5d: the opted-in named profile id (opaque). Set ⇒ load that profile's storageState on launch; unset ⇒ a clean default session. */
  profileId?: string;
  /** Inject the profile store (tests). Defaults to the keychain-backed ProfileStore. Only consulted when profileId is set. */
  profileStore?: ProfileStore;
  /** Inject the mark store (tests). Defaults to a fresh in-memory MarkStore. */
  markStore?: MarkStore;
}

export interface StudioHost {
  daemon: DaemonHttpServer;
  registry: SessionRegistry;
  session: Session;
  sessionBrowser: SessionBrowser;
  bridge: ScreencastBridge;
  controller: SessionController;
  navInterceptor: NavInterceptor;
  /** Navigate the session as the human (holder-gated + guarded); broadcasts {t:'error'} on a non-holder or blocked target. */
  navigate: (url: string) => Promise<void>;
  /** Arm inspect mode for the human to mark an element (holder-gated; mirrors {t:'mark'}). Exposed for the headed tests + Phase-7 UI. */
  mark: () => Promise<void>;
  /** The human's marked structured targets (in-memory; Phase-4 persists). Exposed for the host-boundary/headed tests + the Phase-3c studio_marks tool. */
  marks: () => StudioMark[];
  /** Re-resolve a stored mark against the CURRENT page via the heal cascade (mark→live ref). Exposed for the headed tests + the Phase-3c studio_marks tool. */
  healMark: (markId: string) => Promise<HealResult | { error: 'no_such_mark' }>;
  /** The studio_marks list view: each mark's descriptor + current heal verdict + a live ref for the actionable ones. Exposed for the headed tests. */
  marksView: () => Promise<StudioMarksOutput>;
  /** Preview the repeating sibling set a mark belongs to (Phase 3d generalize op — preview-only READ, never acts). Exposed for the headed tests + the studio_marks generalize op. */
  generalizeMark: (markId?: string) => Promise<StudioGeneralizeOutput | StudioToolError>;
  /** The studio_marks tool entry: lists marks, or (op='generalize') previews a mark's repeating set. Exposed for the host-boundary/headed tests. */
  marksTool: (input: StudioMarksInput) => Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError>;
  /** The agent's observe verb (studio_observe) — host-authoritative snapshot + event drain. Exposed for the host-boundary/headed tests. */
  observe: (input: StudioObserveInput) => Promise<StudioObserveOutput | StudioToolError>;
  /** The agent's acting verb (studio_act), wrapped so a post-act login wall hands off to the human (5e-a). Host-authoritative. Exposed for the host-boundary tests. */
  act: (input: StudioActInput) => Promise<StudioActOutput | StudioToolError>;
  /** Phase 6b: the per-session append-only audit log of every agent action + outcome (for trust + the Phase-7 replay timeline). Exposed for the timeline + headed tests. */
  audit: SessionAuditLog;
  /** Phase 6c: the host↔human approval gate — risky actions are held here pending the human's WS answer. Exposed for the headed proof + the Phase-7 approval card. */
  approvals: SessionApprovals;
  /** Human-only, per-session, revocable: lift the agent's localhost/RFC1918 nav block (cloud-metadata stays blocked). */
  grantAgentPrivateNav: (on: boolean) => void;
  /** Slice 5e-a: the login-wall handoff machine — wall-detect → human-holding → completing/aborted/vanished. Exposed for the host-boundary/headed tests. */
  handoff: LoginHandoff;
  hub: StudioWsHub;
  handle: SessionHandle;
  endpoint: string;
}

/**
 * Boot the Studio host: refuse an unsafe bind, resolve the bearer token, WARM
 * the embedding model before anything is live (so a cold model load can't stall
 * a later live session), start the authenticated host, register a session, and
 * publish its handle. Throws on a refused bind. No live browser yet (Phase 1).
 */
export async function startStudioHost(opts: StudioHostOptions): Promise<StudioHost> {
  const bind = checkBindHost(opts.host, { allowRemote: opts.allowRemote });
  if (!bind.ok) {
    throw new Error(bind.message);
  }

  const { token, minted } = resolveHostToken(getConfig().studioAuthToken);
  if (minted) {
    log('using a freshly minted per-launch token (written to the session handle for the local agent)');
  }

  // Collision-resistant host-instance id, set in memory BEFORE the handle is published.
  // The studio_* dispatch self-reference guard matches on this (not pid) — pid reuse
  // across a dead host can't false-match, and a non-host process holds no id.
  const instanceId = randomUUID();
  setMyInstanceId(instanceId);

  const registry = opts.registry ?? new SessionRegistry();
  // Late-bound: the screencast bridge is created once the session browser is up,
  // but the hub (which routes client frame-acks to it) must exist before the daemon.
  // Late-bound: bridge + controller are created once the session browser is up,
  // but the hub (which routes client ack/input/control to them) precedes the daemon.
  let bridge: ScreencastBridge | undefined;
  let controller: SessionController | undefined;
  // Late-bound like controller: the login-wall handoff machine is created once the session
  // browser + perception are up, but the hub's onDetach (which routes a client disconnect to
  // it for the LOCKED vanish) must be wired before the daemon.
  let handoff: LoginHandoff | undefined;
  let onNavHandler: ((msg: Record<string, unknown>) => void) | undefined;
  let onMarkHandler: ((msg: Record<string, unknown>) => void) | undefined;
  let onApprovalHandler: ((msg: Record<string, unknown>) => void) | undefined;
  // The WS hub fans frames/input over the host's WebSocket; the daemon authorizes
  // each upgrade (Origin/Host + subprotocol bearer) before handing it here. WS
  // clients are session viewers, so onAttach/onDetach keep the Session's client
  // count accurate (it backs idle-eviction) for connect AND every disconnect
  // (graceful close, error, or heartbeat reap); onAck paces the screencast;
  // onInput/onControl drive the token-gated input channel (WS = the human party).
  const hub = new StudioWsHub({
    onAttach: (id) => registry.get(id)?.attach(),
    onDetach: (id) => {
      registry.get(id)?.detach();
      // A disconnect (graceful, error, or heartbeat reap of a half-open client)
      // releases any input the holder left pressed — no stranded drag/modifier.
      controller?.onClientGone();
      // If a client vanishes mid-login-handoff, LOCK the handoff (no auto re-grant to the agent).
      handoff?.onClientGone();
    },
    onAck: () => bridge?.onClientAck(),
    onInput: (_id, msg) => {
      void controller?.handleWireInput(msg);
    },
    onControl: (_id, msg) => controller?.handleWireControl(msg),
    onNav: (_id, msg) => onNavHandler?.(msg),
    onMark: (_id, msg) => onMarkHandler?.(msg),
    // The human's answer to a held risky action ({t:'approval'}). The WS is the human channel, so
    // an approval can only originate from the human (the agent drives via studio_act, never the WS).
    onApproval: (_id, msg) => onApprovalHandler?.(msg),
    // Tell a connecting client the current {holder, epoch} so it stamps valid input
    // even if it joins after a flip (defaults before the controller exists).
    helloExtras: () => controller?.controlSnapshot() ?? { holder: 'human', epoch: 0 },
  });
  const daemon = new DaemonHttpServer({
    port: opts.port,
    host: opts.host,
    auth: { token, host: opts.host },
    requestTimeoutMs: getConfig().studioRequestTimeoutMs,
    onUpgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head),
  });

  const endpoint = await daemon.start();

  // Warm the embedding model in the BACKGROUND now that the host endpoint is reachable. This was
  // previously awaited here (warm-before-live), which blocked the host on a cold model load/DOWNLOAD
  // — the Phase-0 model-init risk, the same one that blocked MCP `initialize` on the shared path.
  // Backgrounding it binds the endpoint first and warms behind it; a session that beats the warm
  // lazy-loads on first real use. (The pre-warm still avoids the common mid-session stall.)
  log('warming embedding model in the background…');
  void getEmbedProvider().catch((e) =>
    logger.debug('embedding warm failed', { error: e instanceof Error ? e.message : String(e) }),
  );

  const session = registry.create({ endpoint, token });

  // Bring up the session's dedicated headed browser, then the screencast bridge,
  // before publishing the handle — so the session is fully live (streamable) by
  // the time a client can discover it.
  // Slice 5d: when the session opts into a named profile, resolve its storageState FRESH per launch
  // (start + crash recovery) via the 5c store. profile_absent (opted-in but not-yet-persisted) ⇒
  // undefined ⇒ a clean session (5e's first login persists it). No profile content is logged.
  let loadProfile: (() => Promise<StorageStateInput>) | undefined;
  if (opts.profileId) {
    const profileStore = opts.profileStore ?? new ProfileStore();
    const profileId = opts.profileId;
    loadProfile = async (): Promise<StorageStateInput> => {
      const r = await profileStore.get(profileId);
      return r.ok ? (JSON.parse(r.storageState) as StorageStateInput) : undefined;
    };
  }
  const sessionBrowser = new SessionBrowser({ sessionId: session.id, launch: opts.browserLauncher, loadProfile });
  await sessionBrowser.start();

  const cfg = getConfig();
  // Control token + input forwarder + their coordinator. The forwarder maps
  // normalized client coords to true page CSS px from the latest frame metadata
  // (so the configured viewport is only the pre-first-frame fallback).
  const controlToken = new ControlToken();
  const forwarder = new InputForwarder({
    cdp: sessionBrowser.cdp,
    viewport: { width: cfg.studioScreencastMaxWidth, height: cfg.studioScreencastMaxHeight },
  });
  controller = new SessionController(controlToken, forwarder, (msg) => hub.broadcast(session.id, msg));

  // Phase 6c approval gate: hold a risky agent action until the human answers over the WS. The
  // {t:'approval_request'} goes out via the same per-session broadcast the controller uses; the
  // human's {t:'approval', id, decision} routes back through the hub's onApproval below. A human
  // reclaim aborts every pending request (onChange below) so a held action does not survive a
  // takeover — and the act handler layers the epoch fence on top.
  const approvals = new SessionApprovals({ broadcast: (msg) => hub.broadcast(session.id, msg) });
  onApprovalHandler = (msg) => approvals.handleWire(msg);

  // Navigation guard. The agent path is fail-closed by default: the agent reaches
  // localhost/RFC1918 only via an explicit, human-issued, revocable per-session grant
  // (cloud-metadata stays blocked for either party in guardNavigation regardless of
  // the grant). The interceptor re-validates every redirect hop on the session's CDP
  // layer (the fetch/crawl path through http-client.ts is untouched).
  const grant: NavGrant = {
    humanAllowPrivate: cfg.studioNavAllowPrivateForHuman,
    agentAllowPrivate: cfg.studioAgentNavAllowPrivate,
  };
  // PULL-AT-EVAL: the interceptor reads the live control-token holder + grant at each
  // hop-evaluation, so a flip to the agent takes effect on the very NEXT hop (incl. a
  // redirect hop already mid-chain) with no disarm→re-arm window where a stale, more
  // permissive policy could leak a hop through.
  const navInterceptor = new NavInterceptor(() => policyForHolder(controlToken.holder, grant));
  await navInterceptor.start(sessionBrowser.cdp);
  // Finding A: rebind the nav interceptor on the FRESH cdp BEFORE the crash-recovery
  // re-navigation (awaited pre-nav hook), so a redirect hop during recovery is
  // re-validated on the agent path too. Screencast/input rebinds stay in onRecovered
  // (post-goto) — they don't gate navigation, so their order vs the re-nav is moot.
  sessionBrowser.onBeforeReNav(async (cdp) => {
    await navInterceptor.rebind(cdp);
  });
  // Finding C nav-analog of the in-flight-click abort: a human reclaim (or the agent
  // releasing control) aborts the agent's in-flight navigation so it cannot complete
  // under a now-revoked grant — Page.stopLoading, a half-loaded page is fine. A grant
  // (flip TO the agent) does NOT abort. Crash-recovery re-nav is host-initiated (no
  // token flip) so it is unaffected by this gate.
  controlToken.onChange((s) => {
    if (s.holder === 'human') {
      void navInterceptor.abortInFlight();
      // Drop any action held pending approval — a reclaim is a takeover; the held action must not
      // survive it. The act handler's post-wait epoch fence is the hard backstop; this just makes
      // the abort prompt rather than waiting for the request to time out.
      approvals.abortPending();
    }
  });
  // Human-only, per-session, revocable grant. The agent cannot reach this (it drives
  // via studio_act, not the host API); `grant` is a closure local to this session so
  // it never leaks to another. pull-at-eval picks the new value up on the next hop.
  const grantAgentPrivateNav = (on: boolean): void => {
    grant.agentAllowPrivate = on;
  };

  // Perception + the agent's observe path. The event queue records human navigations and
  // marks (3a) for studio_observe to drain exactly-once.
  const eventQueue = new StudioEventQueue(STUDIO_EVENT_QUEUE_MAX);
  const snapshotter = new PageSnapshotter({ tokenBudget: cfg.studioSnapshotTokenBudget });

  // Whether the LIVE page is a credential context (login URL OR a credential field present). The
  // host probe behind the 5e-0/5b exclusions; here it also drives the 5e-a wall detection + the
  // handoff's completion check. Host-side detection — the snapshot/url are never agent-facing.
  const isCredentialPage = async (): Promise<boolean> => {
    const snap = await snapshotter.snapshot(sessionBrowser.cdp);
    let pageUrl: string | undefined;
    try {
      pageUrl = sessionBrowser.page.url();
    } catch {
      /* not started / no url — the field signal still applies */
    }
    return isCredentialContext({ pageUrl, fields: snap.domByRef?.values() });
  };

  // Slice 5e-a: the login-wall handoff machine. Wall-detect reclaims to the human (instant
  // takeover) + signals the agent to wait; the human logs in; completion (left the credential
  // context + a meaningful storageState delta) invokes onComplete — the seam 5e-b (persist the
  // profile origin-scoped) + 5e-c (re-grant + authenticated resume) fill. A timeout/disconnect
  // LOCKS it (no auto re-grant). storageState() is the host-only read-back; never agent-facing,
  // never logged. The machine drives the event queue's content-drop so a credential-context mark
  // name (a displayed secret) or a login navigation generated during the window never reaches
  // the agent — only the login_handoff signal does.
  handoff = new LoginHandoff({
    controlToken,
    eventQueue,
    pageContext: isCredentialPage,
    storageState: () => sessionBrowser.storageState(),
    currentUrl: () => {
      try {
        return sessionBrowser.page.url();
      } catch {
        return undefined;
      }
    },
    onComplete: async () => {
      // 5e-a SEAM (stub): 5e-b captures + persists the storageState origin-scoped via the profile
      // store; 5e-c re-grants control to the agent + resumes the authenticated session. 5e-a does
      // neither — it only invokes this hook on a DETECTED completion (never on abort/vanish).
    },
  });
  const loginHandoff = handoff;
  // A control-token flip TO the agent during the window can only be an explicit human WS grant —
  // end the window (the machine never grants itself; the agent can't self-grant).
  controlToken.onChange((s) => loginHandoff.onControlChange(s.holder));

  const navigate = async (url: string): Promise<void> => {
    // Finding C: navigation is holder-gated. {t:nav} is the host-stamped HUMAN channel,
    // so refuse it unless the human currently holds the token — a non-holder viewer
    // cannot steer the shared browser while the agent drives. (Recovery re-nav is
    // host-initiated and bypasses this closure entirely.)
    if (controlToken.holder !== 'human') {
      hub.broadcast(session.id, { t: 'error', reason: 'not_control_holder' });
      return;
    }
    const r = await navigateSession(sessionBrowser, url, policyForHolder('human', grant));
    if (r.ok) {
      // human nav → the agent learns of it via studio_observe, EXCEPT during a login-handoff
      // window: a login-step navigation is credential-context content and is dropped at source.
      loginHandoff.enqueueContentEvent({ type: 'navigation', url });
      // A human navigation during the window may be the one that completes the login. Awaited so
      // the completion lands before the nav returns; an immediate no-op when no window is open.
      await loginHandoff.checkCompletion();
    } else hub.broadcast(session.id, { t: 'error', reason: r.reason });
  };
  onNavHandler = (msg) => {
    void navigate(typeof msg.url === 'string' ? msg.url : '');
  };

  // Mark-to-action (Phase 3a). The human arms inspect mode via {t:'mark'} on the WS (the
  // host-stamped HUMAN channel), holder-gated like {t:'nav'} so a pick cannot hijack the
  // agent's synthesized clicks while it drives. A picked node resolves to a structured target
  // off the privileged AX⋈DOM, lands in the in-memory MarkStore (durable cache capture is
  // Phase 4), and surfaces to the agent as a studio_observe event. The inspector reads
  // sessionBrowser.cdp live per enable, so it follows a crash-recovery rebind.
  const markStore = opts.markStore ?? new MarkStore();
  const resolveMark = async (backendNodeId: number): Promise<StructuredTarget | null> => {
    const ax = (await sessionBrowser.cdp.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
    const doc = (await sessionBrowser.cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
    return buildTarget(ax.nodes ?? [], doc.root, backendNodeId);
  };
  const inspector = createInspector({
    cdp: () => sessionBrowser.cdp,
    resolveMark,
    onMark: (target) => {
      const m = markStore.add(target);
      // trusted:false rides the event: role/name are page-derived (untrusted), like 2G vision.
      // During a login-handoff window the mark is dropped at source — a mark made on the credential
      // screen carries a displayed secret in its name and must never reach the agent (L-5e0-1).
      loginHandoff.enqueueContentEvent({ type: 'mark', markId: m.markId, role: target.role, name: target.name, trusted: false });
    },
  });
  const mark = async (): Promise<void> => {
    if (controlToken.holder !== 'human') {
      hub.broadcast(session.id, { t: 'error', reason: 'not_control_holder' });
      return;
    }
    await inspector.enable();
  };
  onMarkHandler = () => {
    void mark().catch((e) => logger.debug('inspect enable failed', { error: e instanceof Error ? e.message : String(e) }));
  };

  // Heal a stored mark against the CURRENT page (3b): re-resolve the structured target through
  // the cascade to a live snapshot ref — which the existing 2J resolver then takes to coords +
  // occlusion + dispatch (heal does mark→ref, the resolver does ref→action; no parallel resolver).
  // One AX⋈DOM fetch: buildSnapshot gives the candidate refs, buildTarget each candidate's locators.
  // Build the heal candidate set from ONE fresh AX⋈DOM fetch: buildSnapshot gives the candidate
  // refs, buildTargetFromFlat each candidate's locators off a single shared flatten+AX-index
  // (O(N), not O(K·N)). Shared by healMark (one mark) and the studio_marks handler (all marks).
  const buildHealCandidates = async (): Promise<Array<{ ref: string; target: StructuredTarget }>> => {
    const ax = (await sessionBrowser.cdp.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
    const doc = (await sessionBrowser.cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
    const snap = buildSnapshot(ax.nodes ?? [], doc.root, { tokenBudget: cfg.studioSnapshotTokenBudget });
    const flat = flattenDom(doc.root).map;
    const axByBe = indexAxByBackendNode(ax.nodes ?? []);
    const candidates: Array<{ ref: string; target: StructuredTarget }> = [];
    for (const [ref, backendNodeId] of snap.refMap) {
      const target = buildTargetFromFlat(flat, axByBe, backendNodeId);
      if (target) candidates.push({ ref, target });
    }
    return candidates;
  };
  const healMark = async (markId: string): Promise<HealResult | { error: 'no_such_mark' }> => {
    const m = markStore.get(markId);
    if (!m) return { error: 'no_such_mark' };
    return heal(m.target, await buildHealCandidates());
  };
  // studio_marks (3c): the agent reads each mark's page-derived descriptor (trusted:false) + its
  // CURRENT heal verdict against one fresh snapshot — confident marks carry a live ref to act on,
  // low/none ask. Healing all marks shares ONE candidate build.
  const marksView = async (): Promise<StudioMarksOutput> => {
    const all = markStore.list();
    if (all.length === 0) return { marks: [] };
    const candidates = await buildHealCandidates();
    return {
      marks: all.map((m) => {
        const h = heal(m.target, candidates);
        const view: StudioMarkView = {
          markId: m.markId,
          role: m.target.role,
          name: m.target.name,
          trusted: false,
          confidence: h.confidence,
        };
        if (h.ref) view.ref = h.ref;
        return view;
      }),
    };
  };
  // The viewport-relative bounding box of a live node (CSS px) for the generalize geometric
  // tiebreaker; null when the node has no box (display:none / detached) — applyGeometry keeps such
  // a structural match (not-rendered ≠ off-pattern; the human confirms).
  const boxForNode = async (backendNodeId: number): Promise<GenBox | null> => {
    try {
      const r = (await sessionBrowser.cdp.send('DOM.getBoxModel', { backendNodeId })) as { model?: { content?: number[] } };
      const q = r.model?.content;
      if (!q || q.length < 8) return null;
      const xs = [q[0], q[2], q[4], q[6]];
      const ys = [q[1], q[3], q[5], q[7]];
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
    } catch {
      return null;
    }
  };
  // studio_marks{op:'generalize'} (3d): preview the repeating sibling set the mark belongs to (a
  // list/grid the human marked one example of) so the agent can act across it AFTER a human
  // confirm. PREVIEW-ONLY (requires_confirmation:true) — never acts. The matched refs are the SAME
  // live refs the 2J resolver resolves at dispatch (one shared ref list, no parallel resolver).
  const generalizeMark = async (markId?: string): Promise<StudioGeneralizeOutput | StudioToolError> => {
    if (!markId) return { error_reason: 'missing_mark_id', hint: "op='generalize' needs a markId — read studio_marks for live ids." };
    const m = markStore.get(markId);
    if (!m) return { error_reason: 'no_such_mark', hint: 'That mark id is not in the current session. Re-read studio_marks for live ids.' };
    const structural = generalize(m.target, await buildHealCandidates());
    // Minimal geometric tiebreaker: box ONLY the structurally-matched set (bounded by the match
    // count, not the whole page) — a confirm-gated preview, not a hot path.
    const boxes = new Map<string, GenBox>();
    for (const match of structural.matches) {
      const box = await boxForNode(match.backendNodeId);
      if (box) boxes.set(match.ref, box);
    }
    const refined = applyGeometry(structural, boxes);
    return { markId, refs: refined.refs, confidence: refined.confidence, requires_confirmation: true };
  };
  // 5e-0: studio_marks is an UNGATED agent read whose marks carry page-derived role/name — a displayed
  // secret if a mark was made on the credential screen. When the live page is a credential context,
  // exclude all mark content (mirrors the observe/capture exclusion) via the shared isCredentialPage
  // probe defined above (the same host-side detection the 5e-a handoff uses). Nothing logged.
  // The studio_marks tool entry: list (default) or generalize a single mark. Thin dispatch only.
  const marksTool = async (input: StudioMarksInput): Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError> => {
    if (await isCredentialPage()) return { marks: [], credentialContext: true };
    return input.op === 'generalize' ? generalizeMark(input.markId) : marksView();
  };

  bridge = new ScreencastBridge({
    cdp: sessionBrowser.cdp,
    // Feed the forwarder the live page dimensions for input mapping, then fan the frame out.
    sink: (frame) => {
      forwarder.updateViewport(frame.metadata);
      hub.broadcastFrame(session.id, frame);
    },
    quality: cfg.studioScreencastQuality,
    maxWidth: cfg.studioScreencastMaxWidth,
    maxHeight: cfg.studioScreencastMaxHeight,
    everyNthFrame: cfg.studioScreencastEveryNthFrame,
    ackTimeoutMs: cfg.studioFrameAckTimeoutMs,
  });
  // On a browser-crash recovery, rebind the screencast + input channel to the FRESH
  // cdp (each resets its stale state); the control token persists. The nav interceptor
  // rebinds earlier, via onBeforeReNav above, so it is live before the recovery goto.
  sessionBrowser.onRecovered(() => {
    forwarder.rebind(sessionBrowser.cdp);
    void bridge!.restart(sessionBrowser.cdp).catch((e) =>
      logger.debug('screencast restart after recovery failed', { error: e instanceof Error ? e.message : String(e) }),
    );
  });
  // If bounded recovery is exhausted, tell connected clients the session died
  // instead of silently going dark.
  sessionBrowser.onFailed(() => hub.broadcast(session.id, { t: 'error', reason: 'session_failed' }));
  await bridge.start();

  // Wire studio_observe + studio_act to the live session and inject them into the
  // daemon's shared dispatcher BEFORE the handle is published — closing the self-loop
  // window (a studio_* call can't arrive, find the handle pointing at us, and proxy into
  // a loop before studioHost is set). snapshot() reads sessionBrowser.cdp live (survives recovery rebind).
  const observe = createObserver({
    snapshot: () => snapshotter.snapshot(sessionBrowser.cdp),
    eventQueue,
    inlineBudget: cfg.studioSnapshotTokenBudget,
    spillMaxBytes: STUDIO_SPILL_MAX_BYTES,
    dataDir: opts.dataDir,
    // 5e-0: the host-observed live page URL — the hard half of the credential-context perception
    // exclusion (the snapshot supplies the field half). A read failure degrades to undefined.
    currentUrl: () => {
      try {
        return sessionBrowser.page.url();
      } catch {
        return undefined;
      }
    },
    // 5e-a: the login_handoff signal rides each observe (in_progress while a login wall is being
    // handled → the agent waits; completed/failed on settle). Pulled fresh; carries only {state}.
    handoffSignal: () => loginHandoff.signal(),
  });
  // The agent's click/type resolve refs LIVE at action time through the 2J.1 resolver
  // (fresh snapshot per call + occlusion hit-test, never cached coords). Bind it to the
  // SESSION cdp via a thin live wrapper so it follows a crash-recovery rebind
  // (sessionBrowser.cdp is a getter that returns the current launched session's cdp).
  const resolve = createResolver({
    snapshot: () => snapshotter.snapshot(sessionBrowser.cdp),
    cdp: { send: (method, params) => sessionBrowser.cdp.send(method, params) },
  });
  // studio_act's gate + entry guard run HOST-SIDE here. The act handler reads the SAME
  // `grant` object the nav interceptor's policy provider reads, so the entry-URL verdict
  // and the per-hop verdict come from one source (agreement by construction). click/type/
  // scroll dispatch through the ONE token-gated input channel (the SessionController),
  // never action-executor.page.* or a raw CDP Input side-channel (those bypass the epoch
  // fence + held-input neutralization).
  // Phase 6b: the per-session append-only audit log. The act handler records every agent
  // action + its outcome here; the Phase-7 timeline replays it. In-memory now (Phase 4 owns persistence).
  const auditLog = new SessionAuditLog();
  // Phase 6c: the act handler classifies each click/type (deterministic) and HOLDS a risky one for
  // human approval before firing. currentUrl is the live page URL — the HARD signal the classifier
  // weights over the page-controlled element role/name; a read failure degrades to undefined (the
  // soft signal still applies). The gate composes with the epoch fence + logs every decision (6b).
  const act = createActHandler({
    browser: sessionBrowser,
    controlToken,
    grant,
    resolve,
    channel: controller,
    audit: auditLog,
    approvals,
    currentUrl: () => {
      try {
        return sessionBrowser.page.url();
      } catch {
        return undefined;
      }
    },
  });
  // Slice 5e-a: wrap (do NOT modify) the act handler so that after an agent action lands, the
  // host checks the post-act live page — if the agent drove onto a login wall, hand off to the
  // human. Only the page-changing verbs can surface a wall (scroll cannot), so afterAgentAct is
  // gated to them. The act handler itself is unchanged; this is pure orchestration around it.
  const actWithHandoff = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    const result = await act(input);
    if (input.action === 'navigate' || input.action === 'click' || input.action === 'type') {
      await loginHandoff.afterAgentAct();
    }
    return result;
  };

  // Phase 4c: the studio_capture handler — the agent persists a page clip to the cache as a
  // session artifact. Trusted-0 by construction (routes through captureFromPage); the session
  // id is bound HERE (server-side), never a caller field. The cache db is resolved LAZILY at
  // capture time: getDatabase() throws until initDatabase() has run, and a capture only arrives
  // once the session + cache are live — eager resolution at wiring would break host boot.
  daemon.setStudioHost({
    observe,
    act: actWithHandoff,
    marks: marksTool,
    capture: (input) => createCaptureHandler({
      sessionId: session.id,
      db: getDatabase(),
      // Slice 5b: source the credential-context signal FRESH per capture — a live snapshot's fields
      // (the same domByRef the 5a guard reads, so capture and field-scan agree by construction) + the
      // host-observed live page url. A credential context (login URL OR a credential field present)
      // excludes the capture entirely.
      credentialContext: async () => {
        const snap = await snapshotter.snapshot(sessionBrowser.cdp);
        let pageUrl: string | undefined;
        try {
          pageUrl = sessionBrowser.page.url();
        } catch {
          /* browser not started / mid-recovery — url unknown; the field signal still applies */
        }
        return { pageUrl, fields: [...(snap.domByRef?.values() ?? [])] };
      },
    })(input),
  });

  const handle: SessionHandle = { id: session.id, endpoint, token, pid: process.pid, instanceId };
  writeHandle(handle, opts.dataDir);

  return { daemon, registry, session, sessionBrowser, bridge, controller, navInterceptor, navigate, mark, marks: () => markStore.list(), healMark, marksView, generalizeMark, marksTool, observe, act: actWithHandoff, audit: auditLog, approvals, grantAgentPrivateNav, handoff: loginHandoff, hub, handle, endpoint };
}

export function runStudio(args: string[]): void {
  const parsed = parseStudioArgs(args);
  log(`Starting studio host on ${parsed.host}:${parsed.port}…`);

  startStudioHost(parsed)
    .then((host) => {
      log(`Studio host running at ${host.endpoint} (session ${host.session.id})`);
      log(`Session handle: ${studioHandlePath()}`);
      log('Press Ctrl+C to stop.');

      const shutdown = async () => {
        log('Shutting down studio host…');
        removeHandle();
        host.hub.closeAll();
        await host.bridge.stop().catch((e) =>
          logger.debug('screencast stop failed', { error: e instanceof Error ? e.message : String(e) }),
        );
        await host.navInterceptor.stop().catch((e) =>
          logger.debug('nav interceptor stop failed', { error: e instanceof Error ? e.message : String(e) }),
        );
        await host.sessionBrowser.close().catch((e) =>
          logger.debug('session browser close failed', { error: e instanceof Error ? e.message : String(e) }),
        );
        host.registry.closeAll();
        try {
          await host.daemon.stop();
        } catch (err) {
          log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
        }
        await closeDaemonBrowser().catch((e) =>
          logger.debug('closeDaemonBrowser failed', { error: e instanceof Error ? e.message : String(e) }),
        );
        process.exit(0);
      };

      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    })
    .catch((err) => {
      log(`Failed to start studio host: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
