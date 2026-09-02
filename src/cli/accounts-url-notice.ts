/**
 * Visibility for the account-service address override (#322, PX1 exit-14).
 *
 * WHY THIS MIRRORS THE PINNED-KEY NOTICE. `src/account/pinned-keys.ts` records
 * the reasoning for the trust-root half of this decision: `WIGOLO_ACCOUNTS_PUBKEY`
 * is env-ONLY so it "cannot be left switched on by a `config --set` a user
 * forgets about", and it is still SHOWN by `whoami`/`doctor` because a support
 * conversation must never be conducted against a build whose trust root has
 * silently moved. The ADDRESS half has neither protection: `accountsUrl` is a
 * catalog field, so it persists to `config.json` and survives every shell, and
 * until this module nothing printed it. The credential consequence is larger
 * than the pubkey's, not smaller — the pinned keys stop a forged entitlement,
 * they do not stop an email, a sign-in code and a rotating 90-day refresh
 * credential being posted to whatever host the address names.
 *
 * WHY THIS SURFACE NOTIFIES. The account client owns the transport refusal so
 * background refresh and telemetry cannot bypass it. This module keeps the
 * same warning visible when deliberate LAN testing enables the env-only
 * escape hatch; a support conversation must still name the active risk.
 *
 * WHY THE SOURCE IS DERIVED FROM (url, env) AND NOT READ BACK OFF DISK. It is
 * the same precedence `envStr` applies in `src/config.ts` — a DEFINED env var
 * wins, otherwise the persisted value does — expressed once, as a pure
 * function, so a surface can attribute the address without opening config.json
 * a second time and without the two answers being able to disagree.
 */
export {
  ACCOUNTS_URL_ENV,
  accountsUrlNotice,
  accountsUrlOverride,
} from '../account/accounts-url-policy.js';
export type {
  AccountsUrlOverride,
  AccountsUrlSource,
} from '../account/accounts-url-policy.js';
