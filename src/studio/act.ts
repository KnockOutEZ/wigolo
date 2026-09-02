/**
 * The studio_act orchestration — the host-side logic the dispatch seam delegates to
 * (kept out of the dispatcher, mirroring observe.ts). Phase 2I implements `navigate`;
 * click/type/scroll arrive in a later slice.
 *
 * Navigation is the agent's real SSRF surface, so it is fenced on three layers, all
 * fail-closed and all HOST-AUTHORITATIVE (the control token lives here, never on the
 * stdio proxy side):
 *  - GATE before acting — `assertCanDrive('agent')`; the human holding ⇒ refuse and
 *    return the live epoch so the agent can resync whose turn it is.
 *  - EPOCH FENCE on the entry — capture the gate epoch and re-check it immediately
 *    before the CDP nav command (`beforeNavigate`); a reclaim that slips into the
 *    gate→start window stands the agent down rather than navigating under a revoked
 *    grant. (The pull-at-eval NavInterceptor re-validates each redirect hop under the
 *    live holder, and its abort cancels an in-flight nav on reclaim — those cover
 *    everything downstream of the command-send; the fence covers the entry.)
 *  - SINGLE-SOURCE POLICY — the entry guard and the interceptor both read
 *    `policyForHolder('agent', grant)` off the SAME grant object, so the initial-URL
 *    verdict and the per-hop verdict agree by construction.
 *
 * A reclaim during the nav (entry fence OR in-flight abort) is surfaced as the
 * distinct `aborted_reclaimed` — never a generic `navigation_failed` the agent would
 * retry, which would have it fighting the human for the wheel.
 */
import { navigateSession, type NavigableBrowser } from './nav.js';
import { checkAgentDrive, type AgentDriveGate } from './agent-drive-gate.js';
import { policyForHolder, type NavGrant } from './nav-policy.js';
import type { ControlParty } from './control-token.js';
import type { AgentInputEvent } from './input-events.js';
import { isResolveError, type ResolveResult, type ResolveErrorReason } from './perception/resolve.js';
import { PAGE_CHANGED_BY_HUMAN, type HeldSnapshotRead } from './perception/held-snapshot.js';
import { diffSnapshots } from './perception/diff.js';
import type { PageSnapshot, SnapshotElement } from './perception/snapshot.js';
import { UNTRUSTED_STUDIO_NOTICE, neutralizeMarkers } from '../security/untrusted.js';
import { writeLargeOutput, excerptToFile } from '../server/large-output.js';
import type { StudioActInput, StudioActOutput, StudioToolError } from '../daemon/studio-dispatch.js';
import type { AuditRecordInput, AuditOutcome } from './audit.js';
import { classifyRisk, type RiskTier, type RiskPatterns } from './risk.js';
import { deriveDomain, type PreGrantStore } from './pre-grant.js';
import { refuseAgentType, isCredentialContext, type FieldSemantics } from './credential.js';
import { isCredentialRecordingContext, type FlowRecorderHook } from './flow/record.js';
import type { StructuredTarget } from './mark/target.js';

/**
 * S7: how a risky action was authorized at the gate, recorded in the audit.
 *
 * EXHAUSTIVE, and deliberately only two: a matching human pre-grant authorizes, and everything else
 * parks. There is NO live per-action approval verdict on this path — see the risk-gate note on
 * `applyRiskGate` — so an `ApprovalDecision` (`approved`/`refused`/`timeout`/`superseded`) is not a
 * value this type can take. Widening it back is the tell that someone has re-introduced a verdict
 * wait; wire it end-to-end or leave this narrow. (`AuditRecordInput['approval']` stays wider because
 * it also reads historical rows persisted before S7.)
 */
export type AuthSource = 'pre-grant' | 'parked';

/** S7: a risky action with no matching pre-grant, enqueued for the human's batch review (not executed). */
export interface ParkedAction {
  action: string;
  risk: RiskTier;
  domain?: string;
  ref?: string;
}

/**
 * PIN 8 — DECLARATIVE POST-ACTIONS. A BrowserOS lesson adopted by the brief: an agent that clicks
 * something almost always needs two more facts before it can decide anything, and today it has to
 * spend two more tool calls to get them — what the page became, and whether the page complained.
 * So `studio_act` attaches both to the result it was already returning. Result-text enrichment is
 * the cheapest tier of the pin-8 ladder (enrichment → act verb → dispatcher tool): no new tool, no
 * new seam register, and an agent that ignores the block is exactly as correct as before.
 *
 * THE PAYLOAD IS PAGE-DERIVED, so it carries the same fence `studio_observe` carries and is built
 * the same way: element `role`/`name` and console text are UNTRUSTED DATA, marker-neutralized so a
 * hostile string cannot forge the boundary, and tagged `trusted: false` beside an explicit notice.
 * A credential context (a login wall, a 2FA screen) EXCLUDES the text entirely — an element name or
 * a console line can be a displayed secret — mirroring the observe and capture exclusions.
 */
