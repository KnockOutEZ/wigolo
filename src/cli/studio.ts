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
import { NavEpoch } from '../studio/nav-epoch.js';
import { createActHandler } from '../studio/act.js';
import { createCaptureHandler } from '../studio/capture/handler.js';
import { getDatabase } from '../cache/db.js';
import { captureHumanNote } from '../studio/capture/artifacts.js';
import { SessionAuditLog, type AuditDb, type AuditEntry } from '../studio/audit.js';
import { SessionApprovals } from '../studio/approvals.js';
import { createInspector } from '../studio/mark/inspect.js';
import { MarkStore, type StudioMark } from '../studio/mark/store.js';
import { isCredentialContext } from '../studio/credential.js';
import { LoginHandoff } from '../studio/handoff.js';
import { createLoginCapture, type OriginMismatch } from '../studio/login-capture.js';
import { UNTRUSTED_STUDIO_NOTICE } from '../security/untrusted.js';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { NonceStore } from '../studio/nonce.js';

/**
 * The built Studio web-app shell dir the daemon serves (S1). Resolved relative to THIS module so it points
 * at the package's `dist/webapp` from both the built CLI (`dist/cli/studio.js`) and the dev entry
 * (`src/cli/studio.ts`) — both are two levels under the package root. Absent in a not-yet-built dev tree;
 * the static route then simply 404s its assets (non-fatal — the studio command is internal/unadvertised).
 */
const STUDIO_WEBAPP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'webapp');

/** Bounded human-event buffer; overflow is fail-loud (drained events surface a dropped count → resync). */
const STUDIO_EVENT_QUEUE_MAX = 256;
/** Total byte budget the spill-dir GC enforces (snapshots + diffs + vision PNGs). In-code, not operator-tunable. */
const STUDIO_SPILL_MAX_BYTES = 64 * 1024 * 1024;
/**
 * 7d S3 / decision #8: the post-hello audit backfill caps to the most-recent N entries. A connecting client
 * hydrates its timeline from the last 200 recorded actions; older history + "load more" is deferred to 7f.
 * Live deltas (the S2 {t:'audit'} feed) remain unbounded.
 */
const AUDIT_SNAPSHOT_CAP = 200;

const logger = createLogger('cli');

function log(msg: string): void {
  process.stderr.write(`[wigolo studio] ${msg}\n`);
}

export interface StudioArgs {
  port: number;
  host: string;
  allowRemote: boolean;
  /** Slice D2/A: opt into a named profile via `--profile <id>` — loads + persists its authenticated storageState across launches. */
  profileId?: string;
  /** Slice D2/A: the origin the named profile is bound to (`--profile-origin <origin>`). MANDATORY whenever profileId is set — a login completing on any OTHER origin is refused (confused-deputy guard). */
  profileOrigin?: string;
}

export function parseStudioArgs(args: string[]): StudioArgs {
  const config = getConfig();
  let port = config.daemonPort;
  let host = config.daemonHost;
  let allowRemote = false;
  let profileId: string | undefined;
  let profileOrigin: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10);
      if (!isNaN(parsed)) port = parsed;
      i++;
    } else if (args[i] === '--host' && i + 1 < args.length) {
      host = args[i + 1];
      i++;
    } else if (args[i] === '--profile' && i + 1 < args.length) {
      profileId = args[i + 1];
      i++;
    } else if (args[i] === '--profile-origin' && i + 1 < args.length) {
      profileOrigin = args[i + 1];
      i++;
    } else if (args[i] === '--allow-remote') {
      allowRemote = true;
    }
  }

  return { port, host, allowRemote, profileId, profileOrigin };
}

