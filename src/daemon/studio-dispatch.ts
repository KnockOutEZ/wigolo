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
 *       · no handle → try to START the substrate (amended-D4 auto-launch: starting a process is not
 *         a consent event, and the session opens on a clean profile), and only REFUSE if it cannot be
 *         started;
 *       · the host endpoint is dead → REFUSE no-reachable-host (fail loud, never hang).
 *
 * Identity is a collision-resistant instance UUID, not a bare pid (see handle.ts).
 */
import { readHandle, getMyInstanceId } from '../companion/handle.js';
import { ensureStudioRunning } from '../companion/auto-launch.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DaemonProxy } from './proxy.js';
import { createLogger } from '../logger.js';
import type { ToolName } from '../instructions.js';
import type { Driver } from '../studio/run-store.js';
import type { McpToolResult } from '../server/tool-registry.js';
import { currentClientProfile } from './capability-handshake.js';
import { applyFooter, renderFooter, NO_RUN_FOOTER, type FooterFields } from './studio-footer.js';
import { browserClosedError, isBrowserClosedError } from './browser-closed.js';

const log = createLogger('studio');

/**
 * The studio half of the tool-name union, expressed as a TYPE rather than a literal list — the same
 * idiom `src/daemon/rest/openapi.ts` uses to say "REST is the core surface only". It is what makes
 * the host-route table below compile-enforced: add a `studio_*` name to `ToolName` and tsc fails
 * here until it has a route, instead of the tool 404ing at runtime with a green typecheck.
 */
export type StudioToolName = Extract<ToolName, `studio_${string}`>;

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
  action: 'navigate' | 'click' | 'type' | 'scroll' | 'wait_for_human';
  /** For navigate: the URL to open in the shared session. */
  url?: string;
  ref?: string;
  text?: string;
  direction?: 'down' | 'up';
  amount?: number;
  /** For wait_for_human: why this run needs a human answer before it can continue. */
  reason?: string;
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
  /**
   * P1: a non-error act STAGE (spec §5/§11 — a stage, not a failure, so `isError` stays false).
   *  - `pending_approval`: a risky act was parked for the human's Allow/Deny; the decision arrives in the
   *    next `studio_observe` drain. The act did NOT execute. Do not retry — continue other work.
   *  - `preempted`: the human took the wheel during the act; the in-flight step stood down. Re-observe.
   */
  stage?: 'pending_approval' | 'preempted';
  /** The approval id assigned to a parked act (present with `stage: 'pending_approval'`), echoed back in the observe drain's decision event. */
  approval_id?: string;
}

/** A typed failure from a host handler (e.g. an evicted spill fetch, a refused action) — surfaced as a tool error, NOT a bare null a caller could read as "no content". */
export interface StudioToolError {
  /**
   * A STABLE MACHINE CODE — `not_holder`, `origin_budget_exhausted`, `capture_refused` — never a sentence.
   * Same contract as the core failure envelope (docs/rest-api.md "Error shape"), and what
   * `extractErrorReason` (src/server.ts:105) reads off this envelope for the D10 audit while documenting
   * it as "a typed reason string … not user content — safe to audit". A refusal that put prose here made
   * that column unaggregatable and forced consumers to key on free text.
   */
  error_reason: string;
  hint: string;
  /**
   * The human-readable message, when the code alone loses information the caller needs — the live budget
   * counters, the origin, why a grant was refused. Optional: most refusals say everything they have in
   * the code plus the hint. Mirrors the core published envelope's `error`.
   */
  error?: string;
  /** Present on a `not_holder` refusal — the live control epoch, so the agent can resync its view of whose turn it is. */
  currentEpoch?: number;
  /** Present on an `aborted_reclaimed` from `type` — the partial effect (characters landed before the human reclaimed). */
  charsLanded?: number;
  /**
   * Present on a `not_the_driver` refusal (SD2 §1.5) — who actually drives this run, whole, so an
   * observer can resync in one hop instead of polling to find out.
   */
  driver?: Driver;
  /** The same refusal's driver as ONE string, minted by `formatDriver` — identical in REST, on the event stream and here. */
  driver_name?: string;
  /**
   * The run this failure happened in, when the call resolved to one (SD2 §4.3's `browser_closed`).
   * The footer names it too; it is a first-class field here so a machine consumer does not have to
   * parse rendered text to find the run it must resume or end.
   */
  run?: string;
}