export interface ActPostActions {
  /** Page-derived payload, host-set. The page cannot forge it: it is a sibling field, never inside a page string. */
  trusted: false;
  /** The instruction-channel statement that everything below is data, never instructions. */
  untrusted_notice: string;
  settled: ActSettleDiff;
  console: ActConsoleSummary;
}

/**
 * What the page became after the act landed, as a delta against the snapshot the agent last read.
 *
 * `base: 'none'` means there was no held snapshot to diff against (the agent acted without observing,
 * or the host wires no holder), so the counts describe the whole page rather than a change — said
 * plainly rather than reported as if everything had just appeared.
 *
 * This NEVER writes the held snapshot. Clearing a pending human-edit invalidation is what a re-read
 * earns (§7 row 1), and an act is not a re-read; if the settle-diff held the snapshot, an agent could
 * satisfy "re-read the page" by clicking, which is the one thing that trigger exists to prevent.
 */
export interface ActSettleDiff {
  base: 'held' | 'none';
  added: number;
  removed: number;
  changed: number;
  /** Identical-sibling positional drift — never presented as a confident change. */
  churn: number;
  /** Neutralized excerpt of what appeared or changed. Absent in a credential context. */
  sample?: SnapshotElement[];
  /** Descriptors that are only in `file`. Absent when the excerpt is the whole set. */
  spilled?: number;
  /** Absolute path to the full delta on disk (law 11: local and inspectable). Absent when nothing spilled. */
  file?: string;
  /** Set when the page is a credential context and the descriptors were withheld. */
  excluded?: 'credential_context';
}

/** What the browser engine's console said while the act ran. Page-authored text ⇒ neutralized, truncated, capped. */
export interface ActConsoleSummary {
  errors: number;
  warnings: number;
  /** Neutralized excerpt of the messages. Absent in a credential context. */
  sample?: string[];
  spilled?: number;
  /** Absolute path to the full message list on disk. Absent when nothing spilled. */
  file?: string;
  excluded?: 'credential_context';
}

/** One console line as the host collected it. The host owns collection; this module only summarizes. */
export interface ConsoleMessage {
  level: 'error' | 'warning' | 'info' | 'log' | 'debug';
  text: string;
}

/**
 * The host-supplied capability the post-actions are built from. ABSENT ⇒ no post-actions are
 * attached and every act result is byte-identical to what it was, which is what keeps every
 * pre-pin-8 host and unit test correct rather than merely passing.
 */
export interface ActPostActionDeps {
  /** A fresh page snapshot, taken AFTER the act landed — the "after" half of the delta. */
  snapshot: () => Promise<PageSnapshot>;
  /**
   * Wait for the page to quiesce before the snapshot. Host-owned because quiescence needs the page
   * handle and this module deliberately holds none; absent ⇒ the snapshot is taken immediately, which
   * is a smaller claim (a delta, not a SETTLED delta) rather than a wrong one.
   */
  settle?: () => Promise<void>;
  /** Drain the console lines collected since the last drain. Host-owned; absent ⇒ zero counts, no sample. */
  consoleSince?: () => readonly ConsoleMessage[];
  /** Run attribution for any file this writes (law 1). Pull-at-eval, matching the other deps here. */
  runId?: () => string | undefined;
  dataDir?: string;
  /** How many descriptors / messages stay inline before the rest goes to a file. */
  sampleLimit?: number;
}

/** The narrow view of the control token the act handler needs (the real ControlToken satisfies it). */
export interface ActControlToken {
  readonly holder: ControlParty;
  readonly epoch: number;
  assertCanDrive(party: ControlParty): { ok: true } | { ok: false; reason: string; currentEpoch: number };
}

/** The single token-gated CDP input channel the agent's units dispatch through (the SessionController). */
export interface AgentInputChannel {
  /** Gate at `epoch` + dispatch a balanced unit atomically; returns whether it landed (false = the epoch fence dropped it). */
  dispatchAgentUnit(epoch: number, events: AgentInputEvent[]): Promise<boolean>;
  /** Page-CSS-px viewport centre — where an agent scroll aims its wheel. */
  viewportCenter(): { x: number; y: number };
  /**
   * P4 co-drive: fan an out-of-band UI event to the human surface (drive banner narration + ghost cursor).
   * Optional so the minimal test mocks + a clientless background session need not provide it. The payload
   * is ALWAYS agent-authored (narration) or viewport coords — NEVER page-derived content.
   */
  announce?(msg: Record<string, unknown>): void;
}

