/**
 * The `wigolo/account` public surface (PX3 mini-spec §4, A-226-4).
 *
 * WHY THIS BARREL EXISTS AT ALL. The studio app implements NO auth, no token
 * custody, no gate evaluation and no crypto of its own — it consumes these
 * modules. Without an export the only alternatives are a second custody
 * implementation in the app (two places that can hold a refresh token, two
 * places that can be wrong about who is signed in) or a deep import into
 * `dist/account/*.js`, which makes every internal file a de-facto public API.
 * One named subpath is the seam; `package.json`'s `exports["./account"]` points
 * here and nowhere else in this directory is reachable from a consumer.
 *
 * WHY IT ENUMERATES INSTEAD OF `export *`. The surface is a contract, so it is
 * written down. Two consequences are load-bearing rather than stylistic:
 * `_resetAccessTokenCache` is a test hook and is deliberately NOT here — an app
 * that can drop the process-wide access-token cache can desynchronise custody
 * from state — and a module gaining an export does not silently widen what
 * studio may reach for. Growing this list is a decision someone makes.
 *
 * THE ONE ADDITION OVER PX2 is `refreshEntitlementsNow` (see `refresh.ts`).
 * Everything else re-exported here is PX2's shipped behaviour, unchanged.
 */

export {
  AccountsClient,
  CLIENT_MALFORMED,
  CLIENT_NETWORK,
  CLIENT_TIMEOUT,
} from './client.js';
export type {
  AccountResponse,
  AccountsClientOpts,
  AccountsFailure,
  AccountsFailureKind,
  AccountsResult,
  AccountsSuccess,
  AccountSummary,
  EntitlementKeysResponse,
  EntitlementTokenResponse,
  FetchLike,
  RefreshResponse,
  TelemetryBatchResponse,
  TelemetryDisclosureResponse,
  VerifyResponse,
} from './client.js';

export {
  ACCOUNT_KEYCHAIN_SERVICE,
  ACCOUNT_KEYCHAIN_USER,
  AUTH_TIMEOUT_MS,
  EXPORT_TIMEOUT_MS,
  PRODUCTION_ACCOUNTS_URL,
} from './constants.js';

export {
  ENTITLEMENT_TOKEN_VERSION,
  entitlementsFrom,
  isPerpetual,
  noEntitlements,
  verifyEntitlementToken,
} from './entitlements.js';
export type {
  EntitlementGrant,
  EntitlementPayload,
  Entitlements,
  EntitlementsOptions,
  EntitlementVerifyFailure,
  EntitlementVerifyResult,
} from './entitlements.js';

export {
  ACTIVATION_GRACE_MS,
  ACTIVATION_PRODUCT,
  ACTIVATION_REFUSALS,
  evaluateActivation,
  requireActivation,
} from './gate.js';
export type {
  ActivationDecision,
  ActivationInput,
  ActivationRefusalReason,
  ActivationStep,
  RequireActivationDeps,
} from './gate.js';

export {
  ACCOUNTS_PUBKEY_ENV,
  accountsKeyId,
  CUSTOM_VERIFICATION_KEY_NOTICE,
  customVerificationKeyNotice,
  importAccountsPublicKey,
  PINNED_ACCOUNTS_PUBKEY_SLOTS,
  resolvePinnedKeys,
  SENTINEL_ACCOUNTS_PUBKEY,
} from './pinned-keys.js';
export type { PinnedKey, PinnedKeySet } from './pinned-keys.js';

export { maybeRefresh, REFRESH_THROTTLE_MS, refreshEntitlementsNow } from './refresh.js';
export type { MaybeRefreshOpts, RefreshNowOpts, RefreshOutcome } from './refresh.js';

export { AccountStateStore, accountStatePath, EMPTY_ACCOUNT_STATE } from './state.js';
export type { AccountState } from './state.js';

export {
  accountEncFilePath,
  clearAccessToken,
  deleteRefreshToken,
  getAccessToken,
  readRefreshToken,
  setAccessToken,
  storeRefreshToken,
} from './token-store.js';
export type {
  AccountTokenStoreOpts,
  CredentialLocation,
  StoredRefreshToken,
} from './token-store.js';
