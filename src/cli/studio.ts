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
import { StudioWsHub } from '../studio/ws-hub.js';
import { writeHandle, removeHandle, studioHandlePath, type SessionHandle } from '../studio/handle.js';
import { closeDaemonBrowser } from '../fetch/playwright-tier.js';

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

  const registry = opts.registry ?? new SessionRegistry();
  // Late-bound: the screencast bridge is created once the session browser is up,
  // but the hub (which routes client frame-acks to it) must exist before the daemon.
  // Late-bound: bridge + controller are created once the session browser is up,
  // but the hub (which routes client ack/input/control to them) precedes the daemon.
  let bridge: ScreencastBridge | undefined;
  let controller: SessionController | undefined;
  // The WS hub fans frames/input over the host's WebSocket; the daemon authorizes
  // each upgrade (Origin/Host + subprotocol bearer) before handing it here. WS
  // clients are session viewers, so onAttach/onDetach keep the Session's client
  // count accurate (it backs idle-eviction) for connect AND every disconnect
  // (graceful close, error, or heartbeat reap); onAck paces the screencast;
  // onInput/onControl drive the token-gated input channel (WS = the human party).
  const hub = new StudioWsHub({
    onAttach: (id) => registry.get(id)?.attach(),
    onDetach: (id) => registry.get(id)?.detach(),
    onAck: () => bridge?.onClientAck(),
    onInput: (_id, msg) => {
      void controller?.handleWireInput(msg);
    },
    onControl: (_id, msg) => controller?.handleWireControl(msg),
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
  // On a browser-crash recovery, rebind BOTH the screencast and the input channel
  // to the FRESH cdp (each resets its stale state); the control token persists.
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

  const handle: SessionHandle = { id: session.id, endpoint, token, pid: process.pid };
  writeHandle(handle, opts.dataDir);

  return { daemon, registry, session, sessionBrowser, bridge, controller, hub, handle, endpoint };
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