export interface StudioMarksInput {
  /** Phase 3c lists marks; 3d adds a read-only `generalize` op (preview the repeating sibling set a mark belongs to). */
  op?: 'list' | 'generalize';
  /** The mark to generalize when `op === 'generalize'`. */
  markId?: string;
  [k: string]: unknown;
}

/**
 * The DOM-to-code rich element payload (spec §5) — captured by the marking overlay from the page.
 * ALL string fields are page-derived UNTRUSTED data (host-neutralized before it crosses to the agent).
 * Framework `component` + `source` are best-effort (§13.2) and degrade to null. Structurally mirrored by
 * the app-side overlay-core `MarkPayload` (core cannot import the app; the shapes are kept in sync).
 */
export interface MarkPayload {
  tag: string;
  id: string;
  classes: string[];
  attrs: Record<string, string>;
  dataset: Record<string, string>;
  text: string;
  component: string | null;
  source: { file: string; line: number } | null;
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
  /** The DOM-to-code rich element payload (§5) — present when the mark carried one. Page-derived → host-neutralized. */
  payload?: MarkPayload;
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

// P6 F1 grab-all: generalize a marked repeating pattern into structured rows. Agent-reachable; credential-
// refused at source, SSRF-fenced pagination (Document-class only). `mark_id` is required (dispatch casts).
export interface StudioExtractSetInput {
  mark_id: string;
  /** Optional — defaults to the active session's tab. A tab_id belonging to another session is refused. */
  tab_id?: string;
  exclude_refs?: string[];
  follow_pagination?: boolean;
  max_pages?: number;
  max_rows?: number;
}

export interface StudioExtractSetOutput {
  columns: string[];
  rows: Record<string, string>[];
  pages_followed: number;
  truncated?: boolean;
  excluded?: number;
  artifact_id?: number;
  /** Non-error StageResult stages (like studio_act): a pagination hop needing a grant, or a credential-page refusal. */
  stage?: 'pending_approval' | 'refused';
  approval_id?: string;
  reason?: string;
}

// P4 co-drive: the agent posts a message to the human's chat rail (optionally threaded on a mark). This is
// agent→human communication — it confers NO control/approval/grant power, so it is a legitimate agent verb.
export interface StudioSayInput {
  /** The message to post to the human in the session chat rail. */
  text: string;
  /** Optional mark id (from studio_marks) to thread the reply under. */
  markId?: string;
}

export interface StudioSayOutput {
  posted: true;
  posted_at: number;
}

// ── S6: the bounded-inversion lifecycle verbs (studio_spawn / studio_close / studio_list) ──
// The agent may now SPAWN its own (background) sessions, bounded by the host cap. This inversion is
// SCOPED: it must NOT spill into self-approve, self-grant-control, or nav-fence. Types kept local so the
// dispatch seam stays free of any session-module import (it runs on the stdio side too).

export interface StudioSpawnInput {
  /** Optional URL the new background session should open first. */
  startUrl?: string;
  /** Optional friendly session name (studio_open sets this; studio_spawn's schema omits it). */
  name?: string;
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
  /** The run this session drives (law 4: the run id is also the tab-group id). */
  runId?: string;
  /**
   * The tabs the run owns, and only those. Law 4's user group is defined by absence — a tab the human
   * opened has no ownership record, so there is no path by which it can appear in an agent's listing.
   */
  tabIds?: string[];
}

export interface StudioListOutput {
  sessions: StudioSessionView[];
}

/** Anything a host handler can return. Named so the route table and the type guard share one union. */
export type StudioHostOutput =
  | StudioObserveOutput | StudioActOutput | StudioMarksOutput | StudioGeneralizeOutput | StudioCaptureOutput
  | StudioSayOutput | StudioExtractSetOutput | StudioSpawnOutput | StudioCloseOutput | StudioListOutput
  | StudioToolError;

export function isStudioToolError(x: StudioHostOutput): x is StudioToolError {
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
  // P4: agent→human chat post. New agent-reachable verb (8th key); confers no control/approval (PIN-SPLIT(b)).
  say(input: StudioSayInput): Promise<StudioSayOutput | StudioToolError>;
  // P6 F1: generalize a marked repeating pattern into structured rows (9th key; credential-refused, SSRF-fenced).
  extractSet(input: StudioExtractSetInput): Promise<StudioExtractSetOutput | StudioToolError>;
}

export type { McpToolResult };

/**
 * The baton gate (SD2 §1.5 / §7 row 12). Installed by the process that becomes the live studio host
 * — `DaemonHttpServer.setStudioHost` — because that is the only moment a process both owns the
 * handlers and can reach the run log. Returns a refusal to serve INSTEAD of the call, or `undefined`
 * to let it through.
 *
 * A module-level seam rather than a `DispatchDeps` field on purpose: `dispatchStudioTool`'s deps are
 * threaded by `tool-provider.ts` per call, and the gate is a property of the PROCESS, not of a call.
 * Absent (the default), dispatch behaves exactly as it did before the baton existed.
 */
export type BatonGate = (name: string, args: Record<string, unknown>) => Promise<StudioToolError | undefined>;

let batonGate: BatonGate | undefined;

/** Install, or (with `undefined`) remove — tests MUST remove theirs, a leaked gate outlives the suite. */
export function setBatonGate(gate: BatonGate | undefined): void {
  batonGate = gate;
}

/**
 * The delivery queue at the result seam (SD2 mini-spec §3.2 mechanism 1). A process seam for the
 * same reason `BatonGate` is one: draining a run's queue needs the run log, which only the live host
 * process can reach, and the run is a property of the connection rather than of any one call.
 *
 * Two halves of one rule, and the order between them is the rule. `acknowledge` runs BEFORE the
 * handler: this call existing is the proof that the harness consumed the previous result and kept
 * going, which is what an implicit acknowledgement is (A-51-4). `deliver` runs AFTER, on the minted
 * result, because piggyback means the messages ride a result that was going to be sent anyway.
 *
 * Interrupt/delivery hooks never throw through dispatch. The wait verb may return a typed refusal
 * when it cannot identify or read the run it was asked to park; ordinary mailbox failures remain
 * non-blocking and leave messages queued.
 */
export interface DeliveryHooks {
  /**
   * Return a one-shot, run-scoped interrupt before any baton refusal or host work. Undefined means
   * normal dispatch continues. This has to precede the baton: after a human takeover the old driver
   * is already an observer, but is still owed exactly one interrupted receipt.
   */
  interrupt(name: string, args: Record<string, unknown>): Promise<McpToolResult | undefined>;
  acknowledge(name: string, args: Record<string, unknown>): Promise<void>;
  deliver(name: string, args: Record<string, unknown>, result: McpToolResult, signal?: AbortSignal): Promise<McpToolResult>;
  /** Release any parked listeners when the host/transport delivery coordinator is replaced. */
  dispose?(): void;
}

/**
 * The §7 row 3 release receipt at the result seam (SD2 mini-spec §1.4). A process seam for the same
 * reason `BatonGate` and `DeliveryHooks` are: the receipt is a projection of the run log.
 *
 * It runs on the FINISHED result rather than instead of the call, and outside `executeOnHost`
 * rather than inside it, because "the old driver's next call, any call" includes the calls that
 * never reach a route — the observer refusal it is now going to get, and the unknown-tool answer.
 * A hook placed at any one arm would miss the arms a stranded driver is most likely to hit.
 *
 * Returns the result to send. It must never throw and never withhold: a decoration that could fail
 * a call would be worse than the silence it exists to prevent.
 */
export type ReceiptDelivery = (
  name: string,
  args: Record<string, unknown>,
  result: McpToolResult,
) => Promise<McpToolResult>;

let receiptDelivery: ReceiptDelivery | undefined;

/** Install, or (with `undefined`) remove — tests MUST remove theirs, a leaked hook outlives the suite. */
export function setReceiptDelivery(delivery: ReceiptDelivery | undefined): void {
  receiptDelivery = delivery;
}

/** Never blocks the call: a receipt that cannot be minted stays owed and rides the next result. */
async function attachReceipt(
  name: string,
  args: Record<string, unknown>,
  result: McpToolResult,
): Promise<McpToolResult> {
  if (!receiptDelivery) return result;
  try {
    return await receiptDelivery(name, args, result);
  } catch (err) {
    log.warn('release receipt hook threw; sending the result undecorated', { tool: name, error: String(err) });
    return result;
  }
}

/**
 * The §4.4 footer's data seam (#56). A process seam for the same reason `BatonGate` and
 * `DeliveryHooks` are: every footer field is a projection of the run log, and only the live host
 * process can read it. Absent — the stdio side, the Electron main, a unit test that installs none —
 * the footer still lands, rendering `— no run —`, because a result without a footer is the one
 * shape law 9 does not allow.
 */
export interface FooterContext {
  /** The run this call resolved to, for the arms that name it (the browser-closed error). */
  readonly runId?: string;
  /**
   * Read the fields, LIVE. Called once, at the exit, so it sees what the call itself appended: the
   * browser action the act recorded, the messages the delivery queue rode on this very result.
   *
   * May answer asynchronously (#331): a host whose store is a port rather than a native handle
   * projects the same fields over async RPC, and a synchronous-only signature is precisely what
   * shut that host out. A source that can answer synchronously still may — the exit awaits either.
   */
  fields(): FooterFields | Promise<FooterFields>;
  /**
   * Called after the footer is rendered, with the finished result. The one thing it records is the
   * driver's re-read (§4.2's "newer than the driver's last read"), which must NOT clear the
   * `page changed` line on the result that announces it.
   */
  settle?(result: McpToolResult): void | Promise<void>;
}

export interface FooterSource {
  begin(name: string, args: Record<string, unknown>): Promise<FooterContext | undefined>;
}

let footerSource: FooterSource | undefined;

/** Install, or (with `undefined`) remove — tests MUST remove theirs, a leaked source outlives the suite. */
export function setFooterSource(source: FooterSource | undefined): void {
  footerSource = source;
}

/**
 * Never throws and never blocks the call: a footer that cannot be sourced degrades to `— no run —`,
 * which is honest, whereas failing the tool call over a decoration would be absurd.
 */
async function beginFooter(name: string, args: Record<string, unknown>): Promise<FooterContext | undefined> {
  try {
    return await footerSource?.begin(name, args);
  } catch (err) {
    log.warn('footer source could not resolve the run; rendering no-run', { tool: name, error: String(err) });
    return undefined;
  }
}

/** THE exit. Attaches the footer to whatever the host branch produced, then records the re-read. */
async function finishStudioResult(footer: FooterContext | undefined, result: McpToolResult): Promise<McpToolResult> {
  let fields: FooterFields = {};
  try {
    fields = (await footer?.fields()) ?? {};
  } catch (err) {
    log.warn('footer fields could not be projected; rendering no-run', { error: String(err) });
  }
  const rendered = applyFooter(result, renderFooter(fields, currentClientProfile().phrasing));
  try {
    // Awaited, not fired and forgotten: a rejected settle has to reach the catch below, and an
    // unawaited rejection here would surface as an unhandled rejection that exits the process.
    await footer?.settle?.(result);
  } catch (err) {
    log.warn('footer could not record the re-read', { error: String(err) });
  }
  return rendered;
}

/** A refusal minted where no run can exist (the stdio side): the footer says exactly that. */
function noRunRefusal(error_reason: string, hint: string): McpToolResult {
  return applyFooter(refusal(error_reason, hint), NO_RUN_FOOTER);
}

const dispatchSignal = new AsyncLocalStorage<AbortSignal>();

/** Scope the MCP request's cancellation over local dispatch and any daemon-to-host proxy hop. */
export function withStudioDispatchSignal<T>(signal: AbortSignal, fn: () => T): T {
  return dispatchSignal.run(signal, fn);
}

let deliveryHooks: DeliveryHooks | undefined;

/** Install, or (with `undefined`) remove — tests MUST remove theirs, leaked hooks outlive the suite. */
export function setDeliveryHooks(hooks: DeliveryHooks | undefined): void {
  if (deliveryHooks !== hooks) deliveryHooks?.dispose?.();
  deliveryHooks = hooks;
}

/** Injectable for tests; production builds a real DaemonProxy. */
export interface DispatchDeps {
  /** Request cancellation; normally supplied by the MCP handler's async-local scope. */
  signal?: AbortSignal;
  proxyFactory?: (endpoint: string, token: string) => {
    callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>;
  };
}

/**
 * `error` is threaded rather than dropped: it is the only field carrying information the code cannot
 * (live budget counters, the refused origin), so a route that omitted it would silently degrade the
 * refusal depending on which helper minted it.
 */
function refusal(error_reason: string, hint: string, error?: string): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error_reason, ...(error ? { error } : {}), hint }, null, 2) }],
    isError: true,
  };
}

