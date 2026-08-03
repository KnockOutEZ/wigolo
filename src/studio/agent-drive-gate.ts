import type { ApprovalDecision } from './approvals.js';
import { budgetOrigin, type OriginBudget, type OriginClass } from './origin-budget.js';
import type { PreGrantStore } from './pre-grant.js';
import type { EscalationCounterKey } from './escalation-counters.js';

/**
 * S9 / D9 — the single gate every agent-driven navigation passes, and the reason the two halves of D9 are
 * written here together rather than at their call sites: keeping the ORDER in one place is what makes the
 * decoupling real.
 *
 *   1. F5     — evaluated ONCE. Absent or throwing is UNKNOWN: tight lane, but no card.
 *   2. BUDGET — charged for EVERY origin, authenticated or not, always with a finite limit.
 *   3. CARD   — only for an origin the human is signed in to, only on first agent use per session.
 *
 * The predicate now runs first, because it selects WHICH budget lane applies — signed-in origins stay tight
 * because the cost of over-driving them is the human's account, anonymous origins get a few hundred because
 * the cost there is a rate-limit. That is a deliberate amendment to the original "the budget never consults
 * the predicate" rule, and the property that rule protected is preserved directly instead:
 *
 *   - the budget is charged on EVERY path, including when the predicate throws;
 *   - every lane has a finite limit, so no verdict can turn the rail off;
 *   - ignorance resolves to the TIGHT lane, so a predicate failure can only tighten, never loosen.
 *
 * Those three are asserted on the failure modes themselves, which is stronger than the call-order assertion
 * they replace — order was only ever a proxy for them, and it is no longer even the right proxy.
 *
 * UNATTENDED CONTEXTS FAIL FAST. When no approval surface is attached — an MCP server with no Studio window,
 * a scheduled run, an agent-spawned background session — the card does not wait out its timeout. It refuses
 * immediately with a summon hint. Waiting on a card nobody can see is a hang, not a safety property: the
 * agent learns nothing at minute two that it did not know in millisecond one, and the caller pays the whole
 * timeout for it. The security posture is identical either way (no grant, no drive, degraded result path).
 * An UNKNOWN attachment state counts as unattended, because the failure mode of guessing "attached" is
 * exactly the hang this rule removes.
 */

/** Why a navigation was refused. `blocked_by_challenge` is deliberate: the agent already handles that path. */
export type AgentDriveRefusal =
  | { reason: 'origin_budget_exhausted'; error_reason: string; hint: string }
  | { reason: 'blocked_by_challenge'; error_reason: string; hint: string };

export type AgentDriveVerdict = { ok: true } | ({ ok: false } & AgentDriveRefusal);

export interface AgentDriveGate {
  /** The session's per-origin pacing budget. */
  budget: OriginBudget;
  /**
   * F5, evaluated HOST-SIDE. Returns a boolean and nothing else — no cookie, no name, no reason object.
   *
   * Absent ⇒ the card never fires, and the budget uses the TIGHT lane. Those two go in opposite directions
   * on purpose: with no predicate there is no basis to prompt a human, and no basis to relax pacing either.
   */
  isAuthenticatedOrigin?: (origin: string) => boolean | Promise<boolean>;
  /** The session's pre-grant store, holding this session's approved signed-in origins. */
  preGrant?: PreGrantStore;
  /**
   * Is a live approval surface attached — a human who can actually see and answer a card? FAIL-CLOSED:
   * absent counts as unattended, so a host that forgets to wire it fails fast instead of hanging.
   */
  approvalSurfaceAttached?: () => boolean;
  /** Ask the human. Only an explicit `approved` fires (approvals.ts is fail-closed by construction). */
  requestApproval?: (origin: string) => Promise<ApprovalDecision>;
  /** D10(a) local counters. Best-effort; never load-bearing. */
  bump?: (key: EscalationCounterKey) => void;
  /**
   * How long the predicate may take before it counts as UNKNOWN. The predicate reads a live cookie jar
   * and, in the app host, evaluates script in the tab — reads that can stall rather than reject while a
   * navigation is in flight. This gate is on the critical path of EVERY agent navigation, so an
   * unbounded await here wedges the navigation itself. Measured: it did, in a live e2e.
   */
  predicateTimeoutMs?: number;
}

