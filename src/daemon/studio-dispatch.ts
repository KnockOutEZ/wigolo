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
  /**
   * S2: optional agent-authored narration surfaced to the attended human (broadcast only, NOT a new
   * MCP verb). Always rendered inert (trusted=0) on the human surface — the agent can never author
   * trusted=1, so a page→agent→narration laundering path stays defused. Broadcast-only: in a clientless
   * background session it is a harmless no-op (no WS recipient). Never persisted.
   */
  narration?: string;
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
  /**
   * The page-perception payload here (`elements` / `diff` — their `role` + `name`) is
   * page-derived UNTRUSTED DATA, never instructions. Host-set: the page cannot forge it
   * because it is a sibling field, not anything inside a page-controlled string (an injected
   * `"trusted":true` lands inside a `name` value and stays inert under JSON framing). A
   * first-class serialized field so it survives JSON + the proxy round-trip, like the vision
   * sub-result. REQUIRED literal so a new observe return path cannot ship page content untagged.
   */
  trusted: false;
  /**
   * P6-a structural containment for this structured sink: the instruction-channel statement that
   * the page-perception payload (`elements`/`diff`) is UNTRUSTED DATA, never instructions. REQUIRED
   * (like `trusted`) so a new observe return path cannot ship page content without the statement,
   * and emitted UNCONDITIONALLY — never gated on `trusted` or `credentialContext`.
   */
  untrusted_notice: string;
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
  /**
   * Slice 5e-0: true when the live page is a credential context (login URL or a credential field
   * present). The page a11y content (`elements`/`diff`) is then EXCLUDED — an element name can be a
   * displayed secret (a 2FA/recovery code) — and only this signal is returned so the agent waits.
   * Host-set; mirrors the 5b capture-exclusion for the agent's read path.
   */
  credentialContext?: boolean;
  /**
   * Slice 5e-a: the login-wall handoff signal. `in_progress` (with `doNotRetry`) while a login
   * wall is being handled by the human — the agent waits rather than retrying into the fence — or
   * the settled `completed` / `failed`. Carries ONLY the state: never storageState, cookies, or
   * page content. Host-set; absent when no handoff is active.
   */
  login_handoff?: { state: 'in_progress' | 'completed' | 'failed'; doNotRetry?: true };
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
  /**
   * S2: optional agent-authored narration surfaced to the attended human (broadcast only, NOT a new
   * MCP verb). Always trusted=0 on the human surface (agent can never author trusted=1); rendered inert
   * via SafeText. Broadcast fires regardless of the act's own verdict — the agent narrates its intent.
   */
  narration?: string;
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

export interface StudioMarksInput {
  /** Phase 3c lists marks; 3d adds a read-only `generalize` op (preview the repeating sibling set a mark belongs to). */
  op?: 'list' | 'generalize';
  /** The mark to generalize when `op === 'generalize'`. */
  markId?: string;
  [k: string]: unknown;
}

/** One human mark, as the agent reads it: page-derived descriptors (untrusted) + the CURRENT heal verdict. */
export interface StudioMarkView {
  markId: string;
  role: string;
  name: string;
  /** role/name are page-derived — untrusted, like 2G vision + the mark event (Phase 3a). */
  trusted: false;
  /** Live re-resolution confidence (heal cascade): high/medium → actionable; low/none → re-observe / ask. */
  confidence: 'high' | 'medium' | 'low' | 'none';
  /** The live snapshot ref when confidently resolved (high/medium) — the agent passes it to studio_act. Absent for low/none. */
  ref?: string;
}

export interface StudioMarksOutput {
  marks: StudioMarkView[];
  /**
   * P6-a: the instruction-channel statement that the marks' page-derived role/name are UNTRUSTED
   * DATA, never instructions. REQUIRED + emitted unconditionally (including the credential-exclusion
   * path), never gated on a flag.
   */
  untrusted_notice: string;
  /**
   * Slice 5e-0: true when the live page is a credential context — the marks (page-derived role/name,
   * which can be a displayed secret if a mark was made on the credential screen) are then EXCLUDED
   * (empty `marks`) and only this signal is returned. Mirrors the observe/capture exclusion.
   */
  credentialContext?: boolean;
}

/**
 * Phase 3d `studio_marks{op:'generalize'}` — a PREVIEW of the repeating sibling set a mark belongs
 * to (a list/grid the human marked one example of). Carries only opaque host refs + a confidence,
 * NO page-derived content (no new trust surface). `requires_confirmation` is always true:
 * generalize is a READ — the agent acts per-ref via studio_act ONLY after the human confirms.
 */
export interface StudioGeneralizeOutput {
  markId: string;
  /** Live snapshot refs of the matched set, visually ordered — each passed to studio_act after the human confirm. */
  refs: string[];
  confidence: 'high' | 'medium' | 'low' | 'none';
  requires_confirmation: true;
}