/** A typed error becomes a refusal; anything else serializes as the data it is. */
function refuseOrData(data: StudioHostOutput): McpToolResult {
  if (isStudioToolError(data)) return refusal(data.error_reason, data.hint, data.error);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: false };
}

/**
 * Serialize the FULL result both ways. studio_act needs this because a refusal carries `hint` and
 * (for not_holder) `currentEpoch`, which the bare refusal() shape would drop.
 */
function verbatim(data: StudioHostOutput): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], isError: isStudioToolError(data) };
}

type HostRoute = (host: StudioHostHandlers, args: Record<string, unknown>) => Promise<McpToolResult>;

/**
 * Tool name → host handler. Ten names, NINE handler keys: studio_open is the §5 public entry verb
 * and routes to the SAME `spawn` key (PIN-SPLIT(a) — the agent-reachable handler-key set stays
 * byte-unchanged). `Record<StudioToolName, …>` is the enforcement: a new studio tool cannot compile
 * until it has a route here, which is what the old ten-way if-chain could not promise.
 */
const HOST_ROUTES: Record<StudioToolName, HostRoute> = {
  studio_open: async (h, a) => refuseOrData(await h.spawn(a as StudioSpawnInput)),
  studio_observe: async (h, a) => refuseOrData(await h.observe(a as StudioObserveInput)),
  // args is validated structurally inside act() (unknown action → typed refusal).
  studio_act: async (h, a) => verbatim(await h.act(a as unknown as StudioActInput)),
  studio_marks: async (h, a) => refuseOrData(await h.marks(a as StudioMarksInput)),
  studio_capture: async (h, a) => refuseOrData(await h.capture(a as StudioCaptureInput)),
  // mark_id + tab_id are required → structural cast (mirrors studio_act's action). Host validates.
  studio_extract_set: async (h, a) => refuseOrData(await h.extractSet(a as unknown as StudioExtractSetInput)),
  studio_say: async (h, a) => refuseOrData(await h.say(a as unknown as StudioSayInput)),
  studio_spawn: async (h, a) => refuseOrData(await h.spawn(a as StudioSpawnInput)),
  studio_close: async (h, a) => refuseOrData(await h.close(a as StudioCloseInput)),
  studio_list: async (h) => refuseOrData(await h.list()),
};

