/**
 * Custody for the account credentials.
 *
 * A PARALLEL store, never a widening of `src/security/key-store.ts` (A-212-3).
 * That module's entire surface — `storeKey`, `readKey`, `listProviders`,
 * `PICKER_PROVIDERS` — is typed to `LLMProvider`. Adding an `'account'` member
 * to that union would make the account credential enumerable from the TUI's
 * provider picker and from `listProviders()`, which is a leak of the one
 * long-lived credential the install holds. So this module composes the same
 * PRIMITIVES (`keychain.ts`, `key-crypto.ts`) at the same two tiers, and
 * shares nothing typed.
 *
 * CUSTODY SPLIT — three lifetimes, three homes:
 *
 *   refresh token   90-day, rotating, the only long-lived credential
 *                   → OS keychain (service `wigolo-account`), falling back to
 *                     an AES-256-GCM file at `<dataDir>/keys/account.enc`.
 *   access JWT      15-minute, re-mintable from the refresh token
 *                   → MEMORY ONLY. It is never written anywhere. Persisting a
 *                     15-minute bearer buys nothing (a refresh re-mints it) and
 *                     costs a second copy of a bearer credential on disk.
 *   entitlement +   signed, self-contained, not secret
 *   metadata        → `state.json` (see `state.ts`).
 *
 * There is no memo here, unlike `key-store.ts`. That memo exists because the
 * synthesis hot path resolves an LLM key several times per request and each
 * miss costs a scrypt. This credential is read once per process start, and a
 * memo would actively break the refresh policy's 30-second race branch, which
 * depends on re-reading a token another process just rotated.
 */

import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { keychainAvailable, keychainSet, keychainGet, keychainDelete } from '../security/keychain.js';
import { encryptToFile, decryptFromFile } from '../security/key-crypto.js';
import { ACCOUNT_KEYCHAIN_SERVICE, ACCOUNT_KEYCHAIN_USER } from './constants.js';

export interface AccountTokenStoreOpts {
  dataDir: string;
}

export type CredentialLocation = 'keychain' | 'file';

export interface StoredRefreshToken {
  value: string;
  location: CredentialLocation;
}

/** `<dataDir>/keys/account.enc` — the fallback tier, alongside the provider keys. */
export function accountEncFilePath(dataDir: string): string {
  return join(dataDir, 'keys', 'account.enc');
}

/**
 * Persist the refresh token, preferring the keychain.
 *
 * Falls through to the encrypted file both when the keychain is ABSENT and
 * when a keychain write throws despite the availability probe — the probe only
 * constructs an `Entry`, so a sandboxed or locked keychain reports available
 * and then fails on write. A caller that lost its credential to that gap could
 * not re-authenticate without a fresh login.
 */
export async function storeRefreshToken(
  value: string,
  opts: AccountTokenStoreOpts,
): Promise<{ location: CredentialLocation }> {
  if (keychainAvailable()) {
    try {
      keychainSet(ACCOUNT_KEYCHAIN_SERVICE, ACCOUNT_KEYCHAIN_USER, value);
      // The file tier may hold a pre-fallback copy of an older token; a stale
      // credential left on disk is both a leak and a rotation hazard.
      removeEncFile(opts.dataDir);
      return { location: 'keychain' };
    } catch {
      // Fall through to the file tier.
    }
  }
  await encryptToFile(value, opts.dataDir, accountEncFilePath(opts.dataDir));
  return { location: 'file' };
}

/**
 * Read the refresh token from whichever tier holds it.
 *
 * The data-dir path is the KEK input, matching `key-store.ts`: a machine-local
 * value that changes only when the user relocates their data dir, at which
 * point re-login is the correct outcome. The threat model is a casual disk
 * read by an unprivileged user, not root.
 */
export async function readRefreshToken(opts: AccountTokenStoreOpts): Promise<StoredRefreshToken | null> {
  if (keychainAvailable()) {
    const kc = keychainGet(ACCOUNT_KEYCHAIN_SERVICE, ACCOUNT_KEYCHAIN_USER);
    if (kc !== null) return { value: kc, location: 'keychain' };
  }

  const filePath = accountEncFilePath(opts.dataDir);
  if (existsSync(filePath)) {
    try {
      return { value: await decryptFromFile(opts.dataDir, filePath), location: 'file' };
    } catch {
      // Corrupt or tampered: a miss, never a garbage credential handed onward.
    }
  }
  return null;
}

/** Remove the refresh token from BOTH tiers. Logout must not leave a copy behind. */
export async function deleteRefreshToken(opts: AccountTokenStoreOpts): Promise<void> {
  if (keychainAvailable()) {
    keychainDelete(ACCOUNT_KEYCHAIN_SERVICE, ACCOUNT_KEYCHAIN_USER);
  }
  removeEncFile(opts.dataDir);
}

function removeEncFile(dataDir: string): void {
  const filePath = accountEncFilePath(dataDir);
  if (!existsSync(filePath)) return;
  try { unlinkSync(filePath); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Access JWT — memory only
// ---------------------------------------------------------------------------

interface CachedAccess {
  token: string;
  /** Epoch ms after which the token must not be presented. */
  expiresAtMs: number;
}

/**
 * Keyed by data dir so two configurations in one process (the daemon's own dir
 * and a test's tmp dir) never hand each other a bearer token.
 */
const accessCache = new Map<string, CachedAccess>();

/**
 * Discard the access token this many ms BEFORE its stated expiry.
 *
 * A token that expires between our check and the service's check produces a
 * 401 `token_expired` on an otherwise healthy call, which the refresh policy
 * would then have to distinguish from a real credential failure. Spending 30
 * seconds of a 15-minute TTL removes that class of failure entirely.
 */
const ACCESS_SKEW_MS = 30_000;

export function setAccessToken(
  token: string,
  expiresInS: number,
  opts: AccountTokenStoreOpts,
  nowMs: number = Date.now(),
): void {
  accessCache.set(opts.dataDir, { token, expiresAtMs: nowMs + expiresInS * 1000 });
}

/** Returns the cached access token, or null when absent or (nearly) expired. */
export function getAccessToken(opts: AccountTokenStoreOpts, nowMs: number = Date.now()): string | null {
  const entry = accessCache.get(opts.dataDir);
  if (!entry) return null;
  if (nowMs + ACCESS_SKEW_MS >= entry.expiresAtMs) {
    accessCache.delete(opts.dataDir);
    return null;
  }
  return entry.token;
}

export function clearAccessToken(opts: AccountTokenStoreOpts): void {
  accessCache.delete(opts.dataDir);
}

/** Test hook: drop every cached access token across all data dirs. */
export function _resetAccessTokenCache(): void {
  accessCache.clear();
}
