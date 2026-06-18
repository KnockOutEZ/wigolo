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

export function createActHandler(
  deps: ActHandlerDeps,
): (input: StudioActInput) => Promise<StudioActOutput | StudioToolError> {
  const { browser, controlToken, grant, resolve, channel } = deps;

  const refused = (currentEpoch: number): StudioToolError => ({ error_reason: 'not_holder', hint: HOLD_HINT, currentEpoch });
  const standDown = (charsLanded?: number): StudioToolError => ({
    error_reason: 'aborted_reclaimed',
    hint: STANDDOWN_HINT,
    ...(charsLanded !== undefined ? { charsLanded } : {}),
  });

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
  ): Promise<{ ok: true; gateEpoch: number; center: { x: number; y: number } } | StudioToolError> => {
    const gate = controlToken.assertCanDrive('agent');
    if (!gate.ok) return refused(gate.currentEpoch);
    const gateEpoch = controlToken.epoch;
    const ref = typeof input.ref === 'string' ? input.ref : '';
    if (!ref) return { error_reason: 'missing_ref', hint: `${input.action} requires the \`ref\` of an element from studio_observe.` };
    const resolved = await resolve(ref); // LIVE — fresh snapshot, occlusion hit-test, never cached coords
    if (isResolveError(resolved)) return mapResolveError(resolved.error);
    return { ok: true, gateEpoch, center: resolved.center };
  };

  const clickAct = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    const g = await gateAndResolve(input);
    if ('error_reason' in g) return g;
    const landed = await channel.dispatchAgentUnit(g.gateEpoch, clickUnit(g.center));
    if (!landed) return standDown();
    return { ok: true, action: 'click' };
  };

  const typeAct = async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    const g = await gateAndResolve(input);
    if ('error_reason' in g) return g;
    const text = typeof input.text === 'string' ? input.text : '';
    // Focus the resolved element with a gated click at its centre (same channel, abortable).
    const focused = await channel.dispatchAgentUnit(g.gateEpoch, clickUnit(g.center));
    if (!focused) return standDown(0);
    let charsLanded = 0;
    for (const ch of text) {
      // Per-unit re-check IS the channel's epoch fence: a reclaim mid-type advances the
      // epoch, so the next keystroke unit is dropped — we stop and report what landed.
      const landed = await channel.dispatchAgentUnit(g.gateEpoch, keystrokeEvents(ch));
      if (!landed) return standDown(charsLanded);
      charsLanded++;
    }
    return { ok: true, action: 'type', charsLanded };
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

  return async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    switch (input.action) {
      case 'navigate':
        return navigate(input);
      case 'click':
        return clickAct(input);
      case 'type':
        return typeAct(input);
      case 'scroll':
        return scrollAct(input);
      default:
        // Fail loud — don't pretend an unknown verb succeeded.
        return {
          error_reason: 'action_not_supported',
          hint: `studio_act supports navigate|click|type|scroll; '${String((input as { action?: unknown }).action)}' is not a known action.`,
        };
    }
  };
}