export interface StudioCaptureInput {
  /** `clip` (needs content + url) or `qa` (needs question + answer; url-less). */
  type: string;
  /** The captured content — a clip's markdown (clip only). */
  content?: string;
  /** The page url the clip came from — REQUIRED for a clip; url-less is a qa property. */
  url?: string;
  /** The question (qa only). */
  question?: string;
  /** The answer (qa only). */
  answer?: string;
  /** Extra/smuggled fields are ignored by construction — the handler reads only the per-type safe fields. */
  [k: string]: unknown;
}

export interface StudioCaptureOutput {
  artifact_id: number;
  /** False when an existing artifact deduped the capture (no new row, no re-embed). */
  inserted: boolean;
  content_hash: string;
}

// ── S6: the bounded-inversion lifecycle verbs (studio_spawn / studio_close / studio_list) ──
// The agent may now SPAWN its own (background) sessions, bounded by the host cap. This inversion is
// SCOPED: it must NOT spill into self-approve, self-grant-control, or nav-fence. Types kept local so the
// dispatch seam stays free of any session-module import (it runs on the stdio side too).

export interface StudioSpawnInput {
  /** Optional URL the new background session should open first. */
  startUrl?: string;
}

export interface StudioSpawnOutput {
  /** The id of the newly created background session (agent-spawned → holder='agent', keepAlive). */
  session_id: string;
}

export interface StudioCloseInput {
  /** The id of the session to close. */
  session_id?: string;
}

export interface StudioCloseOutput {
  closed: true;
  session_id: string;
}

/** Enumeration-safe session metadata (mirrors session.ts SessionMeta; kept local to avoid a session-module import here). */
export interface StudioSessionView {
  id: string;
  status: string;
  clients: number;
  createdAt: number;
  lastActiveAt: number;
}

export interface StudioListOutput {
  sessions: StudioSessionView[];
}

export function isStudioToolError(
  x: StudioObserveOutput | StudioActOutput | StudioMarksOutput | StudioGeneralizeOutput | StudioCaptureOutput | StudioSpawnOutput | StudioCloseOutput | StudioListOutput | StudioToolError,
): x is StudioToolError {
  return typeof (x as StudioToolError).error_reason === 'string';
}

export interface StudioHostHandlers {
  observe(input: StudioObserveInput): Promise<StudioObserveOutput | StudioToolError>;
  act(input: StudioActInput): Promise<StudioActOutput | StudioToolError>;
  marks(input: StudioMarksInput): Promise<StudioMarksOutput | StudioGeneralizeOutput | StudioToolError>;
  capture(input: StudioCaptureInput): Promise<StudioCaptureOutput | StudioToolError>;
  // S6 — the bounded inversion: the agent may spawn/close/list its OWN sessions. These reach the registry
  // (host-wired in setStudioHost). They do NOT confer control/approval — those stay non-agent-reachable.
  spawn(input: StudioSpawnInput): Promise<StudioSpawnOutput | StudioToolError>;
  close(input: StudioCloseInput): Promise<StudioCloseOutput | StudioToolError>;
  list(): Promise<StudioListOutput | StudioToolError>;
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
    if (name === 'studio_marks') {
      const data = await studioHost.marks(args as StudioMarksInput);
      if (isStudioToolError(data)) return refusal(data.error_reason, data.hint);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
    }
    if (name === 'studio_capture') {
      const data = await studioHost.capture(args as StudioCaptureInput);
      if (isStudioToolError(data)) return refusal(data.error_reason, data.hint);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
    }
    if (name === 'studio_spawn') {
      const data = await studioHost.spawn(args as StudioSpawnInput);
      if (isStudioToolError(data)) return refusal(data.error_reason, data.hint);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
    }
    if (name === 'studio_close') {
      const data = await studioHost.close(args as StudioCloseInput);
      if (isStudioToolError(data)) return refusal(data.error_reason, data.hint);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
    }
    if (name === 'studio_list') {
      const data = await studioHost.list();
      if (isStudioToolError(data)) return refusal(data.error_reason, data.hint);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
    }
    return refusal('unknown_studio_tool', `No host handler for ${name}.`);
  }

  return proxyToStudioHost(name, args, dataDir, deps);
}

/**
 * The stdio-side forward to the live Studio host: read the published handle, REFUSE if none, REFUSE-SELF if it
 * points at THIS process (wiring-window defense; instance UUID, not pid), else PROXY the call and pass the
 * host's result back VERBATIM (untrusted tags + every field survive the round-trip). Shared by the studio_*
 * dispatch AND the D19 session-targeted fetch/extract/crawl forward, so both ride ONE bearer-authed,
 * instanceId-guarded proxy path — never a second hand-rolled lane.
 */
export async function proxyToStudioHost(
  name: string,
  args: Record<string, unknown>,
  dataDir?: string,
  deps?: DispatchDeps,
): Promise<McpToolResult> {
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