/** Own-property lookup — a bare `HOST_ROUTES[name]` would resolve prototype keys like 'constructor'. */
const HOST_ROUTE_TABLE = new Map<string, HostRoute>(Object.entries(HOST_ROUTES));

/**
 * Every host-executed result path, derived from the route table rather than listed — so #56's
 * "100% coverage, measured" claim is measured against the table that actually routes, and a tool
 * added later is in the enumeration the moment it compiles. Read by
 * `tests/unit/daemon/studio-footer-coverage.test.ts`.
 */
export const STUDIO_ROUTE_NAMES: readonly StudioToolName[] = Object.freeze(Object.keys(HOST_ROUTES) as StudioToolName[]);

/**
 * Route a `studio_*` call. `studioHost` is set only in the live host process.
 * Returns the MCP tool result shape; on the proxy path returns the host's result
 * VERBATIM (preserving untrusted tags + every field).
 *
 * THE FOOTER'S ONE EXIT (§4.4, law 9). The host branch has exactly one `return`, and it is the
 * `finishStudioResult` call at the bottom: every result this process mints — a route's answer, an
 * interrupt receipt, a baton refusal, an unknown tool, the browser-closed error — leaves through
 * it and therefore carries the footer. That is stronger than routing the three serializers through
 * a shared constructor (mini-spec §4.1's shape): a NEW serializer would still have to return
 * through this line. What can defeat it is a new early `return` above it, which is exactly the
 * throwaway path `tests/unit/daemon/studio-footer-coverage.test.ts` proves it can see.
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
    // Opened BEFORE any work so the footer can name the run even when the call is refused before
    // it reaches the page: a refused observer needs the run id and the watch link more, not less.
    const footer = await beginFooter(name, args);
    // The receipt is attached BETWEEN the ladder and the exit, so it decorates every arm the ladder
    // can produce while the footer still lands last on all of them — this is not a second exit.
    const executed = await executeOnHost(name, args, studioHost, footer, deps);
    return finishStudioResult(footer, await attachReceipt(name, args, executed));
  }

  return proxyToStudioHost(name, args, dataDir, deps);
}

/**
 * The host-side execution ladder. Returns the result UNFOOTERED — `dispatchStudioTool` owns the one
 * exit that attaches it — so every arm here can `return` the shape it means without remembering to
 * decorate it.
 */
