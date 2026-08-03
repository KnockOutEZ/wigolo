import type { ChallengeClass } from '../types.js';
import type { ApprovalDecision } from './approvals.js';
import type { ClearanceCookie } from './../fetch/challenge-completion.js';
import type { EscalationCounterKey } from './escalation-counters.js';

/**
 * S9B slice 2 — the human-solve request.
 *
 * THE CAPABILITY: "open this gated page for me now." A human, on their own machine, opens a door an
 * automated fetch could not.
 *
 * WHY THIS EXISTS WHEN CORE ALREADY HAS A HUMAN-SOLVE RUNG. `human-solve.ts` is shipped AND called
 * (`browser-pool.ts:1433`) — the "ships dark" premise in the brief is wrong. But it asks the human to
 * solve in a **Playwright-headful** window, which is the exact launch mode measured to report
 * `navigator.webdriver === true` and flip BotD to `headless_chrome`. So the product's current answer to
 * "a human must solve this" is *solve it in a browser that has already announced itself as automated.*
 * The Studio substrate is the one surface in this repo that measured clean (BotD `bot:false`, rebrowser
 * green on every automation probe, CreepJS 0% headless / 0% stealth / no lies panel). This module
 * re-points the solve moment there. It is wiring, not new machinery.
 *
 * SCOPE, MEASURED RATHER THAN ASSUMED. Only `interactive` and `image` are solvable: `solve-ladder.ts`
 * returns UNSOLVED before any rung for `behavioral` and `none`. On 2026-08-03 every hard wall on the
 * walled-target set was `behavioral`, and no interactive challenge could be induced on five Cloudflare
 * zones — most plausibly because the substrate reads clean. The class gate below is therefore the
 * honest boundary of the phase, not a formality.
 *
 * PURE + INJECTED, mirroring `human-solve.ts` / `challenge-completion.ts`: no browser, no Electron, no
 * store, no config read. Everything the host owns arrives as a dependency.
 *
 * THE CLEARANCE VALUE IS STRUCTURALLY UNREACHABLE FROM THE RETURN. The harvested cookie leaves only
 * through the injected `onClearance` sink; it is never part of this function's result. So a caller
 * shaping an agent-facing payload cannot accidentally include the token — the same structural move F5
 * makes by giving `CookieFacts` no `value` field. What the agent gets is the EXPIRY, as data.
 */

/** Classes a human can actually clear. Anything else has no rung and must not summon anyone. */
const SOLVABLE: ReadonlySet<ChallengeClass> = new Set<ChallengeClass>(['interactive', 'image']);

/**
 * The expiry, surfaced to the agent as DATA so a model can plan around the window instead of
 * rediscovering a block. Read from the cookie, never derived.
 */
export interface ClearanceExpiry {
  /** The cookie's own stated expiry, ISO. */
  readonly expires_at: string;
  /** Whole seconds remaining at the moment of the response. */
  readonly seconds_remaining: number;
  /**
   * ALWAYS TRUE, and deliberately a constant rather than a prediction. Measured 2026-08-03: Cloudflare
   * re-evaluates continuously on a ~12.5-minute cadence and may re-challenge long before the stated
   * expiry — one zone's cookie claimed 365 DAYS. `expires_at` is an upper bound on a horizon, never a
   * guarantee of validity until then, and a model reading only `expires_at` would assume otherwise.
   */
  readonly revalidates: true;
}

export type HumanSolveOutcome =
  | { solved: true; expiry?: ClearanceExpiry }
  | {
      solved: false;
      reason:
        | 'not_solvable_class'
        | 'credential_context'
        | 'unattended'
        | 'not_granted'
        | 'timeout'
        /**
         * The poll itself faulted (the tab died, CDP dropped) rather than the human running out of
         * time. Distinct from `timeout` on purpose: they call for different next actions — a timeout
         * means "the human did not finish", a fault means "ask again, the session broke."
         */
        | 'solve_failed';
    };

export interface HumanSolveBridgeDeps {
  /** The origin being opened. Used for the card's target only — never logged by this module. */
  readonly origin: string;
  /** The class the classifier assigned to the live page. */
  readonly challengeClass: ChallengeClass;
  /** Host-side credential probe — the SAME one observe/marks/capture and `studio_fetch` read. */
  readonly isCredentialContext: () => Promise<boolean>;
  /**
   * Is a live approval surface attached — a human who can see and answer a card? FAIL-CLOSED: absent
   * counts as unattended, so a host that forgets to wire it fails fast instead of hanging.
   */
  readonly approvalSurfaceAttached?: () => boolean;
  /** Ask the human. Only an explicit `approved` proceeds (`approvals.ts` is fail-closed by construction). */
  readonly requestApproval?: (origin: string) => Promise<ApprovalDecision>;
  /** Hand the wheel to the human for the solve. The agent is fenced by `not_holder` meanwhile. */
  readonly reclaimToHuman: () => void;
  /** Hand it back. Called on EVERY path once reclaimed — see the finally block. */
  readonly regrantToAgent: () => void;
  /**
   * Wait for the challenge to clear. Backed by `pollUntilCleared`, which treats a `cf_clearance` as
   * authoritative over the DOM (the interstitial can still be painted mid-redirect).
   */
  readonly awaitCleared: () => Promise<{ cleared: boolean; clearance?: ClearanceCookie }>;
  /** HOST-ONLY sink for the harvested cookie. The only way the value leaves this module. */
  readonly onClearance?: (clearance: ClearanceCookie) => void;
  /** D10(a) local counters — aggregate integers only, never an origin. Best-effort. */
  readonly bump?: (key: EscalationCounterKey) => void;
}

