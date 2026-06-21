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
import { policyForHolder, type NavGrant } from './nav-policy.js';
import type { ControlParty } from './control-token.js';
import type { AgentInputEvent } from './input.js';
import { isResolveError, type ResolveResult, type ResolveErrorReason } from './perception/resolve.js';
import type { StudioActInput, StudioActOutput, StudioToolError } from '../daemon/studio-dispatch.js';
import type { AuditRecordInput, AuditOutcome } from './audit.js';
import { classifyRisk, type RiskTier, type RiskPatterns } from './risk.js';
import type { ApprovalDecision, ApprovalRequest } from './approvals.js';
import { refuseAgentType, type FieldSemantics } from './credential.js';

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
  /** Phase 6b: the per-session append-only audit log; every action + outcome is recorded for trust + replay. Optional so the unit tests can omit it. */
  audit?: { record(input: AuditRecordInput): void };
  /**
   * Phase 6c: the host↔human approval gate. A risky action (money/credential/destructive per the
   * deterministic classifier) is HELD for human approval before firing. Optional so unit tests of
   * the safe paths can omit it — but a RISKY action with no gate wired is refused (fail-closed),
   * never fired.
   */
  approvals?: { request(req: ApprovalRequest): Promise<ApprovalDecision> };
  /** Phase 6c: the live page URL (host-observed) — the HARD signal the risk classifier weights over the page-controlled element role/name. */
  currentUrl?: () => string | undefined;
  /** Phase 6c: override the classifier's pattern set (configurable gate policy). Defaults to the built-in set. */
  riskPatterns?: RiskPatterns;
}

/**
 * The internal result of dispatching one verb: the tool result PLUS the Phase-6c gating metadata
 * (risk tier + approval decision) when the action passed through the gate. The single audit choke
 * point records all three from here, so every gating decision is logged.
 */
interface ActResolution {
  result: StudioActOutput | StudioToolError;
  risk?: RiskTier;
  approval?: ApprovalDecision;
}

/** CDP modifier bitmask for Shift. */
const SHIFT = 8;
/** Default scroll distance (page CSS px) when `amount` is unset. */
const DEFAULT_SCROLL_PX = 600;
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