export interface ActHandlerDeps {
  browser: NavigableBrowser;
  controlToken: ActControlToken;
  /** The SINGLE source of nav policy — the same grant object the interceptor reads, so the entry guard and per-hop guard agree by construction. */
  grant: NavGrant;
  /** Resolve a snapshot ref to a LIVE clickable centre (2J.1): fresh snapshot per call, occlusion hit-test, never cached coords. */
  resolve: (ref: string) => Promise<ResolveResult>;
  /** The single epoch-gated input channel; click/type/scroll dispatch here — NEVER action-executor.page.* or a raw CDP Input side-channel (those bypass the fence + neutralization). */
  channel: AgentInputChannel;
  /**
   * Phase 6b: the per-session append-only audit log; every action + outcome is recorded for trust + the
   * display timeline. Optional so the unit tests can omit it.
   *
   * The return is `{seq}`-or-nothing rather than `void` so the S13 flow sidecar can JOIN a recorded step
   * back to the audit row it was derived from. A fake that returns nothing stays valid; a step whose
   * audit row is missing is simply never recorded (see `flow`).
   */
  audit?: { record(input: AuditRecordInput): { seq: number } | void };
  /**
   * S13-0: the flow sidecar recorder. Notify-only, like `audit` — a recording failure never turns a
   * successful action into an error the agent would retry. Absent (every pre-S13 host and unit test) ⇒
   * no seed is built and nothing is written, so the act path behaves exactly as it did.
   */
  flow?: FlowRecorderHook;
  /**
   * NO `approvals` DEP HERE — deliberate, and load-bearing. This seam once declared an
   * `approvals?: { request(...) }` that NOTHING read: the CLI host even PASSED one and this handler
   * never destructured it, so it advertised a per-action human verdict that did not exist (the
   * Electron host did not pass it at all). A gate that is
   * declared but unread is worse than no gate — it reads as protection to the next person and
   * protects nothing. Risky actions are gated by the PRE-GRANT/PARK path below (plus the hard
   * credential refusal, plus the D9 drive gate on `navigate`); the blocking round-trip was
   * rejected by design (P1: risky verbs take the non-blocking park path, NOT
   * `SessionApprovals.request()`). Re-adding a request seam here means wiring it end-to-end.
   */
  /**
   * §7 row 1: the session's held page snapshot, consulted through its ONE read seam. A `ref` is an
   * address INTO the snapshot the agent read, so once a human has edited that page the address no
   * longer means what the agent was told — §5: "the stale snapshot's marks are refused as act
   * targets until a re-read". Absent (every pre-SD2 host and the unit tests of the safe paths) ⇒
   * nothing is ever stale here and the act path behaves exactly as it did.
   */
  held?: { read(): HeldSnapshotRead };
  /** Phase 6c: the live page URL (host-observed) — the HARD signal the risk classifier weights over the page-controlled element role/name. */
  currentUrl?: () => string | undefined;
  /** Phase 6c: override the classifier's pattern set (configurable gate policy). Defaults to the built-in set. */
  riskPatterns?: RiskPatterns;
  /**
   * S7: the human pre-grant scope store (read PULL-AT-EVAL at the gate). A risky action MATCHING a live grant
   * is authorized without a verdict wait; NO match parks. Absent (unit tests of the safe paths) ⇒ no grant ever
   * matches ⇒ every risky action parks (fail-closed).
   */
  preGrant?: PreGrantStore;
  /**
   * S7: enqueue a risky, un-granted action for the human's batch review (surfaced host-side). Called on the
   * park path; the action does NOT execute. Absent ⇒ the action still parks (the typed refusal), just not surfaced.
   */
  park?: (item: ParkedAction) => void;
  /**
   * S9 / D9: the per-origin pacing budget + authenticated-use consent gate, charged on `navigate`. Shares
   * ONE implementation with the session-drive seam (`agent-drive-gate.ts`) so the two navigation lanes
   * cannot drift into different policies. Absent (unit tests of the pre-D9 paths) ⇒ unpaced; production
   * hosts wire it, and the host-level tests assert that they do.
   */
  driveGate?: AgentDriveGate;
  /**
   * Pin 8: the post-action capability. Wired ⇒ every act that LANDS carries a settle-diff and a
   * console summary; unwired ⇒ nothing is attached. The agent can suppress it per call with
   * `post_actions: false` when it already knows what it did and wants the cheaper result.
   */
  postActions?: ActPostActionDeps;
}

/**
 * The internal result of dispatching one verb: the tool result PLUS the Phase-6c gating metadata
 * (risk tier + authorization source) when the action passed through the gate. The single audit choke
 * point records all three from here, so every gating decision is logged.
 */
interface ActResolution {
  result: StudioActOutput | StudioToolError;
  risk?: RiskTier;
  approval?: AuthSource;
  /**
   * S13-0: the durable seed for the element this act touched, built at RESOLVE time (the element is
   * live then; after a click it may be gone). Carried, not written — the choke point writes it only if
   * the action landed.
   */
  flowTarget?: StructuredTarget | null;
  /** The page's credential-field signal from the same resolve, so the recorder decides on the live scan. */
  pageHasCredentialField?: boolean;
}

/** CDP modifier bitmask for Shift. */
const SHIFT = 8;
/** Default scroll distance (page CSS px) when `amount` is unset. */
const DEFAULT_SCROLL_PX = 600;
/** Pin 8: descriptors / console lines kept inline before the remainder goes to a file. */
const POST_ACTION_SAMPLE_LIMIT = 5;
/** Pin 8: per-console-line inline cap. A page can log a megabyte; the file keeps the rest. */
const CONSOLE_LINE_CHARS = 200;
const HOLD_HINT = 'The human holds control of the shared browser — wait and re-observe before acting.';
const STANDDOWN_HINT = 'The human took control — do not retry; observe and wait your turn.';

