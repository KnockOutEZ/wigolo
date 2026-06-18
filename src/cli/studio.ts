import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { DaemonHttpServer } from '../daemon/http-server.js';
import { getEmbedProvider } from '../providers/embed-provider.js';
import { checkBindHost } from '../studio/bind.js';
import { resolveHostToken } from '../studio/auth.js';
import { SessionRegistry } from '../studio/registry.js';
import type { Session } from '../studio/session.js';
import { SessionBrowser, type SessionBrowserLauncher } from '../studio/session-browser.js';
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
import { createInspector } from '../studio/mark/inspect.js';
import { MarkStore, type StudioMark } from '../studio/mark/store.js';
import { buildTarget, buildTargetFromFlat, indexAxByBackendNode, type StructuredTarget } from '../studio/mark/target.js';
import { heal, type HealResult } from '../studio/mark/heal.js';
import type {
  StudioObserveInput,
  StudioObserveOutput,
  StudioActInput,
  StudioActOutput,
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
  /** The agent's observe verb (studio_observe) — host-authoritative snapshot + event drain. Exposed for the host-boundary/headed tests. */
  observe: (input: StudioObserveInput) => Promise<StudioObserveOutput | StudioToolError>;
  /** The agent's acting verb (studio_act) — gate + live ref-resolve + the token-gated input channel, host-authoritative. Exposed for the host-boundary tests. */
  act: (input: StudioActInput) => Promise<StudioActOutput | StudioToolError>;
  /** Human-only, per-session, revocable: lift the agent's localhost/RFC1918 nav block (cloud-metadata stays blocked). */
  grantAgentPrivateNav: (on: boolean) => void;
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
  let onNavHandler: ((msg: Record<string, unknown>) => void) | undefined;
  let onMarkHandler: ((msg: Record<string, unknown>) => void) | undefined;
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
    },
    onAck: () => bridge?.onClientAck(),
    onInput: (_id, msg) => {
      void controller?.handleWireInput(msg);
    },
    onControl: (_id, msg) => controller?.handleWireControl(msg),
    onNav: (_id, msg) => onNavHandler?.(msg),
    onMark: (_id, msg) => onMarkHandler?.(msg),
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

  // Warm the embedding model BEFORE the host accepts connections.
  // getEmbedProvider() constructs AND warms the provider (one-time ONNX/tokenizer
  // load) before it resolves, so awaiting it here pays that cost up front — never
  // lazily mid-session where it would stall a live screencast.
  log('warming embedding model…');
  await getEmbedProvider();

  const endpoint = await daemon.start();

  const session = registry.create({ endpoint, token });

  // Bring up the session's dedicated headed browser, then the screencast bridge,
  // before publishing the handle — so the session is fully live (streamable) by
  // the time a client can discover it.
  const sessionBrowser = new SessionBrowser({ sessionId: session.id, launch: opts.browserLauncher });
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
    if (s.holder === 'human') void navInterceptor.abortInFlight();
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
    if (r.ok) eventQueue.enqueue({ type: 'navigation', url }); // human nav → the agent learns of it via studio_observe
    else hub.broadcast(session.id, { t: 'error', reason: r.reason });
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
  const markStore = new MarkStore();
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
      eventQueue.enqueue({ type: 'mark', markId: m.markId, role: target.role, name: target.name, trusted: false });
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
  const healMark = async (markId: string): Promise<HealResult | { error: 'no_such_mark' }> => {
    const m = markStore.get(markId);
    if (!m) return { error: 'no_such_mark' };
    const ax = (await sessionBrowser.cdp.send('Accessibility.getFullAXTree')) as { nodes?: AxNode[] };
    const doc = (await sessionBrowser.cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root?: DomNode };
    const snap = buildSnapshot(ax.nodes ?? [], doc.root, { tokenBudget: cfg.studioSnapshotTokenBudget });
    // Flatten the DOM + index the AX tree ONCE, then build each candidate from the shared maps —
    // O(N), not the O(K·N) that re-flattening per candidate would cost on a many-element page.
    const flat = flattenDom(doc.root).map;
    const axByBe = indexAxByBackendNode(ax.nodes ?? []);
    const candidates: Array<{ ref: string; target: StructuredTarget }> = [];
    for (const [ref, backendNodeId] of snap.refMap) {
      const target = buildTargetFromFlat(flat, axByBe, backendNodeId);
      if (target) candidates.push({ ref, target });
    }
    return heal(m.target, candidates);
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
  const act = createActHandler({ browser: sessionBrowser, controlToken, grant, resolve, channel: controller });
  daemon.setStudioHost({ observe, act });

  const handle: SessionHandle = { id: session.id, endpoint, token, pid: process.pid, instanceId };
  writeHandle(handle, opts.dataDir);

  return { daemon, registry, session, sessionBrowser, bridge, controller, navInterceptor, navigate, mark, marks: () => markStore.list(), healMark, observe, act, grantAgentPrivateNav, hub, handle, endpoint };
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
