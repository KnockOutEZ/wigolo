/**
 * The activation gate — one predicate, one seam (PX2 mini-spec §3 + §5, A-212-12).
 *
 * `requireActivation(now)` is the ONLY thing any gated surface calls. Every
 * surface in §3 — MCP `tools/call`, the daemon's `/v1` and compat routes, CLI
 * one-shots, the REPL, `serve` start — asks this one question and renders the
 * one answer it gets back. Slice D owns the call sites; this file owns the
 * decision, and nothing else in the tree is allowed to grow a second one.
 *
 * THE SIX STEPS ARE PINNED AND THE ORDER IS THE CONTRACT (A-212-12):
 *
 *   1. no state / no token                       → never-activated
 *   2. kid pinned but signature fails            → never-activated (corrupt/foreign)
 *      kid matches NO pinned key                 → update-required
 *   3. any `core` grant of type `perpetual`      → PASS, forever
 *   4. else `valid_until >= now`                 → pass
 *   5. else `now <= last_refresh_at + 14 days`   → pass
 *   6. else                                      → expired
 *
 * WHY THE KID SPLIT IN STEP 2 IS NOT A DETAIL. A user mid-rotation holds a
 * perfectly good token signed by a key their build does not carry. Telling them
 * to `register` would send them to create a second account to fix a problem
 * re-registering cannot fix — the new account's token would be signed by the
 * same unpinned key. So an unpinned `kid` gets its own refusal that names the
 * only action that works: update wigolo.
 *
 * WHY STEP 3 IGNORES `valid_until`. Brief §3: an offline machine keeps every
 * perpetual grant for good. `valid_until` is a property of the TOKEN (7 days,
 * refreshed) and not of the grant; letting it govern a perpetual grant would
 * mean an install that goes offline for eight days loses an entitlement it was
 * promised forever. Step 3 sits above step 4 for exactly that reason, and the
 * test proving it uses a token whose `valid_until` is already in the past.
 *
 * WHY STEP 5 EXISTS AT ALL. The 14-day grace is measured from the last
 * SUCCESSFUL refresh, rolling. It is the answer to "the accounts service was
 * down for a week": a subscription user whose client could not reach the service
 * keeps working, and the window is long enough that any outage the CEO can have
 * is shorter than it. It is not measured from `valid_until`, because that would
 * compound a 7-day token with a 14-day grace into a 21-day one.
 *
 * WHY THE REFRESH ATTEMPT IS NOT IN HERE. §5 is explicit that the §4 refresh
 * runs on its own 24 h throttle, independently of and not as a side effect of
 * this evaluation. Coupling them would have meant perpetual installs — which
 * pass at step 3 and never reach step 5 — never refreshing, and therefore never
 * picking up a server-side flag flip. `refresh.ts` owns that; this file must
 * stay a pure function of (state, keys, now).
 *
 * NO `Date.now()` LIVES BELOW THIS LINE. `now` is a parameter end-to-end so the
 * grace boundary is forced in a test rather than waited for.
 */

import type { AccountState } from './state.js';
import { resolvePinnedKeys, type PinnedKey } from './pinned-keys.js';
import {
  verifyEntitlementToken,
  isPerpetual,
  type EntitlementPayload,
} from './entitlements.js';

/** The product whose grant means "this install is activated". */
export const ACTIVATION_PRODUCT = 'core';

/** Rolling grace after the last successful refresh (mini-spec §5 pin 4). */
export const ACTIVATION_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Which refusal fired. The gate returns the reason as well as the line so a
 * caller can branch (exit code, `isError`, telemetry) without string-matching.
 */
export type ActivationRefusalReason = 'never_activated' | 'expired' | 'update_required';

/**
 * The three refusal lines, pinned verbatim by mini-spec §3.
 *
 * Single line each, capability language, and deliberately no product-tier
 * adjective: "free" is a fact about a grant row the CEO can change server-side,
 * not a fact about the software, so it must not be compiled into a string.
 */
export const ACTIVATION_REFUSALS: Readonly<Record<ActivationRefusalReason, string>> = Object.freeze({
  never_activated:
    'wigolo needs an account — run `wigolo register` to create one (already have one? `wigolo login`).',
  expired: 'Your wigolo sign-in has expired — run `wigolo login` to reconnect.',
  update_required:
    'wigolo needs an update to verify your sign-in — update wigolo, then run `wigolo login`.',
});

