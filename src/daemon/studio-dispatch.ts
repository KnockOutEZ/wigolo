/**
 * The execute-vs-proxy-vs-refuse seam every `studio_*` tool routes through. It runs
 * in BOTH processes from one shared `createMcpServer` dispatcher:
 *
 *   - on the HOST, `subsystems.studioHost` is set → EXECUTE against the live session;
 *   - on the user's STDIO server it is unset → route by the published handle:
 *       · a FOREIGN live host (handle.instanceId ≠ mine) → PROXY (pass the host's
 *         result back VERBATIM — no field-dropping reconstruction, so `trusted:false`
 *         and every other tag survive the round-trip);
 *       · the handle points at ME (instanceId === mine) → REFUSE-SELF (defense-in-depth
 *         for the wiring window; unreachable in practice once setStudioHost precedes
 *         handle-publish, which is exactly why the test asserting it earns its keep);
 *       · no handle, or the host endpoint is dead → REFUSE no-reachable-host (fail
 *         loud, never hang).
 *
 * Identity is a collision-resistant instance UUID, not a bare pid (see handle.ts).
 */
import { readHandle, getMyInstanceId } from '../studio/handle.js';
import { DaemonProxy } from './proxy.js';
import { createLogger } from '../logger.js';

const log = createLogger('studio');

export interface StudioObserveInput {
  /** The event cursor the agent last received; events ≤ this are acked. */
  since?: number;
  /** The snapshot id the agent currently holds; a mismatch forces a full snapshot. */
  base_id?: string;
  /** Retrieve a previously spilled full snapshot by ref. */
  snapshot_ref?: string;
}

/** Vision sub-result, if present — UNTRUSTED page-rendered pixels. `trusted` is a first-class serialized field so it survives JSON + the proxy round-trip. */
export interface VisionSubResult {
  region: { x: number; y: number; width: number; height: number };
  image: { format: 'png'; base64?: string; spillRef?: string };
  trusted: false;
}

export interface StudioObserveOutput {
  /** The new base snapshot id the agent should hold. */
  id: string;
  kind: 'full' | 'diff';
  elements?: unknown[];
  diff?: unknown;
  /** Spill ref when the snapshot/diff exceeded the inline budget. */
  snapshotRef?: string;
  events: Array<{ seq: number; type: string; [k: string]: unknown }>;
  /** High-water event cursor; the agent passes it back as `since`. */
  eventCursor: number;
  /** Events lost to overflow — non-zero means resync. */
  eventsDropped: number;
  domTruncated: boolean;
  vision?: VisionSubResult;
}

export interface StudioActInput {
  /** Phase 2I implements `navigate` only; click/type/scroll arrive in a later slice. */
  action: 'navigate' | 'click' | 'type' | 'scroll';
  /** For navigate: the URL to open in the shared session. */
  url?: string;
  ref?: string;
  text?: string;
  direction?: 'down' | 'up';
  amount?: number;
}

export interface StudioActOutput {
  ok: true;
  action: string;
  url?: string;
  /** For `type`: how many characters actually landed (full length on success). */
  charsLanded?: number;
}

/** A typed failure from a host handler (e.g. an evicted spill fetch, a refused action) — surfaced as a tool error, NOT a bare null a caller could read as "no content". */
export interface StudioToolError {
  error_reason: string;
  hint: string;
  /** Present on a `not_holder` refusal — the live control epoch, so the agent can resync its view of whose turn it is. */
  currentEpoch?: number;
  /** Present on an `aborted_reclaimed` from `type` — the partial effect (characters landed before the human reclaimed). */
  charsLanded?: number;
}

export function isStudioToolError(x: StudioObserveOutput | StudioActOutput | StudioToolError): x is StudioToolError {
  return typeof (x as StudioToolError).error_reason === 'string';
}

export interface StudioHostHandlers {
  observe(input: StudioObserveInput): Promise<StudioObserveOutput | StudioToolError>;
  act(input: StudioActInput): Promise<StudioActOutput | StudioToolError>;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
}

/** Injectable for tests; production builds a real DaemonProxy. */
export interface DispatchDeps {
  proxyFactory?: (endpoint: string, token: string) => { callTool(name: string, args: Record<string, unknown>): Promise<unknown> };
}

function refusal(error_reason: string, hint: string): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error_reason, hint }, null, 2) }], isError: true };
}

/**
 * Route a `studio_*` call. `studioHost` is set only in the live host process.
 * Returns the MCP tool result shape; on the proxy path returns the host's result
 * VERBATIM (preserving untrusted tags + every field).
 */
export async function dispatchStudioTool(
  name: string,
  args: Record<string, unknown>,
  studioHost: StudioHostHandlers | undefined,
  dataDir?: string,
  deps?: DispatchDeps,
): Promise<McpToolResult> {
  // EXECUTE — I am the live host. AUTHORIZATION IS HOST-SIDE: the control-token gate
  // for studio_act runs in studioHost.act() here (where the token lives), never on the
  // stdio proxy side — a stdio caller cannot satisfy or bypass it.
  if (studioHost) {
    if (name === 'studio_observe') {
      const data = await studioHost.observe(args as StudioObserveInput);
      if (isStudioToolError(data)) return refusal(data.error_reason, data.hint); // typed error → tool error, not silent
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
    }
    if (name === 'studio_act') {
      // args is validated structurally inside act() (unknown action → typed refusal).
      const data = await studioHost.act(args as unknown as StudioActInput);
      // Serialize the full result both ways — a refusal carries `hint` and (for
      // not_holder) `currentEpoch`, which the bare refusal() shape would drop.
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: isStudioToolError(data) };
    }
    return refusal('unknown_studio_tool', `No host handler for ${name}.`);
  }

  const handle = readHandle(dataDir);
  // REFUSE — no session published.
  if (!handle) return refusal('no_studio_session', 'No active studio session — ask the human to run `wigolo studio`.');

  // REFUSE-SELF — handle points at THIS process (wiring-window defense; instance UUID, not pid).
  const myId = getMyInstanceId();
  if (myId !== null && handle.instanceId === myId) {
    return refusal('studio_self_reference', 'Refusing to proxy a studio_* call to this same process.');
  }

  // PROXY — a foreign live host. Pass its result back verbatim.
  try {
    const makeProxy = deps?.proxyFactory ?? ((endpoint: string, token: string) => new DaemonProxy(endpoint, token));
    const result = await makeProxy(handle.endpoint, handle.token).callTool(name, args);
    return result as McpToolResult;
  } catch (err) {
    log.debug('studio host unreachable', { endpoint: handle.endpoint, error: err instanceof Error ? err.message : String(err) });
    // REFUSE — handle present but the host endpoint is dead (stale handle); fail loud, don't hang.
    return refusal('studio_host_unreachable', 'The studio host endpoint is not reachable (stale session handle?). Re-run `wigolo studio`.');
  }
}
