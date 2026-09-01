/**
 * The trust root for offline entitlement verification (PX2 mini-spec §5, A-212-4).
 *
 * WHY THE KEYS ARE PINNED IN THE CLIENT AND NOT FETCHED. `GET /entitlements/keys`
 * exists and this module deliberately does not call it. A key list served by the
 * same host that mints tokens proves nothing — an attacker who can answer for
 * that host can answer for both halves. The endpoint is a DIAGNOSTIC (PX1 §2
 * ep13): `doctor` compares the cached token's `kid` against this pinned set AND
 * against the service's published list so a rotation miss is legible in-band,
 * but trust never moves off the bytes compiled into the release.
 *
 * WHY THERE ARE EXACTLY TWO SLOTS AND WHAT THAT OBLIGES. Rotation is a
 * two-release dance and the client half comes FIRST: ship a release carrying the
 * new key in slot 2, wait for it to propagate, and only then flip the service's
 * key file; the old key is retired from slot 1 a release later. Flipping the
 * service before the client release has landed strands every install on the
 * "update wigolo" refusal — which is at least an honest, actionable message
 * rather than a signature failure that reads as corruption, but it is still an
 * outage. This is operational law, recorded here because this file is where
 * someone about to break it will be looking.
 *
 * WHY SLOT 1 IS A SENTINEL AT 0.3.0. The production key does not exist until the
 * CEO holds the deploy credentials, so shipping a placeholder that CANNOT verify
 * anything is the honest state: 32 zero bytes is a syntactically valid OKP `x`
 * (Node imports it without complaint — measured) and is not a valid Ed25519
 * point, so every signature checked against it fails. The publish issue replaces
 * it. A sentinel that happened to be someone's real key would be a backdoor; a
 * sentinel that throws on import would take the process down at first gate
 * evaluation. Zero bytes is neither.
 *
 * WHY THE ENV OVERRIDE EXISTS AND WHY IT IS LOUD. `WIGOLO_ACCOUNTS_PUBKEY` lets
 * a dev or an RC run trust a locally-minted key — without it the RC gate could
 * not be tested against a local accounts service at all. It is env-ONLY: no
 * catalog `FieldDef`, never written to settings, so it cannot be left switched
 * on by a `config --set` a user forgets about. It is recorded eyes-open in
 * A-212-4: the gate is legally strippable under AGPL (brief §6 risk 2, accepted),
 * so a local-env override adds no enforcement the fork risk has not already
 * priced in. It is still SHOWN — `whoami` and `doctor` print a visible line
 * while it is active — because a support conversation must never be conducted
 * against a build whose trust root has silently moved.
 */

import { createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('account');

/** Raw Ed25519 public keys are exactly 32 bytes; anything else is not one. */
const ED25519_RAW_KEY_BYTES = 32;

/**
 * Slot 1 at 0.3.0: 32 zero bytes, base64url. Structurally importable, never a
 * valid signer. The publish issue (Q) replaces this literal with the production
 * key and leaves slot 2 empty for the first rotation.
 */
export const SENTINEL_ACCOUNTS_PUBKEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * The build-time pin slots, in order. Slot 2 is empty at 0.3.0 — see the
 * rotation law above for why it must be filled a release BEFORE the service
 * flips, never in the same one.
 */
export const PINNED_ACCOUNTS_PUBKEY_SLOTS: readonly string[] = Object.freeze([
  SENTINEL_ACCOUNTS_PUBKEY,
  '',
]);

/** Env var that replaces the build-time pins for dev and RC runs. Env-only. */
export const ACCOUNTS_PUBKEY_ENV = 'WIGOLO_ACCOUNTS_PUBKEY';

/**
 * The line `whoami` and `doctor` print while the override is active.
 *
 * Capability language: a user does not need to know the curve to know their
 * install is not checking signatures against the shipped key.
 */
export const CUSTOM_VERIFICATION_KEY_NOTICE = 'custom sign-in verification key in use';

/** One usable verification key: its `kid`, its raw bytes and the imported object. */
export interface PinnedKey {
  /** First 8 hex of `sha256(raw 32-byte public key)` — the PX1 §5 derivation. */
  readonly kid: string;
  /** The b64url raw key exactly as it was pinned or supplied. */
  readonly publicKey: string;
  readonly key: KeyObject;
}

/** Where the active trust root came from — surfaced by `whoami`/`doctor`. */
export interface PinnedKeySet {
  readonly keys: readonly PinnedKey[];
  /** True when `WIGOLO_ACCOUNTS_PUBKEY` supplied the keys instead of the build. */
  readonly overrideActive: boolean;
  /** Present only while the override is active; the visible notice line. */
  readonly notice: string | null;
}

/**
 * `kid` for a raw b64url public key: first 8 hex of `sha256(raw bytes)`.
 *
 * Derived rather than pinned alongside the key on purpose — a pinned pair can
 * drift, and a `kid` that does not match its own key would make the "no pinned
 * key matches" arm fire for a key we actually hold.
 */
export function accountsKeyId(publicKeyB64Url: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyB64Url, 'base64url')).digest('hex').slice(0, 8);
}

/**
 * Import one b64url raw key, or `null` if it is not a usable Ed25519 key.
 *
 * Never throws. A malformed pin — a truncated env value, a copy-paste that lost
 * a character — must degrade to "this key is not available", which lands the
 * user on the actionable "update wigolo" refusal, rather than crashing whatever
 * surface happened to evaluate the gate first.
 */
export function importAccountsPublicKey(publicKeyB64Url: string): PinnedKey | null {
  const trimmed = publicKeyB64Url.trim();
  if (trimmed.length === 0) return null;

  const raw = Buffer.from(trimmed, 'base64url');
  if (raw.length !== ED25519_RAW_KEY_BYTES) {
    log.warn('ignoring account verification key of the wrong length', { bytes: raw.length });
    return null;
  }

  try {
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
    return { kid: accountsKeyId(trimmed), publicKey: trimmed, key };
  } catch (err) {
    log.warn('account verification key could not be imported', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the active trust root.
 *
 * The override REPLACES the build-time pins rather than joining them. Adding to
 * them would leave the shipped key live beside a dev key, so a token minted by
 * either would pass and a test asserting "the local service's token verifies"
 * could not tell which root answered. Replacing makes the override's effect
 * exactly one thing.
 *
 * `env` is a parameter so the arms are forced rather than mutated globally.
 */
export function resolvePinnedKeys(env: NodeJS.ProcessEnv = process.env): PinnedKeySet {
  const override = (env[ACCOUNTS_PUBKEY_ENV] ?? '').trim();
  if (override.length > 0) {
    const key = importAccountsPublicKey(override);
    return {
      keys: key ? [key] : [],
      overrideActive: true,
      notice: CUSTOM_VERIFICATION_KEY_NOTICE,
    };
  }

  const keys: PinnedKey[] = [];
  for (const slot of PINNED_ACCOUNTS_PUBKEY_SLOTS) {
    const key = importAccountsPublicKey(slot);
    if (key) keys.push(key);
  }
  return { keys, overrideActive: false, notice: null };
}

/**
 * The probe `whoami` and `doctor` consume: the notice line, or `null`.
 *
 * A dedicated function rather than "call `resolvePinnedKeys` and read `.notice`"
 * because the CLI slice must not have to reason about key import to print one
 * line — and because an override whose value fails to import is STILL active
 * and still worth saying out loud.
 */
export function customVerificationKeyNotice(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolvePinnedKeys(env).notice;
}
