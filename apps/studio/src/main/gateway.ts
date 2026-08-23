import { randomUUID } from 'node:crypto';
import {
  DaemonHttpServer,
  createStudioMcpServer,
  resolveHostToken,
  writeHandle,
  removeHandle,
  setMyInstanceId,
  type StudioHostHandlers,
  type StudioSessionsAccessor,
  type DaemonOptions,
  type SessionHandle,
  type RunsStore,
} from 'wigolo/studio';

// The agent gateway: the salvaged loopback MCP server (DaemonHttpServer) embedded IN the Electron
// main process (spec §2/§7). It binds loopback-only with a per-launch bearer + Origin/Host guard,
// hosts the 10 core tools + the studio_* surface over HTTP, and injects the Electron-backed
// StudioHostHandlers + StudioSessionsAccessor. Discovery is the 0600 handle file — written LAST, so
// an agent can never reach the endpoint before the host handlers are wired.

const LOOPBACK = '127.0.0.1';

/** The subset of DaemonHttpServer the gateway drives — injectable so the boot ordering is unit-testable. */
export interface GatewayDaemon {
  start(): Promise<string>;
  stop(): Promise<void>;
  setStudioHost(handlers: StudioHostHandlers): void;
  setStudioSessions(accessor: StudioSessionsAccessor): void;
}

export interface GatewayDeps {
  host: StudioHostHandlers;
  sessions: StudioSessionsAccessor;
  /** The published session id (the handle's `id`). */
  sessionId: string;
  /**
   * The broker-backed run store (SD1 §6 / A-43-5). While the app runs it is the one live store
   * owner, and this is what lets `/v1/runs*` serve instead of answering `503 store_unavailable`.
   * Omitting it is a deliberate, visible degradation, not a silent one — the surface refuses.
   */
  runStore?: RunsStore;
  dataDir?: string;
  /** Operator-supplied stable token; when absent a per-launch token is minted. */
  configuredToken?: string | null;
  bindHost?: string;
  port?: number;
  /** Injectable for tests; production builds a real DaemonHttpServer. */
  makeDaemon?: (opts: DaemonOptions) => GatewayDaemon;
}

export interface Gateway {
  endpoint: string;
  token: string;
  instanceId: string;
  stop(): Promise<void>;
}

export async function startGateway(deps: GatewayDeps): Promise<Gateway> {
  const host = deps.bindHost ?? LOOPBACK;
  const port = deps.port ?? 0;
  const { token } = resolveHostToken(deps.configuredToken);

  // Publish an instance id BEFORE the handle so the stdio-side self-reference guard keys on it
  // (a collision-resistant UUID, not a reusable pid).
  const instanceId = randomUUID();
  setMyInstanceId(instanceId);

  // STUDIO-ONLY gateway: the embedded server hosts just the studio_* surface via this factory, so it
  // never loads the core subsystems' native cache DB (which can't run in the Electron main — spec §13.7).
  //
  // `runStore` is the one exception to that, and does not breach it: the store is REACHED from here,
  // not LOADED here — the native handle stays in the broker child and this is an async port over it.
  //
  // ONE auth story: the per-launch handle token is the gateway's ONLY credential. `auth` is the gate
  // that owns the decision (it runs first, on every route, and it is the token published in the 0600
  // handle); `apiToken` hands the embedded REST router that SAME token so `/v1/runs*` keys on one
  // predicate instead of a second one. Stating it here is not redundant — left unset, the router
  // would resolve `WIGOLO_API_TOKEN` from the Electron main's environment, and an operator who has
  // that exported would find NO credential passes both gates (sd-87).
  const opts: DaemonOptions = {
    port,
    host,
    auth: { token, host },
    apiToken: token,
    mcpServerFactory: () => createStudioMcpServer({ studioHost: deps.host, sessions: deps.sessions, dataDir: deps.dataDir }),
    ...(deps.runStore ? { runStore: deps.runStore } : {}),
  };
  const daemon: GatewayDaemon = deps.makeDaemon ? deps.makeDaemon(opts) : new DaemonHttpServer(opts);

  const endpoint = await daemon.start();
  // Inject the Electron-backed host AFTER start() (back-fills subsystems) but BEFORE the handle is
  // published — closes the window where a studio_* call could arrive with the host unset.
  daemon.setStudioHost(deps.host);
  daemon.setStudioSessions(deps.sessions);

  const handle: SessionHandle = { id: deps.sessionId, endpoint, token, pid: process.pid, instanceId };
  writeHandle(handle, deps.dataDir);

  return {
    endpoint,
    token,
    instanceId,
    async stop(): Promise<void> {
      removeHandle(deps.dataDir);
      await daemon.stop();
      setMyInstanceId(null);
    },
  };
}