export interface StudioHostOptions extends StudioArgs {
  /** Override the data dir for the session handle (tests). Defaults to config. */
  dataDir?: string;
  /** Inject a registry (tests). Defaults to a fresh in-memory registry. */
  registry?: SessionRegistry;
  /** Inject the session-browser launcher (tests). Defaults to the real Playwright launcher. */
  browserLauncher?: SessionBrowserLauncher;
  /** Inject the profile store (tests). Defaults to the keychain-backed ProfileStore. Only consulted when profileId is set. */
  profileStore?: ProfileStore;
  /** Inject the mark store (tests). Defaults to a fresh in-memory MarkStore. */
  markStore?: MarkStore;
  /** 5e-c: host-level surface for a login-profile PERSIST failure on completion. Defaults to a host log. The
   *  live session is authenticated + re-granted regardless (persist = future reuse); this keeps the failure
   *  visible without propagating it as an unhandled rejection. Receives the error only — never any storageState. */
  onLoginPersistError?: (err: unknown) => void;
  /** 5eb1: host-level surface for a profile↔origin binding MISMATCH (refuse-persist). Defaults to a host log.
   *  Receives origins/profileId only — never any storageState/cookie. */
  onLoginOriginMismatch?: (info: OriginMismatch) => void;
  /** Inject the nonce store (tests). Defaults to a fresh store; backs the S2 token handshake. */
  nonceStore?: NonceStore;
  /** Open the web-app tab at the given (nonce-bearing, token-FREE) URL. Defaults to logging the URL (safe
   *  for non-interactive/test boots); the CLI entry passes a real spawning opener. */
  openTab?: (url: string) => void;
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
  /** The mark sink the inspector invokes when a human pick resolves (7c S3): dual-emit — enqueue the agent content event AND broadcast the live {t:'mark'} human delta. Exposed for tests to drive the real action site without live CDP. */
  onMarkResolved: (target: StructuredTarget) => void;
  /** The human's marked structured targets (in-memory; Phase-4 persists). Exposed for the host-boundary/headed tests + the Phase-3c studio_marks tool. */
  marks: () => StudioMark[];
  /** Re-resolve a stored mark against the CURRENT page via the heal cascade (mark→live ref). Exposed for the headed tests + the Phase-3c studio_marks tool. */
  healMark: (markId: string) => Promise<HealResult | { error: 'no_such_mark' }>;
  /** The studio_marks list view: each mark's descriptor + current heal verdict + a live ref for the actionable ones. Exposed for the headed tests. */
  marksView: () => Promise<StudioMarksOutput>;
  /** The post-hello marks backfill payload (7c S2): {t:'marks_snapshot', marks} reusing marksView so confidence is the SAME heal-computed value as studio_marks. Wired into the hub's per-connecting-client postHello. Exposed for tests. */
  marksSnapshot: () => Promise<{ t: 'marks_snapshot'; marks: StudioMarkView[] }>;
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
  /** The web-app tab URL opened on launch — carries the one-time nonce, NEVER the bearer. */
  webappUrl: string;
  /** The nonce store backing the S2 token handshake (exposed for the host-boundary tests). */
  nonceStore: NonceStore;
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

