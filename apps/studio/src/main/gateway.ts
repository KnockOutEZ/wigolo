import { randomUUID } from 'node:crypto';
import {
  DaemonHttpServer,
  resolveHostToken,
  writeHandle,
  removeHandle,
  setMyInstanceId,
  type StudioHostHandlers,
  type StudioSessionsAccessor,
  type DaemonOptions,
  type SessionHandle,
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

  const opts: DaemonOptions = { port, host, auth: { token, host } };
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
