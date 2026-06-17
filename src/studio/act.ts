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
import type { StudioActInput, StudioActOutput, StudioToolError } from '../daemon/studio-dispatch.js';

/** The narrow view of the control token the act handler needs (the real ControlToken satisfies it). */
export interface ActControlToken {
  readonly holder: ControlParty;
  readonly epoch: number;
  assertCanDrive(party: ControlParty): { ok: true } | { ok: false; reason: string; currentEpoch: number };
}

export interface ActHandlerDeps {
  browser: NavigableBrowser;
  controlToken: ActControlToken;
  /** The SINGLE source of nav policy — the same grant object the interceptor reads, so the entry guard and per-hop guard agree by construction. */
  grant: NavGrant;
}

export function createActHandler(
  deps: ActHandlerDeps,
): (input: StudioActInput) => Promise<StudioActOutput | StudioToolError> {
  const { browser, controlToken, grant } = deps;

  return async (input: StudioActInput): Promise<StudioActOutput | StudioToolError> => {
    if (input.action !== 'navigate') {
      // Fail loud — don't pretend an unimplemented verb succeeded.
      return {
        error_reason: 'action_not_supported',
        hint: `studio_act currently supports 'navigate'; '${input.action}' arrives in a later slice.`,
      };
    }
    const url = typeof input.url === 'string' ? input.url : '';

    // GATE before acting (host-authoritative).
    const gate = controlToken.assertCanDrive('agent');
    if (!gate.ok) {
      return {
        error_reason: 'not_holder',
        hint: 'The human holds control of the shared browser — wait and re-observe before acting.',
        currentEpoch: gate.currentEpoch,
      };
    }
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
}