/** Build the agent-facing expiry, or nothing. A session/unknown expiry is OMITTED, never defaulted. */
function expiryOf(clearance: ClearanceCookie | undefined): ClearanceExpiry | undefined {
  if (!clearance) return undefined;
  // `expires` is epoch SECONDS. A non-positive value means session-scoped or unknown — and guessing
  // here would be worse than silence: the 1d measurement found a zone claiming a year, so any default
  // (30 minutes especially) would be a fabricated horizon a planner would trust.
  if (!Number.isFinite(clearance.expires) || clearance.expires <= 0) return undefined;
  const remaining = Math.floor(clearance.expires - Date.now() / 1000);
  return {
    expires_at: new Date(clearance.expires * 1000).toISOString(),
    seconds_remaining: remaining,
    revalidates: true,
  };
}

/**
 * Ask a human to open a gated page, then report whether it opened.
 *
 * GATE ORDER IS THE SECURITY PROPERTY, and each step is asserted in the tests:
 *   1. CLASS       — unsolvable ⇒ refuse before ANY host read. No rung exists; do not summon anyone.
 *   2. CREDENTIAL  — a login is human-only and a login is NOT a challenge. Refuse, and show NO card:
 *                    prompting here would teach the human to click through login prompts.
 *   3. ATTENDED    — no surface ⇒ refuse NOW. Waiting out a card nobody can see is a hang.
 *   4. CONSENT     — only `approved` proceeds.
 *   5. SOLVE       — human holds; poll until cleared; ALWAYS re-grant.
 */
export async function requestHumanSolve(deps: HumanSolveBridgeDeps): Promise<HumanSolveOutcome> {
  // 1. CLASS. Before the credential probe on purpose: an unsolvable class needs no host read at all.
  if (!SOLVABLE.has(deps.challengeClass)) {
    return { solved: false, reason: 'not_solvable_class' };
  }

  // 2. CREDENTIAL BOUNDARY — the brightest line in the phase. Fail-closed on a throwing probe: an
  // unreadable page is treated as a login, not as safe.
  let credential: boolean;
  try {
    credential = await deps.isCredentialContext();
  } catch {
    credential = true;
  }
  if (credential) return { solved: false, reason: 'credential_context' };

  // 3. ATTENDED. Identical rule to `agent-drive-gate.ts`: unknown attachment counts as unattended,
  // because the failure mode of guessing "attached" is exactly the hang this rule removes.
  if (!deps.approvalSurfaceAttached?.() || !deps.requestApproval) {
    deps.bump?.('cardUnattended');
    return { solved: false, reason: 'unattended' };
  }

  // 4. CONSENT.
  deps.bump?.('cardShown');
  const decision = await deps.requestApproval(deps.origin);
  if (decision !== 'approved') {
    deps.bump?.('cardRefused');
    return { solved: false, reason: 'not_granted' };
  }
  deps.bump?.('cardApproved');

  // 5. SOLVE. The human holds the wheel for the duration; the agent is fenced by `not_holder`.
  deps.reclaimToHuman();
  try {
    // A FAULTING poll degrades to a refusal rather than throwing. This rung is opportunistic: the
    // caller's job is to return an honest `blocked_by_challenge`, and a bridge fault must never turn a
    // clean challenge report into a crash for the whole fetch.
    let result: { cleared: boolean; clearance?: ClearanceCookie };
    try {
      result = await deps.awaitCleared();
    } catch {
      return { solved: false, reason: 'solve_failed' };
    }
    if (!result.cleared) return { solved: false, reason: 'timeout' };
    // The cookie leaves ONLY here. Nothing below puts it in the return value.
    if (result.clearance) deps.onClearance?.(result.clearance);
    const expiry = expiryOf(result.clearance);
    return expiry ? { solved: true, expiry } : { solved: true };
  } finally {
    // ALWAYS. A failed or throwing solve must not strand control with the human — every later agent
    // action would return `not_holder` and the session would look wedged with no way back.
    deps.regrantToAgent();
  }
}