export function createActHandler(
  deps: ActHandlerDeps,
): (input: StudioActInput) => Promise<StudioActOutput | StudioToolError> {
  const { browser, controlToken, grant, resolve, channel, audit, approvals, currentUrl, riskPatterns } = deps;

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

  /** Map a non-approval verdict to the tool error the agent sees (do-not-retry hints; never a wrong/silent fire). */
  const approvalRefusal = (decision: ApprovalDecision): StudioToolError => {
    if (decision === 'refused')
      return { error_reason: 'approval_refused', hint: 'The human declined this action — do not retry; ask or take a different step.' };
    if (decision === 'timeout')
      return { error_reason: 'approval_timeout', hint: 'The human did not approve this risky action in time — do not retry automatically; ask.' };
    // 'superseded' is normally caught earlier by the epoch fence (a reclaim advanced the epoch); map it to the same stand-down.
    return standDown();
  };

  /**
   * Phase 6c risk gate. Classify the action (deterministic, code-only — NOT an LLM, which would
   * read untrusted page content to decide). A SAFE action passes straight through. A risky one
   * (money/credential/destructive) is HELD for human approval and composed with the 2J epoch fence:
   *   - FAIL-CLOSED: a risky action with no gate wired is refused, never fired.
   *   - pre-wait fence: if the grant was already revoked, drop without prompting (no doomed prompt).
   *   - post-wait fence (the hard composition): a reclaim DURING the wait advances the epoch → the
   *     human has taken over → never fire the held action, even if it was approved (a late approval
   *     for a now-stale epoch must not fire into a context the human has since changed).
   * Returns `{ok}` to proceed to dispatch, or `{blocked}` with the tool error + gating metadata to record.
   */
  const applyRiskGate = async (
    input: StudioActInput,
    gateEpoch: number,
    role?: string,
    name?: string,
  ): Promise<{ ok: true; risk?: RiskTier; approval?: ApprovalDecision } | { blocked: StudioToolError; risk: RiskTier; approval?: ApprovalDecision }> => {
    const risk = classifyRisk({ action: input.action, pageUrl: currentUrl?.(), role, name }, riskPatterns);
    if (risk === 'safe') return { ok: true };
    if (!approvals)
      return {
        blocked: { error_reason: 'approval_unavailable', hint: 'This action needs human approval but no approval channel is connected — open the studio UI.' },
        risk,
      };
    // Pre-wait fence: don't prompt the human for an action whose grant is already gone.
    if (controlToken.holder !== 'agent' || controlToken.epoch !== gateEpoch) return { blocked: standDown(), risk };
    const target = typeof input.ref === 'string' ? { ref: input.ref } : undefined;
    const approval = await approvals.request({ action: input.action, risk, ...(target ? { target } : {}) });
    // POST-WAIT EPOCH FENCE: a reclaim during the wait advanced the epoch → never fire the stale action.
    if (controlToken.holder !== 'agent' || controlToken.epoch !== gateEpoch) return { blocked: standDown(), risk, approval };
    if (approval !== 'approved') return { blocked: approvalRefusal(approval), risk, approval };
    return { ok: true, risk, approval };
  };

  const navigate = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    const url = typeof input.url === 'string' ? input.url : '';

    // GATE before acting (host-authoritative).
    const gate = controlToken.assertCanDrive('agent');
    if (!gate.ok) return refused(gate.currentEpoch);
    const gateEpoch = controlToken.epoch;

    // INVARIANT: this gate→navigate path MUST stay synchronous up to navigateSession —
    // there is no await between assertCanDrive above and the CDP nav command, so on the
    // single-threaded host a reclaim cannot interleave into the gate→start window. The
    // beforeNavigate epoch fence below is the BACKSTOP: if a future edit introduces an
    // await here, the fence still refuses a nav whose grant was revoked mid-window.
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
  ): Promise<{ ok: true; gateEpoch: number; center: { x: number; y: number }; role?: string; name?: string; semantics?: FieldSemantics; pageHasCredentialField?: boolean } | StudioToolError> => {
    const gate = controlToken.assertCanDrive('agent');
    if (!gate.ok) return refused(gate.currentEpoch);
    const gateEpoch = controlToken.epoch;
    const ref = typeof input.ref === 'string' ? input.ref : '';
    if (!ref) return { error_reason: 'missing_ref', hint: `${input.action} requires the \`ref\` of an element from studio_observe.` };
    const resolved = await resolve(ref); // LIVE — fresh snapshot, occlusion hit-test, never cached coords
    if (isResolveError(resolved)) return mapResolveError(resolved.error);
    // role/name (page-derived, untrusted) ride along for the 6c risk gate's soft signal; the TRUE
    // pierced-DOM semantics + the page credential flag ride along for the 5a hard credential guard.
    return { ok: true, gateEpoch, center: resolved.center, role: resolved.role, name: resolved.name, semantics: resolved.semantics, pageHasCredentialField: resolved.pageHasCredentialField };
  };

  const clickAct = async (input: StudioActInput): Promise<ActResolution> => {
    const g = await gateAndResolve(input);
    if ('error_reason' in g) return { result: g };
    const gate = await applyRiskGate(input, g.gateEpoch, g.role, g.name);
    if ('blocked' in gate) return { result: gate.blocked, risk: gate.risk, approval: gate.approval };
    const landed = await channel.dispatchAgentUnit(g.gateEpoch, clickUnit(g.center));
    if (!landed) return { result: standDown(), risk: gate.risk, approval: gate.approval };
    return { result: { ok: true, action: 'click' }, risk: gate.risk, approval: gate.approval };
  };

  const typeAct = async (input: StudioActInput): Promise<ActResolution> => {
    const g = await gateAndResolve(input);
    if ('error_reason' in g) return { result: g };
    // Slice 5a — the HARD credential-input refusal, BEFORE the approval gate and before focus.
    // Fail-closed, NOT approval-gated (HANDOFF §2/§4: login is human-only). Decides on the resolved
    // element's TRUE pierced-DOM semantics (never the spoofable a11y name), so a password field with a
    // blank/forged label is still caught; an unresolvable target in a credential context fails closed.
    if (refuseAgentType({ target: g.semantics, pageUrl: currentUrl?.(), pageHasCredentialField: g.pageHasCredentialField })) {
      return { result: credentialRefused() };
    }
    // Gate BEFORE focusing/typing — a credential-context type must not even focus the field unapproved.
    const gate = await applyRiskGate(input, g.gateEpoch, g.role, g.name);
    if ('blocked' in gate) return { result: gate.blocked, risk: gate.risk, approval: gate.approval };
    const meta = { risk: gate.risk, approval: gate.approval };
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
  // for trust + the Phase-7 replay timeline. Phase 6c adds the gating decision (risk tier +
  // approval) on a gated action, recorded through this SAME single choke point so every gate
  // decision is logged from commit one. The optional-chain leaves the args unevaluated when no
  // log is wired (the unit tests that omit it).
  return async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    const { result, risk, approval } = await dispatch(input);
    audit?.record({
      action: typeof input.action === 'string' ? input.action : String((input as { action?: unknown }).action),
      epoch: controlToken.epoch,
      target: auditTarget(input),
      outcome: auditOutcome(result),
      ...(risk ? { risk } : {}),
      ...(approval ? { approval } : {}),
    });
    return result;
  };
}
