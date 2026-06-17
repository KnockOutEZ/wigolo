import type { ControlParty } from './control-token.js';
import type { NavPolicy } from './nav.js';

/**
 * Per-session navigation grant. Two independent allowances so the human path keeps
 * its co-browse default while the agent stays fail-closed:
 *  - `humanAllowPrivate` — the human may reach localhost/RFC1918 (default true).
 *  - `agentAllowPrivate` — the agent may reach localhost/RFC1918, default FALSE.
 *    Lifted ONLY by an explicit, human-issued, revocable per-session grant; it
 *    relaxes loopback/RFC1918 alone — cloud-metadata / link-local is blocked by
 *    `guardNavigation` BEFORE this flag is consulted, so the grant can never open
 *    an SSRF lane to 169.254.169.254 or a cloud-internal alias.
 */
export interface NavGrant {
  humanAllowPrivate: boolean;
  agentAllowPrivate: boolean;
}

/**
 * Map the current control-token holder to the navigation policy its hops are judged
 * under. The interceptor PULLS this at every hop-evaluation (not a re-arm on flip),
 * so a holder change takes effect on the very next hop with no transition window:
 * the instant the agent holds, its nav is judged under the agent policy (blocked by
 * default), never the more-permissive human policy that was active a moment earlier.
 */
export function policyForHolder(holder: ControlParty, grant: NavGrant): NavPolicy {
  return holder === 'human'
    ? { source: 'human', allowPrivate: grant.humanAllowPrivate }
    : { source: 'agent', allowPrivate: grant.agentAllowPrivate };
}