/** Which of the six steps decided it — for `doctor` and for the arm tests. */
export type ActivationStep =
  | 'no_token'
  | 'signature'
  | 'unpinned_kid'
  | 'perpetual'
  | 'token_valid'
  | 'grace'
  | 'expired';

export type ActivationDecision =
  | {
      readonly ok: true;
      readonly step: Extract<ActivationStep, 'perpetual' | 'token_valid' | 'grace'>;
      readonly payload: EntitlementPayload;
    }
  | {
      readonly ok: false;
      readonly step: Extract<ActivationStep, 'no_token' | 'signature' | 'unpinned_kid' | 'expired'>;
      readonly reason: ActivationRefusalReason;
      readonly message: string;
    };

function refuse(
  step: Extract<ActivationStep, 'no_token' | 'signature' | 'unpinned_kid' | 'expired'>,
  reason: ActivationRefusalReason,
): ActivationDecision {
  return { ok: false, step, reason, message: ACTIVATION_REFUSALS[reason] };
}

/** Everything the decision reads. Nothing is fetched from disk or env in here. */
export interface ActivationInput {
  readonly state: AccountState;
  readonly keys: readonly PinnedKey[];
}

/**
 * The pinned six-step evaluation, as a pure function.
 *
 * `evaluateActivation` is what the tests drive; `requireActivation` is the
 * convenience wrapper the call sites use. Keeping them apart is what lets every
 * arm be forced with a hand-built state and a hand-built clock — including the
 * ones that would otherwise need a real key rotation or a fourteen-day wait.
 */
export function evaluateActivation(input: ActivationInput, now: number): ActivationDecision {
  const { state, keys } = input;

  // 1. No state, no token.
  const token = state.entitlement_token;
  if (token === null || token.trim().length === 0) {
    return refuse('no_token', 'never_activated');
  }

  // 2. Signature, kid-aware.
  const verified = verifyEntitlementToken(token, keys);
  if (!verified.ok) {
    if (verified.reason === 'unpinned_kid') {
      return refuse('unpinned_kid', 'update_required');
    }
    // Malformed or signature failure under a key we DO hold: the stored state is
    // corrupt or foreign, which is indistinguishable from never having activated.
    return refuse('signature', 'never_activated');
  }
  const { payload } = verified;

  // 3. A perpetual core grant passes forever — `valid_until` is not consulted.
  const hasPerpetualCore = payload.grants.some(
    (g) => g.product === ACTIVATION_PRODUCT && isPerpetual(g),
  );
  if (hasPerpetualCore) {
    return { ok: true, step: 'perpetual', payload };
  }

  // 4. The token is still inside its own validity window.
  const validUntil = Date.parse(payload.valid_until);
  if (Number.isFinite(validUntil) && validUntil >= now) {
    return { ok: true, step: 'token_valid', payload };
  }

  // 5. Rolling grace from the last SUCCESSFUL refresh. `<=` at the boundary:
  //    the fourteenth day is inside the window the user was promised.
  const lastRefresh = state.last_refresh_at === null ? Number.NaN : Date.parse(state.last_refresh_at);
  if (Number.isFinite(lastRefresh) && now <= lastRefresh + ACTIVATION_GRACE_MS) {
    return { ok: true, step: 'grace', payload };
  }

  // 6. Out of token validity and out of grace.
  return refuse('expired', 'expired');
}

/** Optional overrides — supplied by tests and by the RC gate, never in production. */
export interface RequireActivationDeps {
  readonly state: AccountState;
  readonly keys?: readonly PinnedKey[];
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * The seam the gated surfaces call: `requireActivation(now)`.
 *
 * `now` is the caller's clock — a call site is free to use `Date.now()`; the
 * DECISION path is what must not, and does not. The state is passed in rather
 * than read here because §3's long-lived surfaces reload it on their own
 * once-a-minute cadence, and a gate that hit the disk on every `tools/call`
 * would put a `readFileSync` on the hot path of every dispatch.
 */
export function requireActivation(now: number, deps: RequireActivationDeps): ActivationDecision {
  const keys = deps.keys ?? resolvePinnedKeys(deps.env).keys;
  return evaluateActivation({ state: deps.state, keys }, now);
}