/**
 * The CDP key events for ONE typed character, as a single balanced unit. An uppercase
 * letter is wrapped in a Shift down/up (a real held key, tracked by the forwarder so a
 * reclaim-time neutralize can release it) with the letter events carrying the Shift
 * modifier bit. Because the whole wrap is one unit, a reclaim BETWEEN units can never
 * strand a Shift — the human never inherits a stuck modifier.
 */
export function keystrokeEvents(ch: string): AgentInputEvent[] {
  const isUpper = /^[A-Z]$/.test(ch);
  const lower = ch.toLowerCase();
  // A physical key code only for letters/digits; left undefined otherwise (a symbol/space
  // char is text-only), so the `trackKey` `code == null` guard never holds it as a key.
  let code: string | undefined;
  if (/^[a-z]$/.test(lower)) code = 'Key' + lower.toUpperCase();
  else if (/^[0-9]$/.test(ch)) code = 'Digit' + ch;
  const mod = isUpper ? { modifiers: SHIFT } : {};
  const inner: AgentInputEvent[] = [
    { kind: 'key', type: 'keyDown', key: ch, code, ...mod },
    { kind: 'key', type: 'char', key: ch, text: ch, ...mod },
    { kind: 'key', type: 'keyUp', key: ch, code, ...mod },
  ];
  if (!isUpper) return inner;
  return [
    { kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft' },
    ...inner,
    { kind: 'key', type: 'keyUp', key: 'Shift', code: 'ShiftLeft' },
  ];
}

/** The mouse-down + mouse-up pair of a left click at a page-px centre — one atomic unit. */
function clickUnit(c: { x: number; y: number }): AgentInputEvent[] {
  return [
    { kind: 'mouse', type: 'mousePressed', x: c.x, y: c.y, button: 'left', buttons: 1, clickCount: 1 },
    { kind: 'mouse', type: 'mouseReleased', x: c.x, y: c.y, button: 'left', buttons: 0, clickCount: 1 },
  ];
}

/** Map a resolver refusal to a tool error the agent can act on (re-observe / ask / vision), never a wrong-element action. */
function mapResolveError(reason: ResolveErrorReason): StudioToolError {
  switch (reason) {
    case 'element_no_longer_present':
      return { error_reason: reason, hint: 'That element is no longer on the page — re-observe to get current refs.' };
    case 'element_low_confidence':
      return {
        error_reason: reason,
        hint: 'The ref is ambiguous (identical-looking siblings) — re-observe or ask the human to mark the exact one rather than guess.',
      };
    case 'element_not_visible':
      return { error_reason: reason, hint: 'The element has no on-screen box — scroll it into view, then re-observe.' };
    case 'element_occluded':
      return {
        error_reason: reason,
        hint: 'Something is covering the element (an overlay/modal/banner) — re-observe; vision can confirm what is on top.',
      };
  }
}

/** The action's recorded inputs, by verb. NO raw typed text (privacy) — the type effect rides `outcome.charsLanded`. */
function auditTarget(input: StudioActInput): AuditRecordInput['target'] {
  switch (input.action) {
    case 'navigate':
      return typeof input.url === 'string' ? { url: input.url } : undefined;
    case 'click':
    case 'type':
      return typeof input.ref === 'string' ? { ref: input.ref } : undefined;
    case 'scroll': {
      const t: { direction?: 'up' | 'down'; amount?: number } = {};
      if (input.direction) t.direction = input.direction;
      if (typeof input.amount === 'number') t.amount = input.amount;
      return Object.keys(t).length ? t : undefined;
    }
    default:
      return undefined;
  }
}

/** Map a resolved handler result to the audit outcome (success vs typed refusal/failure; carries charsLanded for type). */
function auditOutcome(result: StudioActOutput | StudioToolError): AuditOutcome {
  if ('error_reason' in result) {
    return { ok: false, error_reason: result.error_reason, ...(result.charsLanded !== undefined ? { charsLanded: result.charsLanded } : {}) };
  }
  return { ok: true, ...(result.charsLanded !== undefined ? { charsLanded: result.charsLanded } : {}) };
}

/** Neutralize + truncate one console line: page-authored text, treated exactly like an element name. */
function inertConsoleLine(m: ConsoleMessage): string {
  const text = neutralizeMarkers(m.text ?? '');
  const clipped = text.length > CONSOLE_LINE_CHARS ? `${text.slice(0, CONSOLE_LINE_CHARS)}…` : text;
  return `${m.level}: ${clipped}`;
}

/** D8b: neutralize a page-derived element descriptor's DISPLAY TEXT; `ref` passes through raw (the agent targets by it). */
function inertElement(e: SnapshotElement): SnapshotElement {
  return { ...e, role: neutralizeMarkers(e.role), name: neutralizeMarkers(e.name) };
}

export function createActHandler(
  deps: ActHandlerDeps,
): (input: StudioActInput) => Promise<StudioActOutput | StudioToolError> {
  const { browser, controlToken, grant, resolve, channel, audit, currentUrl, riskPatterns, preGrant, park, flow, held } = deps;

  const refused = (currentEpoch: number): StudioToolError => ({ error_reason: 'not_holder', hint: HOLD_HINT, currentEpoch });
  const standDown = (charsLanded?: number): StudioToolError => ({
    error_reason: 'aborted_reclaimed',
    hint: STANDDOWN_HINT,
    ...(charsLanded !== undefined ? { charsLanded } : {}),
  });
  // Slice 5a — the hard, fail-closed credential refusal (NOT an approval; login is human-only).
  const credentialRefused = (): StudioToolError => ({
    error_reason: 'credential_field_refused',
    hint: 'This is a credential field — the agent never enters credentials (login is human-only). Do not retry; hand off to the human.',
  });

  /** S7: a risky action with no matching pre-grant — parked for human batch review, NOT executed. Do-not-retry. */
  const parkedRefusal = (): StudioToolError => ({
    error_reason: 'parked_for_review',
    hint: 'This risky action has no matching human authorization — it was parked for the human to review. Continue with other work; do not retry.',
  });

  /**
   * S7 risk gate. Classify the action (deterministic, code-only — NOT an LLM, which would read untrusted
   * page content to decide). A SAFE action passes straight through. A risky one (money/credential/destructive)
   * is authorized ONLY by a matching human PRE-GRANT (read pull-at-eval); otherwise it is PARKED for the human's
   * batch review — enqueued + surfaced, the action does NOT execute, and the agent is not blocked (it continues
   * other work). FAIL-CLOSED: an empty store (the default), an unreadable domain, or a missing grant all park.
   * The control token's epoch fence still rides on the authorize path via the channel dispatch downstream.
   * Returns `{ok}` to proceed to dispatch, or `{blocked}` with the tool error + gating metadata to record.
   */
  const applyRiskGate = async (
    input: StudioActInput,
    _gateEpoch: number,
    role?: string,
    name?: string,
  ): Promise<{ ok: true; risk?: RiskTier; approval?: AuthSource } | { blocked: StudioToolError; risk: RiskTier; approval?: AuthSource }> => {
    const risk = classifyRisk({ action: input.action, pageUrl: currentUrl?.(), role, name }, riskPatterns);
    if (risk === 'safe') return { ok: true };
    const domain = deriveDomain(currentUrl?.());
    // A matching human pre-grant AUTHORIZES the action without a live verdict wait (audited as pre-grant).
    if (preGrant?.matches({ domain, actionType: input.action, riskTier: risk })) {
      return { ok: true, risk, approval: 'pre-grant' };
    }
    // No matching grant → PARK for human batch review: enqueue + surface, never execute, never block the agent.
    park?.({ action: input.action, risk, ...(domain ? { domain } : {}), ...(typeof input.ref === 'string' ? { ref: input.ref } : {}) });
    return { blocked: parkedRefusal(), risk, approval: 'parked' };
  };

  const navigate = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    const url = typeof input.url === 'string' ? input.url : '';

    // GATE before acting (host-authoritative).
    const gate = controlToken.assertCanDrive('agent');
    if (!gate.ok) return refused(gate.currentEpoch);
    // Captured BEFORE the D9 await below, so a reclaim during a grant-card wait advances the epoch past this
    // value and the beforeNavigate fence refuses the nav. Capturing it after would re-baseline on the
    // reclaim and quietly defeat the fence.
    const gateEpoch = controlToken.epoch;

    // D9: pace every origin, then require a human grant before spending their signed-in identity. This
    // introduces the one await in the gate→navigate window that the invariant below anticipates: the
    // beforeNavigate epoch fence is exactly the backstop for it, as on the click path's resolve await.
    if (deps.driveGate) {
      const d9 = await checkAgentDrive(deps.driveGate, url);
      // K6: this is a PUBLISHED envelope (studio-dispatch serializes a StudioToolError verbatim to the
      // client), so `error_reason` owes the stable machine code and the sentence goes to `error` — the
      // same two fields, doing the same two jobs, as the core failure envelope. This forward used to copy
      // the producer verdict's own `error_reason` straight across, which shipped the sentence as the code.
      if (!d9.ok) return { error_reason: d9.reason, error: d9.message, hint: d9.hint };
    }

    // INVARIANT (amended in S9): this path WAS synchronous from assertCanDrive to the CDP nav command, so a
    // reclaim could not interleave into the gate→start window at all. D9's grant card breaks that by
    // construction — a card can be open for as long as the human takes to answer — so the beforeNavigate
    // epoch fence is now the PRIMARY protection here rather than a backstop, and `gateEpoch` is captured
    // above the await for exactly that reason. Any further await inserted here inherits the same fence.
    const r = await navigateSession(browser, url, policyForHolder('agent', grant), {
      beforeNavigate: () => controlToken.holder === 'agent' && controlToken.epoch === gateEpoch,
    });

    if (!r.ok) {
      // A reclaim during the nav (entry fence OR in-flight abort) advances the epoch —
      // reclassify the failure as a stand-down so the agent does not retry into the human.
      if (controlToken.epoch !== gateEpoch) {
        return {
          error_reason: 'aborted_reclaimed',
          hint: 'The human took control during navigation — do not retry; observe and wait your turn.',
        };
      }
      const hint =
        r.reason === 'navigation_blocked'
          ? 'That address is blocked for the agent (cloud-internal is never allowed; localhost/private needs a human grant).'
          : 'Navigation did not complete — re-observe and decide your next step.';
      return { error_reason: r.reason, hint };
    }
    return { ok: true, action: 'navigate', url };
  };

  /**
   * Gate, capture the gate epoch, then resolve the ref LIVE. The resolve is the only
   * await between the gate and the dispatch; a reclaim during it advances the epoch, so
   * the unit (stamped `gateEpoch`) is dropped by the channel's fence → `aborted_reclaimed`.
   * Returns either the resolved live centre or the refusal/stand-down/resolve error to surface.
   */
  const gateAndResolve = async (
    input: StudioActInput,
  ): Promise<{ ok: true; gateEpoch: number; center: { x: number; y: number }; role?: string; name?: string; semantics?: FieldSemantics; pageHasCredentialField?: boolean; flowTarget?: StructuredTarget | null } | StudioToolError> => {
    const gate = controlToken.assertCanDrive('agent');
    if (!gate.ok) return refused(gate.currentEpoch);
    const gateEpoch = controlToken.epoch;
    const ref = typeof input.ref === 'string' ? input.ref : '';
    if (!ref) return { error_reason: 'missing_ref', hint: `${input.action} requires the \`ref\` of an element from studio_observe.` };
    // §7 row 1, read at the holder's single seam — the same verdict studio_observe reads, so the
    // two surfaces cannot disagree about whether the page is the one the agent knows. The resolver
    // below would happily find a LIVE element for this ref; that is the point of refusing here,
    // because the agent chose the ref from a page a human has since changed.
    const staleness = held?.read();
    if (staleness?.state === 'invalidated') {
      return { error_reason: 'page_changed_by_human', hint: `${PAGE_CHANGED_BY_HUMAN}: studio_observe for a fresh snapshot, then choose the ref again.` };
    }
    const resolved = await resolve(ref); // LIVE — fresh snapshot, occlusion hit-test, never cached coords
    if (isResolveError(resolved)) return mapResolveError(resolved.error);
    // S13-0: seed the flow sidecar HERE — the element is live at this instant and may be gone after
    // the dispatch. Built BEFORE the risk gate so the "only await between the gate and the dispatch"
    // invariant below stays exactly as it was. A credential context builds NOTHING (refuse-at-creation,
    // mirroring the mark path), and a seed failure is swallowed: a recording is never worth an action.
    let flowTarget: StructuredTarget | null | undefined;
    if (flow && !isCredentialRecordingContext({ pageUrl: currentUrl?.(), pageHasCredentialField: resolved.pageHasCredentialField })) {
      flowTarget = await flow.seed(resolved.backendNodeId).catch(() => null);
    }
    // role/name (page-derived, untrusted) ride along for the 6c risk gate's soft signal; the TRUE
    // pierced-DOM semantics + the page credential flag ride along for the 5a hard credential guard.
    return { ok: true, gateEpoch, center: resolved.center, role: resolved.role, name: resolved.name, semantics: resolved.semantics, pageHasCredentialField: resolved.pageHasCredentialField, flowTarget };
  };

  const clickAct = async (input: StudioActInput): Promise<ActResolution> => {
    const g = await gateAndResolve(input);
    if ('error_reason' in g) return { result: g };
    const seed = { flowTarget: g.flowTarget, pageHasCredentialField: g.pageHasCredentialField };
    // P4: the ghost cursor rides the resolved LIVE centre (viewport CSS px — same space the overlay draws in).
    channel.announce?.({ t: 'point', center: g.center, caption: input.narration ?? '' });
    const gate = await applyRiskGate(input, g.gateEpoch, g.role, g.name);
    if ('blocked' in gate) return { result: gate.blocked, risk: gate.risk, approval: gate.approval, ...seed };
    const landed = await channel.dispatchAgentUnit(g.gateEpoch, clickUnit(g.center));
    if (!landed) return { result: standDown(), risk: gate.risk, approval: gate.approval, ...seed };
    return { result: { ok: true, action: 'click' }, risk: gate.risk, approval: gate.approval, ...seed };
  };

  const typeAct = async (input: StudioActInput): Promise<ActResolution> => {
    const g = await gateAndResolve(input);
    if ('error_reason' in g) return { result: g };
    const seed = { flowTarget: g.flowTarget, pageHasCredentialField: g.pageHasCredentialField };
    // P4: ghost cursor at the resolved centre (the point payload carries only coords + agent caption — a
    // credential-page type is still refused below, and no page-derived field ever rides this event).
    channel.announce?.({ t: 'point', center: g.center, caption: input.narration ?? '' });
    // Slice 5a — the HARD credential-input refusal, BEFORE the risk gate and before focus.
    // Fail-closed, NOT approval-gated (HANDOFF §2/§4: login is human-only). Decides on the resolved
    // element's TRUE pierced-DOM semantics (never the spoofable a11y name), so a password field with a
    // blank/forged label is still caught; an unresolvable target in a credential context fails closed.
    if (refuseAgentType({ target: g.semantics, pageUrl: currentUrl?.(), pageHasCredentialField: g.pageHasCredentialField })) {
      return { result: credentialRefused(), ...seed };
    }
    // Gate BEFORE focusing/typing — a credential-context type must not even focus the field unapproved.
    const gate = await applyRiskGate(input, g.gateEpoch, g.role, g.name);
    if ('blocked' in gate) return { result: gate.blocked, risk: gate.risk, approval: gate.approval, ...seed };
    const meta = { risk: gate.risk, approval: gate.approval, ...seed };
    const text = typeof input.text === 'string' ? input.text : '';
    // Focus the resolved element with a gated click at its centre (same channel, abortable).
    const focused = await channel.dispatchAgentUnit(g.gateEpoch, clickUnit(g.center));
    if (!focused) return { result: standDown(0), ...meta };
    let charsLanded = 0;
    for (const ch of text) {
      // Per-unit re-check IS the channel's epoch fence: a reclaim mid-type advances the
      // epoch, so the next keystroke unit is dropped — we stop and report what landed.
      const landed = await channel.dispatchAgentUnit(g.gateEpoch, keystrokeEvents(ch));
      if (!landed) return { result: standDown(charsLanded), ...meta };
      charsLanded++;
    }
    return { result: { ok: true, action: 'type', charsLanded }, ...meta };
  };

  const scrollAct = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    const gate = controlToken.assertCanDrive('agent');
    if (!gate.ok) return refused(gate.currentEpoch);
    const gateEpoch = controlToken.epoch;
    const amount =
      typeof input.amount === 'number' && Number.isFinite(input.amount) ? Math.abs(input.amount) : DEFAULT_SCROLL_PX;
    const deltaY = (input.direction === 'up' ? -1 : 1) * amount;
    const c = channel.viewportCenter();
    channel.announce?.({ t: 'point', center: c, caption: input.narration ?? '' }); // P4 ghost cursor at the scroll aim
    // A single wheel event — inherently one atomic unit. (A future multi-step scroll loop
    // would re-check the fence per step, like type.)
    const landed = await channel.dispatchAgentUnit(gateEpoch, [
      { kind: 'mouse', type: 'mouseWheel', x: c.x, y: c.y, deltaX: 0, deltaY },
    ]);
    if (!landed) return standDown();
    return { ok: true, action: 'scroll' };
  };

  const dispatch = async (input: StudioActInput): Promise<ActResolution> => {
    switch (input.action) {
      // navigate + scroll are never gated (navigation safety is the SSRF guard's job; scrolling is
      // not a money/credential/destructive act) — wrap their raw result with no gating metadata.
      case 'navigate':
        return { result: await navigate(input) };
      case 'click':
        return clickAct(input);
      case 'type':
        return typeAct(input);
      case 'scroll':
        return { result: await scrollAct(input) };
      default:
        // Fail loud — don't pretend an unknown verb succeeded.
        return {
          result: {
            error_reason: 'action_not_supported',
            hint: `studio_act supports navigate|click|type|scroll; '${String((input as { action?: unknown }).action)}' is not a known action.`,
          },
        };
    }
  };

  // Every agent action + its resolved outcome lands in the per-session APPEND-ONLY audit
  // log (Phase 6b) — successes, refusals, AND unknown verbs alike, never silently dropped —
  // for trust + the Phase-7 DISPLAY timeline. Phase 6c adds the gating decision (risk tier +
  // approval) on a gated action, recorded through this SAME single choke point so every gate
  // decision is logged from commit one. The optional-chain leaves the args unevaluated when no
  // log is wired (the unit tests that omit it).
  /**
   * Pin 8: build the post-action block. Notify-only, exactly like `audit` and `flow` — a snapshot that
   * throws, a console drain that throws, or a disk that is full must never turn an action that LANDED
   * into an error the agent would retry, so every failure here degrades to "no post-actions".
   */
  const collectPostActions = async (): Promise<ActPostActions | undefined> => {
    const pa = deps.postActions;
    if (!pa) return undefined;
    try {
      await pa.settle?.();
      const snap = await pa.snapshot();
      const messages = pa.consoleSince?.() ?? [];
      const errors = messages.filter((m) => m.level === 'error').length;
      const warnings = messages.filter((m) => m.level === 'warning').length;
      const notice = { trusted: false as const, untrusted_notice: UNTRUSTED_STUDIO_NOTICE };
      // A login wall / 2FA screen: an element name or a console line can BE the secret on display, so
      // the text is withheld and only the shape is reported. Same predicate, same fields, as the
      // observe and capture exclusions — one credential-context decision, not a third opinion.
      if (isCredentialContext({ pageUrl: currentUrl?.(), fields: snap.domByRef?.values() })) {
        return {
          ...notice,
          settled: { base: 'none', added: 0, removed: 0, changed: 0, churn: 0, excluded: 'credential_context' },
          console: { errors, warnings, excluded: 'credential_context' },
        };
      }
      const limit = pa.sampleLimit ?? POST_ACTION_SAMPLE_LIMIT;
      const fileOpts = { dataDir: pa.dataDir, runId: pa.runId?.() };
      const heldRead = held?.read();
      const prev = heldRead?.state === 'live' ? heldRead.snapshot : null;
      const delta = prev ? diffSnapshots(prev, snap) : null;
      const added = (delta ? delta.added : snap.elements).map(inertElement);
      const removed = (delta ? delta.removed : []).map(inertElement);
      const changed = (delta ? delta.changed : []).map(inertElement);
      const churn = delta ? delta.lowConfidenceChurn.added.length + delta.lowConfidenceChurn.removed.length : 0;
      const sample = [...added, ...changed].slice(0, limit);
      const total = added.length + removed.length + changed.length;
      // The FILE holds the whole delta with its attribution intact (added vs removed vs changed), not
      // the tail of a flattened list — a reader should never have to reassemble an excerpt.
      const spill =
        total > limit ? writeLargeOutput({ added, removed, changed }, { ...fileOpts, kind: 'settle-diff' }) : null;
      const consoleFit = excerptToFile(messages.map(inertConsoleLine), limit, { ...fileOpts, kind: 'console' });
      return {
        ...notice,
        settled: {
          base: prev ? 'held' : 'none',
          added: added.length,
          removed: removed.length,
          changed: changed.length,
          churn,
          sample,
          ...(spill ? { spilled: total - sample.length, file: spill.file } : {}),
        },
        console: {
          errors,
          warnings,
          sample: consoleFit.inline,
          ...(consoleFit.file ? { spilled: consoleFit.spilled, file: consoleFit.file } : {}),
        },
      };
    } catch {
      return undefined;
    }
  };

  return async (
    input: StudioActInput & { post_actions?: boolean },
  ): Promise<(StudioActOutput & { post_actions?: ActPostActions }) | StudioToolError> => {
    // P4: narrate the agent's intent to the human UNCONDITIONALLY, before the act runs — matching the
    // salvaged narration contract (broadcast regardless of the verdict, so a refused/preempted act still
    // names its step in the drive banner). Agent-authored text only; never page-derived.
    channel.announce?.({ t: 'act', action: typeof input.action === 'string' ? input.action : String((input as { action?: unknown }).action), ...(input.narration ? { narration: input.narration } : {}) });
    const action = typeof input.action === 'string' ? input.action : String((input as { action?: unknown }).action);
    // Read the page BEFORE the act: a click can navigate, and a step recorded against the page the
    // agent LANDED on would replay against the wrong document.
    const pageUrlAtStart = currentUrl?.();
    const { result, risk, approval, flowTarget, pageHasCredentialField } = await dispatch(input);
    const entry = audit?.record({
      action,
      epoch: controlToken.epoch,
      target: auditTarget(input),
      outcome: auditOutcome(result),
      ...(risk ? { risk } : {}),
      ...(approval ? { approval } : {}),
    });
    // S13-0: the flow sidecar records only what LANDED, and only what the audit already recorded —
    // it is a derived artefact, never a second forensic record. Notify-only: it cannot fail the act.
    if (flow && !('error_reason' in result)) {
      flow.record({
        action,
        ...(entry && typeof entry.seq === 'number' ? { auditSeq: entry.seq } : {}),
        ...(action === 'navigate'
          ? { pageUrl: typeof input.url === 'string' ? input.url : undefined }
          : { pageUrl: pageUrlAtStart }),
        ...(flowTarget !== undefined ? { target: flowTarget } : {}),
        ...(typeof input.ref === 'string' ? { recordedRef: input.ref } : {}),
        ...(input.direction ? { direction: input.direction } : {}),
        ...(typeof input.amount === 'number' ? { amount: input.amount } : {}),
        ...(pageHasCredentialField !== undefined ? { pageHasCredentialField } : {}),
      });
    }
    // Pin 8: post-actions ride ONLY a landed act. A refusal changed nothing on the page, so a delta
    // against it would report the page's own drift as if the agent had caused it, and the agent's
    // next decision is "why was I refused", not "what did the page become".
    if ('error_reason' in result) return result;
    if (input.post_actions === false) return result;
    const post_actions = await collectPostActions();
    if (!post_actions) return result;
    const enriched: StudioActOutput & { post_actions: ActPostActions } = { ...result, post_actions };
    return enriched;
  };
}
