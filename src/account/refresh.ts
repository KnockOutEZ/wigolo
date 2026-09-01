/**
 * The refresh policy (A-212-13 / PX2 mini-spec §4).
 *
 * WHY A REFRESH IS ATTEMPTED ON EVERY GATED SURFACE'S PROCESS START, INCLUDING
 * ONE-SHOTS. Entitlement flags move server-side without shipping code (brief
 * §1/§3). If the attempt were owned only by the daemon, a user who never starts
 * one — the entire MCP-server-plus-CLI population — would never pick up a flag
 * flip. So the attempt rides process start, is THROTTLED to one per 24 h by
 * `last_refresh_attempt_at`, and is evaluated INDEPENDENTLY of the gate
 * outcome: a perpetual-grant install still refreshes, because "already
 * entitled" is exactly the install whose server-side grant may have changed.
 *
 * WHY IT CANNOT FAIL LOUDLY. `maybeRefresh` never throws and never blocks past
 * its timeout. A one-shot passes a 3 s cap and proceeds regardless of the
 * answer; failure inside grace is silent everywhere. An accounts service that
 * is down must cost a user nothing but a stale flag.
 *
 * WHY THE ATTEMPT IS STAMPED BEFORE THE CALL. If the stamp landed after a
 * response, every process start during an outage would retry — 24 h of throttle
 * would exist on paper and never apply, and a service already failing would
 * take one request per wigolo invocation. Stamping first means an outage costs
 * at most one attempt per day per install.
 *
 * THE FAILURE TAXONOMY IS CONSUMED, NOT COLLAPSED (PX1 §2 ep3). The four codes
 * mean materially different things and one of them is benign:
 *
 *   invalid_refresh   AMBIGUOUS. Either another process rotated the credential
 *                     inside the service's 30-second race window — in which
 *                     case the store already holds the new token and we simply
 *                     lost a footrace — or the token is genuinely unknown. We
 *                     tell them apart with the only signal a client has: re-read
 *                     the store and see whether the token CHANGED under us. It
 *                     did → retry once with the new one. It did not → nothing is
 *                     left to retry with, so the credential is dead.
 *   refresh_reused    Theft defence fired; the whole family is revoked.
 *   refresh_expired   90 days elapsed.
 *   invalid_token     Signature/shape rejected.
 *
 * The last three, and an unrecoverable `invalid_refresh`, set `needs_relogin`
 * and STOP THERE: the cached entitlement token is left exactly as it is, so a
 * perpetual grant keeps governing the gate (brief §3). A dead refresh
 * credential is a re-login prompt, never a downgrade.
 */

import { createLogger } from '../logger.js';
import type { AccountsClient } from './client.js';
import { AccountStateStore } from './state.js';
import { readRefreshToken, storeRefreshToken, setAccessToken } from './token-store.js';

const log = createLogger('account');

/** One attempt per 24 h, successful or not. */
export const REFRESH_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** Service codes that mean the refresh credential is unrecoverable. */
const DEAD_CREDENTIAL_CODES = new Set(['refresh_reused', 'refresh_expired', 'invalid_token']);

/** The ambiguous one — benign race or unknown token, decided by re-reading the store. */
const AMBIGUOUS_CODE = 'invalid_refresh';

export type RefreshOutcome =
  /** Inside the 24 h window; no request was made. */
  | { status: 'throttled'; nextEligibleAtMs: number }
  /** Install was never activated, or has been logged out. */
  | { status: 'no_credential' }
  /** Rotation persisted. `entitlementUpdated` false means the token refreshed but
   *  `GET /entitlements/token` did not answer — grace, not failure. */
  | { status: 'refreshed'; entitlementUpdated: boolean; racedRetry: boolean }
  /** Credential is dead. `needs_relogin` is set; entitlements untouched. */
  | { status: 'needs_relogin'; code: string }
  /** Network, timeout, 5xx or rate limit. Silent; nothing persisted but the stamp. */
  | { status: 'transient'; code: string };

export interface MaybeRefreshOpts {
  dataDir: string;
  client: AccountsClient;
  /** Injected clock. Every time decision in this module reads it, never `Date.now`. */
  nowMs?: () => number;
  /** Bypass the 24 h throttle — for the explicit `wigolo login` / `account` verbs. */
  force?: boolean;
}

function parseIso(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Attempt a throttled refresh. Never throws.
 *
 * On success the ROTATED refresh token is persisted before anything else can
 * fail: the presented token is already revoked service-side, so losing the
 * replacement between the response and the write would strand the install with
 * no credential at all.
 */
export async function maybeRefresh(opts: MaybeRefreshOpts): Promise<RefreshOutcome> {
  const now = opts.nowMs ?? Date.now;
  const store = new AccountStateStore(opts.dataDir);
  const state = store.read();

  const lastAttempt = parseIso(state.last_refresh_attempt_at);
  if (!opts.force && lastAttempt !== null) {
    const nextEligibleAtMs = lastAttempt + REFRESH_THROTTLE_MS;
    if (now() < nextEligibleAtMs) return { status: 'throttled', nextEligibleAtMs };
  }

  const stored = await readRefreshToken({ dataDir: opts.dataDir });
  if (!stored) return { status: 'no_credential' };

  // Stamped before the request: see the header. An outage must not turn the
  // throttle into a no-op.
  store.write({ last_refresh_attempt_at: new Date(now()).toISOString() });

  let res = await opts.client.refresh(stored.value);
  let racedRetry = false;

  if (!res.ok && res.kind === 'http' && res.code === AMBIGUOUS_CODE) {
    const reread = await readRefreshToken({ dataDir: opts.dataDir });
    if (reread && reread.value !== stored.value) {
      // Another process rotated under us — the service's 30-second race window.
      // Retry exactly once, with the token that process wrote.
      racedRetry = true;
      log.debug('refresh raced a concurrent rotation — retrying with the re-read token');
      res = await opts.client.refresh(reread.value);
    }
  }

  if (!res.ok) {
    if (res.kind === 'http' && (DEAD_CREDENTIAL_CODES.has(res.code) || res.code === AMBIGUOUS_CODE)) {
      // Entitlements are deliberately NOT cleared: a perpetual grant survives a
      // dead refresh credential.
      store.write({ needs_relogin: true });
      log.warn('account refresh credential is no longer valid — re-login required', { code: res.code });
      return { status: 'needs_relogin', code: res.code };
    }
    // Network / timeout / malformed / 5xx / rate-limited: silent inside grace.
    log.debug('account refresh unavailable', { kind: res.kind, code: res.code });
    return { status: 'transient', code: res.code };
  }

  await storeRefreshToken(res.data.refresh_token, { dataDir: opts.dataDir });
  setAccessToken(res.data.access_token, res.data.access_expires_in_s, { dataDir: opts.dataDir }, now());
  store.write({ refresh_expires_at: res.data.refresh_expires_at, needs_relogin: false });

  // `last_refresh_at` is stamped by a successful ENTITLEMENT fetch, not by the
  // auth rotation: grace is measured from the last time we actually learned the
  // account's grants, which is the thing the gate depends on.
  const ent = await opts.client.entitlementsToken(res.data.access_token);
  if (!ent.ok) {
    log.debug('entitlement token unavailable after refresh', { kind: ent.kind, code: ent.code });
    return { status: 'refreshed', entitlementUpdated: false, racedRetry };
  }

  store.write({ entitlement_token: ent.data.token, last_refresh_at: new Date(now()).toISOString() });
  return { status: 'refreshed', entitlementUpdated: true, racedRetry };
}
