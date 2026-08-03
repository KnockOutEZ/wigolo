import type { ApprovalDecision } from './approvals.js';
import { budgetOrigin, type OriginBudget } from './origin-budget.js';
import type { PreGrantStore } from './pre-grant.js';
import type { EscalationCounterKey } from './escalation-counters.js';

/**
 * S9 / D9 — the single gate every agent-driven navigation passes, and the reason the two halves of D9 are
 * written here together rather than at their call sites: keeping the ORDER in one place is what makes the
 * decoupling real.
 *
 *   1. BUDGET — charged for EVERY origin, authenticated or not, and it never consults the predicate.
 *   2. CARD   — only for an origin the human is signed in to, only on first agent use per session.
 *
 * Running the budget first is not cosmetic. The budget is the rail that bounds how much damage a runaway
 * agent can do to an account's standing, and it has to hold even when the authenticated-origin predicate is
 * wrong. If the card ran first, a predicate false negative would skip straight past both.
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
   * Absent ⇒ no origin is treated as signed in ⇒ the card never fires (the budget still does).
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
 * Charge the budget, then require an authenticated-use grant if the origin is one the human is signed in to.
 * A URL with no parseable origin passes: it cannot be attributed, and the SSRF fence downstream is what
 * rejects an address the agent should not reach.
 */
export async function checkAgentDrive(gate: AgentDriveGate, url: string): Promise<AgentDriveVerdict> {
  const origin = budgetOrigin(url);
  if (!origin) return { ok: true };

  const spend = gate.budget.spend(url);
  if (!spend.ok) {
    gate.bump?.('budgetRefused');
    return budgetExhausted(spend.used, spend.limit, spend.origin);
  }

  const authenticated = (await gate.isAuthenticatedOrigin?.(origin)) ?? false;
  if (!authenticated) return { ok: true };

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