async function executeOnHost(
  name: string,
  args: Record<string, unknown>,
  studioHost: StudioHostHandlers,
  footer: FooterContext | undefined,
  deps?: DispatchDeps,
): Promise<McpToolResult> {
  {
    const route = HOST_ROUTE_TABLE.get(name);
    if (route) {
      // Interrupts are receipts addressed to the driver that was active when the trigger landed.
      // In the takeover case that client is no longer the current driver, so this check MUST run
      // before the baton gate. The consumed event makes this path fire once; the following call
      // reaches the ordinary observer refusal below.
      const interrupted = await deliveryHooks?.interrupt(name, args);
      if (interrupted) return interrupted;
      // The baton is checked AFTER the route resolves, so an unknown tool still reads as unknown,
      // and BEFORE the handler runs, so an observer's act never reaches the page at all. Serialized
      // with `verbatim` because a `not_the_driver` refusal carries `driver` + `driver_name`, which
      // the bare `refusal()` shape would drop — the same reason studio_act uses it.
      const refused = await batonGate?.(name, args);
      if (refused) return verbatim(refused);
      // Law 7 at the one seam that can honour it. The acknowledgement is appended before the
      // handler runs — the call itself is the evidence the last result was consumed — and the
      // delivery rides the result the call was going to produce regardless. A refused caller gets
      // neither: it is not the run's driver, so the driver's mail is not its to read or to answer.
      await deliveryHooks?.acknowledge(name, args);
      // §7 row 11: the browser can vanish under a live host — the engine process dies, the tab
      // group is destroyed — and the engine reports that by throwing. An escaping throw would
      // reach the agent as a transport-level failure that names nothing; this turns it into the
      // structured `browser_closed` answer carrying the run id, which the footer then repeats.
      let result: McpToolResult;
      try {
        result = await route(studioHost, args);
      } catch (err) {
        if (!isBrowserClosedError(err)) throw err;
        log.debug('browser engine closed mid-run', { tool: name, run: footer?.runId });
        return verbatim(browserClosedError(footer?.runId));
      }
      return deliveryHooks ? deliveryHooks.deliver(name, args, result, deps?.signal ?? dispatchSignal.getStore()) : result;
    }
    // A name that looks like a control/approval primitive has no route BY DESIGN — PIN-SPLIT(b):
    // there is no agent path to obtain control or self-approve.
    return refusal('unknown_studio_tool', `No host handler for ${name}.`);
  }
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
  // Amended D4 (S9): no published session is no longer a dead end. Starting a process is not a consent event
  // — the session opens on a CLEAN profile, and D9's grant card is what gates spending the human's identity —
  // so try to start the substrate first. Only when it cannot be started does this refuse, and then it says so
  // honestly rather than telling the agent to ask a human who may not be there.
  const handle = readHandle(dataDir) ?? (await ensureStudioRunning({ dataDir }));
  if (!handle) {
    return noRunRefusal(
      'no_studio_session',
      'No browser session is running and one could not be started here. Ask the human to open a browser session, or continue without one.',
    );
  }

  // REFUSE-SELF — handle points at THIS process (wiring-window defense; instance UUID, not pid).
  const myId = getMyInstanceId();
  if (myId !== null && handle.instanceId === myId) {
    return noRunRefusal('studio_self_reference', 'Refusing to proxy a studio_* call to this same process.');
  }

  // PROXY — a foreign live host. Pass its result back verbatim.
  try {
    const makeProxy = deps?.proxyFactory ?? ((endpoint: string, token: string) => new DaemonProxy(endpoint, token));
    const signal = deps?.signal ?? dispatchSignal.getStore();
    const result = await makeProxy(handle.endpoint, handle.token).callTool(name, args, signal ? { signal } : undefined);
    return result as McpToolResult;
  } catch (err) {
    log.debug('studio host unreachable', { endpoint: handle.endpoint, error: err instanceof Error ? err.message : String(err) });
    // REFUSE — handle present but the host endpoint is dead (stale handle); fail loud, don't hang.
    return noRunRefusal('studio_host_unreachable', 'The studio host endpoint is not reachable (stale session handle?). Re-run `wigolo studio`.');
  }
}