/** Reject after `ms` so a stalled read degrades to `unknown` instead of holding the gate open. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('predicate timed out')), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SUMMON_HINT =
  'This site needs the human to allow signed-in use for this session. Ask them to open the browser session and approve it, or use a source that does not need a sign-in.';

function budgetExhausted(used: number, limit: number, origin: string): AgentDriveVerdict {
  return {
    ok: false,
    reason: 'origin_budget_exhausted',
    error_reason: `This session has already made ${used} of ${limit} allowed requests to ${origin}.`,
    hint: 'Pacing protects the account from looking automated. Work with what you have, use a different source, or ask the human to raise the per-origin budget.',
  };
}

function needsGrant(origin: string, why: string): AgentDriveVerdict {
  return {
    ok: false,
    reason: 'blocked_by_challenge',
    error_reason: `Agent use of the signed-in site ${origin} is not allowed in this session (${why}).`,
    hint: SUMMON_HINT,
  };
}

/**
 * Classify the origin, charge the budget against the matching lane, then require an authenticated-use grant
 * if the origin is one the human is signed in to. A URL with no parseable origin passes: it cannot be
 * attributed, and the SSRF fence downstream is what rejects an address the agent should not reach.
 */
export async function checkAgentDrive(gate: AgentDriveGate, url: string): Promise<AgentDriveVerdict> {
  const origin = budgetOrigin(url);
  if (!origin) return { ok: true };

  // ONE evaluation, used for both the lane and the card. Two calls could disagree — a cookie jar read is
  // not pure — and a navigation charged as anonymous but carded as signed in is incoherent.
  //
  // Three outcomes, not two, and they do NOT resolve the same way for the two decisions:
  //   verdict true   → tight lane, card fires.
  //   verdict false  → anonymous lane, no card.
  //   unknown        → tight lane, NO card. Absent predicate and thrown predicate are both this case.
  // Unknown splits deliberately. Pacing has to assume the expensive possibility, but prompting a human on
  // the strength of a failed cookie read would nag on every transient jar error and teach them to click
  // through — which costs more safety than the prompt buys.
  // BOUNDED, and the bound is not defensive padding. The predicate reads a live cookie jar and (in the
  // app host) evaluates script in the tab; both can STALL rather than reject while a navigation is in
  // flight, and neither rejecting nor resolving means this gate never returns — which wedges the
  // navigation it is gating. A stall is simply another way of not knowing, so it resolves like every
  // other unknown: tight lane, no card.
  let verdict: boolean | 'unknown';
  try {
    verdict = gate.isAuthenticatedOrigin
      ? await withTimeout(Promise.resolve(gate.isAuthenticatedOrigin(origin)), gate.predicateTimeoutMs ?? 3000)
      : 'unknown';
  } catch {
    verdict = 'unknown';
  }
  const carded = verdict === true;
  const originClass: OriginClass = verdict === false ? 'anonymous' : 'authenticated';

  const spend = gate.budget.spend(url, { originClass });
  if (!spend.ok) {
    gate.bump?.('budgetRefused');
    return budgetExhausted(spend.used, spend.limit, spend.origin);
  }

  if (!carded) return { ok: true };

  // Already approved this session ⇒ the card fires ONCE per origin per session, not once per request.
  if (gate.preGrant?.hasAuthenticatedUse(origin)) return { ok: true };

  // Unattended ⇒ refuse NOW. Fail-closed on an unwired probe.
  if (!gate.approvalSurfaceAttached?.() || !gate.requestApproval) {
    gate.bump?.('cardUnattended');
    return needsGrant(origin, 'nobody is attached to approve it');
  }

  gate.bump?.('cardShown');
  const decision = await gate.requestApproval(origin);
  if (decision === 'approved') {
    gate.bump?.('cardApproved');
    // The human said yes for this session. Recorded on the SAME store the human channel writes, so this is
    // not a new writer — it is the outcome of a human decision being remembered for the session's lifetime.
    gate.preGrant?.allowAuthenticatedUse(origin);
    return { ok: true };
  }
  gate.bump?.('cardRefused');
  return needsGrant(origin, decision === 'refused' ? 'the human declined' : `the request ended as ${decision}`);
}
