/**
 * Account subsystem constants shared by `src/config.ts` and `src/account/*`.
 *
 * Deliberately a LEAF module: it imports nothing, so `config.ts` can read
 * `PRODUCTION_ACCOUNTS_URL` without opening a config ⇄ account import cycle.
 */

/**
 * Default accounts-service base URL until the publish issue flips it.
 *
 * `accounts.invalid` is an RFC 2606 reserved TLD — guaranteed never to resolve.
 * That is load-bearing, not cosmetic: the suite's net-fence records any connect
 * to a non-loopback host, so a test that forgets to point `WIGOLO_ACCOUNTS_URL`
 * at a locally-run instance goes RED instead of silently measuring whatever a
 * production hostname happens to answer (A-212-4).
 */
export const PRODUCTION_ACCOUNTS_URL = 'https://accounts.invalid';

/**
 * Keychain service for the account refresh token, following the existing
 * `wigolo-<thing>` convention (`keychainSet(service, user, value)`).
 *
 * A PARALLEL store to `src/security/key-store.ts`, never a widening of it:
 * that module's surface is typed to `LLMProvider`, so smearing an account
 * credential into that union would surface it in `PICKER_PROVIDERS` /
 * `listProviders` (A-212-3).
 */
export const ACCOUNT_KEYCHAIN_SERVICE = 'wigolo-account';

/** Keychain user slot for the single refresh token this install holds. */
export const ACCOUNT_KEYCHAIN_USER = 'refresh-token';

/** Auth/metadata calls are short: a hung accounts service must never wedge a surface. */
export const AUTH_TIMEOUT_MS = 5_000;

/** The GDPR export assembles a whole account server-side; it gets a longer leash. */
export const EXPORT_TIMEOUT_MS = 10_000;