  // Slice D2/B: resolve the named-profile binding BEFORE any launch (M2 — declare-on-first-use, then durable).
  // The boundOrigin is read from the persisted profile envelope: a declared --profile-origin that DISAGREES is
  // a rebind attempt (refused, no silent rebind); an omitted one uses the persisted binding; a first use MUST
  // declare; a profile that won't decode fails closed (refuse to start — never silently unbound).
  let profileBinding: { store: ProfileStore; profileId: string; boundOrigin: string } | undefined;
  if (opts.profileId) {
    const store = opts.profileStore ?? new ProfileStore();
    const existing = await store.get(opts.profileId);
    if (existing.ok) {
      if (opts.profileOrigin && opts.profileOrigin !== existing.boundOrigin) {
        throw new Error(
          `studio profile '${opts.profileId}' is bound to ${existing.boundOrigin}; refusing to rebind to ${opts.profileOrigin} (omit --profile-origin to use the existing binding).`,
        );
      }
      profileBinding = { store, profileId: opts.profileId, boundOrigin: existing.boundOrigin };
    } else if (existing.reason === 'malformed') {
      log(
        `WARNING: studio profile '${opts.profileId}' is unreadable (corrupt or unrecognized format); refusing to start. Re-declare --profile-origin and log in again to re-establish it.`,
      );
      throw new Error(`studio profile '${opts.profileId}' is unreadable; refusing to start on a malformed profile.`);
    } else {
      if (!opts.profileOrigin) {
        throw new Error(
          `studio profile '${opts.profileId}' requires --profile-origin (the origin the profile is bound to); refusing to start an unbound named profile.`,
        );
      }
      profileBinding = { store, profileId: opts.profileId, boundOrigin: opts.profileOrigin };
    }
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
  let onCommentHandler: ((msg: Record<string, unknown>) => void) | undefined;
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
    // The human's comment/annotation ({t:'comment', text}). The WS is the human channel, so the comment is
    // human-authored → captured trusted=1 (the agent's MCP capture path can never reach this writer).
    onComment: (_id, msg) => onCommentHandler?.(msg),
    // Tell a connecting client the current {holder, epoch} so it stamps valid input
    // even if it joins after a flip (defaults before the controller exists).
    helloExtras: () => controller?.controlSnapshot() ?? { holder: 'human', epoch: 0 },
    // 7c S2 + 7d S3: backfill a connecting human client with this session's read state (own messages, after
    // hello): the marks already stored, then the audit timeline (most-recent N). Both `marksSnapshot` and
    // `auditSnapshot` are defined below; the closure defers the calls until a client connects.
    postHello: async () => [await marksSnapshot(), auditSnapshot()],
  });
  // S2: the nonce store backs the one-time bearer handshake. A nonce is minted per launch and passed in the
  // tab URL; the page redeems it (POST /studio/token) for the bearer, which then rides the WS subprotocol —
  // so the bearer never touches a URL/query.
  const nonceStore = opts.nonceStore ?? new NonceStore();
  const handshakeNonce = nonceStore.mint();
  const daemon = new DaemonHttpServer({
    port: opts.port,
    host: opts.host,
    auth: { token, host: opts.host },
    requestTimeoutMs: getConfig().studioRequestTimeoutMs,
    onUpgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head),
    webappRoot: STUDIO_WEBAPP_ROOT,
    nonceStore,
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

  // Open the web-app tab at the shell, carrying the one-time NONCE (never the bearer) + the session id in
  // the URL. Default opener just logs the URL (safe for non-interactive/test boots); the CLI entry passes a
  // spawning opener.
  const webappUrl = `${endpoint}/?n=${handshakeNonce}&s=${session.id}`;
  (opts.openTab ?? ((u: string) => logger.info('Studio web app ready', { url: u })))(webappUrl);

  // Bring up the session's dedicated headed browser, then the screencast bridge,
  // before publishing the handle — so the session is fully live (streamable) by
  // the time a client can discover it.
  // Slice 5d: when the session opts into a named profile, resolve its storageState FRESH per launch
  // (start + crash recovery) via the 5c store. profile_absent (opted-in but not-yet-persisted) ⇒
  // undefined ⇒ a clean session (5e's first login persists it). No profile content is logged.
  let loadProfile: (() => Promise<StorageStateInput>) | undefined;
  // Slice 5e-b: when a named profile is opted in, the login-handoff onComplete captures the
  // authenticated session — origin-scoped to the wall origin — and persists it to that profile.
  // Unset (a clean session) ⇒ undefined ⇒ the handoff completes but persists nothing (nowhere to).
  let onLoginComplete: ReturnType<typeof createLoginCapture> | undefined;
  if (profileBinding) {
    const { store: profileStore, profileId, boundOrigin } = profileBinding;
    // Slice D2/A (R5): a loaded authenticated profile means live credentials sit in a browser the agent
    // co-drives. Warn the operator at launch (P6-d parity — `[wigolo studio] WARNING: …` + 2-space-indented
    // continuation). The bound origin is the resolved binding (declared on first use, else read from the
    // persisted profile — D2/B/M2).
    log(`WARNING: authenticated profile '${profileId}' is loaded — live credentials are present in a browser session co-driven by the agent.`);
    log(`  The agent can act within the authenticated origin (${boundOrigin}).`);
    loadProfile = async (): Promise<StorageStateInput> => {
      const r = await profileStore.get(profileId);
      return r.ok ? (JSON.parse(r.storageState) as StorageStateInput) : undefined;
    };
    const capture = createLoginCapture({
      profilePersist: profileStore,
      profileId,
      // D2/B: bind to the resolved boundOrigin (declared on first use, else the persisted binding); a login
      // completing elsewhere is refused (never persisting Y's creds under profile X). The mismatch surface
      // carries origins/profileId only — never any storageState (mirrors the persist-error contract).
      expectedOrigin: boundOrigin,
      onOriginMismatch:
        opts.onLoginOriginMismatch ??
        ((info: OriginMismatch) =>
          logger.warn('login profile origin mismatch; persist refused', {
            profileId: info.profileId,
            expectedOrigin: info.expectedOrigin,
            completedOrigin: info.completedOrigin,
          })),
    });
    // 5e-c closeout (L-5c-2): the completing re-grant fires regardless of the persist (in settleCompleted's
    // `finally`), so a persist FAILURE must not propagate out of onComplete — both checkCompletion callers
    // (the bounded poll + the human-nav handler) invoke it as a fire-and-forget `void`, where a rejection
    // would be an unhandled rejection / host crash. Catch at this host boundary and surface it (NO storageState
    // is passed to the surface — the error only), so the failure is visible but the agent still resumes.
    const surfacePersistError =
      opts.onLoginPersistError ??
      ((err: unknown) => logger.warn('login profile persist failed; session re-granted regardless', { error: err instanceof Error ? err.message : String(err) }));
    onLoginComplete = async (ctx) => {
      try {
        await capture(ctx);
      } catch (err) {
        surfacePersistError(err);
      }
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

  // 7b-notes S1: the human comment/annotation sink. A {t:'comment', text} the human pushes over the WS is
  // human-authored, so it persists via captureHumanNote — the SOLE content_trusted=1 writer (the agent's
  // studio_capture path is hardcoded trusted=0 and can never reach this). Server-authoritative: the echo
  // broadcasts ONLY AFTER a successful capture, so a comment the human sees is ALWAYS a captured comment — a
  // failed cache write surfaces as no echo (logged), never an optimistic phantom. The db is resolved lazily
  // (getDatabase() throws until the cache is up); a throw is caught here and yields no echo.
  onCommentHandler = (msg) => {
    const text = msg.text;
    if (typeof text !== 'string' || text.trim() === '') return; // ignore empty/garbage; never throw on client input
    try {
      const result = captureHumanNote({ sessionId: session.id, text }, { db: getDatabase() });
      hub.broadcast(session.id, { t: 'comment', id: result.id, text, trusted: true });
    } catch (e) {
      logger.debug('comment capture failed — no echo', { error: e instanceof Error ? e.message : String(e) });
    }
  };

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
  // D4/A: the per-session nav-epoch — bumped on every allowed Document hop (below), refreshed on each
  // studio_observe page-read, and re-checked by studio_capture (D4/B) to refuse a capture against a page
  // the agent has navigated away from since its last observe.
  const navEpoch = new NavEpoch();
  const navInterceptor = new NavInterceptor(
    () => policyForHolder(controlToken.holder, grant),
    () => navEpoch.bumpNavigation(),
  );
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
    // 5e-b: capture + origin-scoped persist to the opted-in named profile (undefined ⇒ a clean
    // session with no profile to persist to ⇒ no-op). 5e-c will re-grant + resume the authenticated
    // session. Fired ONLY on a detected completion (the 5e-a AND-gate), never on abort/vanish.
    onComplete: onLoginComplete,
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
  // The HUMAN live-delta half of the mark sink (7c S3): broadcast a {t:'mark', StudioMarkView} to the
  // connected read surface. Reuses healMark (the SAME heal cascade as marksView) so the delta confidence is
  // the value the agent reads via studio_marks — no parallel heal. healMark is declared below; the closure
  // resolves it at call time (a mark only lands well after startup).
  const emitMarkDelta = async (markId: string): Promise<void> => {
    const stored = markStore.get(markId);
    if (!stored) return;
    const h = await healMark(markId);
    const view: StudioMarkView = {
      markId,
      role: stored.target.role,
      name: stored.target.name,
      trusted: false,
      confidence: 'confidence' in h ? h.confidence : 'none',
    };
    if ('ref' in h && h.ref) view.ref = h.ref;
    hub.broadcast(session.id, { t: 'mark', ...view });
  };
  // The mark sink: the function the inspector invokes when a human pick resolves to a target. DUAL-emit —
  // (1) the AGENT path: enqueue a content event, dropped at source during a login-handoff window (a
  // credential-screen mark name can be a displayed secret, L-5e0-1); (2) the HUMAN path (7c S3): a live delta
  // that BYPASSES the handoff suppression (the human must always see their own mark) — an unconditional
  // broadcast, NOT routed through loginHandoff.
  const onMarkResolved = (target: StructuredTarget): void => {
    const m = markStore.add(target);
    // trusted:false rides the event: role/name are page-derived (untrusted), like 2G vision.
    loginHandoff.enqueueContentEvent({ type: 'mark', markId: m.markId, role: target.role, name: target.name, trusted: false });
    void emitMarkDelta(m.markId);
  };
  const inspector = createInspector({
    cdp: () => sessionBrowser.cdp,
    resolveMark,
    onMark: onMarkResolved,
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
    if (all.length === 0) return { marks: [], untrusted_notice: UNTRUSTED_STUDIO_NOTICE };
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
      // P6-a: the marks' page-derived role/name are untrusted data — carry the instruction-channel statement.
      untrusted_notice: UNTRUSTED_STUDIO_NOTICE,
    };
  };
  // The post-hello marks backfill (7c S2): a CONNECTING human client hydrates its read surface from the
  // marks already stored this session. REUSES marksView so the snapshot confidence is the SAME heal-computed
  // value the agent reads via studio_marks (no parallel heal). Carries only the marks array — the
  // untrusted-data instruction-channel notice is an agent-channel concern; the human read surface (S4)
  // renders every page-derived string inert via SafeText. Credential-context exclusion rides marksView too.
  const marksSnapshot = async (): Promise<{ t: 'marks_snapshot'; marks: StudioMarkView[] }> => {
    const view = await marksView();
    return { t: 'marks_snapshot', marks: view.marks };
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
    if (await isCredentialPage()) return { marks: [], credentialContext: true, untrusted_notice: UNTRUSTED_STUDIO_NOTICE };
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
    // D4/A: refresh lastObserveEpoch on each real page-read so studio_capture can detect a nav since.
    markObserved: () => navEpoch.markObserved(),
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
  // Phase 6b persistence: durably record the audit trail. getDatabase() throws until initDatabase()
  // has run (the daemon does so before sessions exist); guard so the unit harness — which builds a
  // host without a DB — falls back to the in-memory log cleanly (mirrors the lazy-db capture pattern).
  let auditDb: AuditDb | undefined;
  try {
    auditDb = getDatabase();
  } catch {
    // Degraded state: no DB means the audit trail can only live in memory. Surface it (no
    // silent failure) so an operator running a host without an initialized DB knows the trail
    // won't persist. Prod inits the DB before sessions exist, so this never fires there.
    auditDb = undefined;
    log("WARNING: audit trail persistence unavailable (database not initialized) — falling back to an in-memory log; this session's audit trail will NOT survive a restart.");
  }
  const auditLog = new SessionAuditLog(auditDb ? { db: auditDb, sessionId: session.id } : {});
  // 7d S2: a live audit delta. Each recorded agent action (the single act-handler choke point) fans out to
  // the connected human client(s) as {t:'audit', <entry>} — the Phase-7 timeline's live half (S3 adds the
  // post-hello backfill). The frozen entry is broadcast verbatim; the human read surface renders it inert.
  auditLog.onRecord((entry) => hub.broadcast(session.id, { t: 'audit', ...entry }));
  // 7d S3: the post-hello audit backfill — a connecting human client hydrates its timeline from the
  // most-recent AUDIT_SNAPSHOT_CAP recorded actions (decision #8). replay() hands out the frozen entries in
  // append order; slice(-N) keeps the tail (the most recent), so a fresh client sees the latest history.
  const auditSnapshot = (): { t: 'audit_snapshot'; entries: AuditEntry[] } => ({
    t: 'audit_snapshot',
    entries: auditLog.replay().slice(-AUDIT_SNAPSHOT_CAP),
  });
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
      // Slice D4/B: the server-tracked nav-epoch getters — studio_capture refuses a capture against a page the
      // agent navigated away from since its last observe (current !== lastObserve). No agent-supplied epoch.
      currentNavEpoch: () => navEpoch.current,
      lastObserveEpoch: () => navEpoch.lastObserve,
    })(input),
  });

  const handle: SessionHandle = { id: session.id, endpoint, token, pid: process.pid, instanceId };
  writeHandle(handle, opts.dataDir);

  return { daemon, registry, session, sessionBrowser, bridge, controller, navInterceptor, navigate, mark, onMarkResolved, marks: () => markStore.list(), healMark, marksView, marksSnapshot, generalizeMark, marksTool, observe, act: actWithHandoff, audit: auditLog, approvals, grantAgentPrivateNav, handoff: loginHandoff, hub, handle, endpoint, webappUrl, nonceStore };
}

/** Open the web-app tab in the platform browser; the logged URL is the fallback if no opener is present. */
function openStudioTab(url: string): void {
  log(`Studio web app: ${url}`);
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const cmdArgs = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no opener available — the logged URL is the fallback */ });
    child.unref();
  } catch {
    /* non-fatal — the human can open the logged URL manually */
  }
}

export function runStudio(args: string[]): void {
  const parsed = parseStudioArgs(args);
  log(`Starting studio host on ${parsed.host}:${parsed.port}…`);

  startStudioHost({ ...parsed, openTab: openStudioTab })
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
