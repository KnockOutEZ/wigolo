/**
 * Offline entitlement-token verification and the `has(product, flag)` seam
 * (PX2 mini-spec §5, A-212-4).
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: VERIFY OVER THE RECEIVED BYTES.
 * The token is `v1.<kid>.<b64url(payload)>.<b64url(sig)>` and the signature
 * covers the ASCII bytes of the first three segments joined — the bytes as they
 * arrived, not a re-rendering of them. The signer serializes canonically
 * (sorted keys, no whitespace) and PX1 §5 records that as a SIGNER-SIDE
 * CONVENTION ONLY. A verifier that parsed the payload and re-serialized it
 * would be checking a signature over ITS OWN idea of the canonical form, which
 * is a forgery seam the moment the two ideas diverge: any JSON dialect
 * difference — key order, number formatting, non-ASCII escaping, a future field
 * this client does not model and therefore drops — turns a valid token invalid
 * or, worse, lets a payload the signer never saw carry a signature the signer
 * did make. So the signed input is sliced out of the original string and the
 * parse happens strictly AFTER the signature has been checked.
 *
 * WHY THE PARSE IS SO NARROW. The payload is attacker-adjacent until the
 * signature passes, and it stays user-writable afterwards (it lives in a
 * 0600 file the user owns). Every field is checked for its type and an
 * unknown-shaped grant is dropped rather than coerced — a grant with a
 * non-array `features` must not become a grant with no features, because
 * "no features" is a legitimate value that would then be indistinguishable
 * from corruption.
 *
 * WHY `has()` TAKES ITS CLOCK AT CONSTRUCTION. `has(product, flag)` is the seam
 * every future paywall calls (brief §3) and its signature is fixed; a clock
 * parameter on it would leak the test seam into every call site. So the clock
 * is injected once, into the object — no `Date.now()` anywhere in the decision
 * path, and the expiry arms are forced rather than waited for.
 *
 * DAY ONE NOTHING CONSULTS THIS BEYOND THE GATE. No feature is behind a paid
 * flag at 0.3.0. The seam ships now so that the first one to need it does not
 * also get to invent the semantics.
 */

import { verify } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { PinnedKey } from './pinned-keys.js';

const log = createLogger('account');

/** The only token version this client understands. */
export const ENTITLEMENT_TOKEN_VERSION = 'v1';

/**
 * One grant, exactly the five keys PX1 §5 pins as the cross-milestone wire
 * contract. Row-plumbing columns never reach here.
 */
export interface EntitlementGrant {
  readonly product: string;
  readonly type: string;
  /** Flag names this grant unlocks. `null` is "no features", not "unknown". */
  readonly features: readonly string[] | null;
  /** ISO-8601, or `null` for a perpetual grant. */
  readonly expires: string | null;
  /** Highest wigolo version this grant applies to (INCLUSIVE), or `null`. */
  readonly version_ceiling: string | null;
}

/** The signed payload — brief §3's token object as PX1 §5 realizes it. */
export interface EntitlementPayload {
  readonly account_id: string;
  readonly issued_at: string;
  readonly valid_until: string;
  readonly grants: readonly EntitlementGrant[];
}

/** Why a token was rejected. Each maps to a different thing to tell the user. */
export type EntitlementVerifyFailure =
  /** Not a `v1.<kid>.<payload>.<sig>` string, or the payload is not the shape. */
  | 'malformed'
  /** The `kid` names none of the pinned keys — a rotation miss, not corruption. */
  | 'unpinned_kid'
  /** A pinned key was tried and the signature did not check out. */
  | 'bad_signature';

export type EntitlementVerifyResult =
  | { readonly ok: true; readonly kid: string; readonly payload: EntitlementPayload }
  | { readonly ok: false; readonly reason: EntitlementVerifyFailure; readonly kid: string | null };

/**
 * Slice the signed input out of the original token string.
 *
 * Returns the segments AND the exact substring the signature covers, so the
 * caller never has to reconstruct it. `lastIndexOf` is deliberate: the payload
 * segment is base64url and cannot contain a dot, but taking the signature from
 * the END means a token that somehow grew a segment fails the arity check
 * rather than silently verifying its first three parts.
 */
interface TokenSegments {
  readonly kid: string;
  readonly payloadB64: string;
  readonly sigB64: string;
  /** `v1.<kid>.<payloadB64>` exactly as received. */
  readonly signedInput: string;
}

function splitToken(token: string): TokenSegments | null {
  const parts = token.split('.');
  if (parts.length !== 4) return null;

  const [version, kid, payloadB64, sigB64] = parts;
  if (version !== ENTITLEMENT_TOKEN_VERSION) return null;
  if (kid.length === 0 || payloadB64.length === 0 || sigB64.length === 0) return null;

  return {
    kid,
    payloadB64,
    sigB64,
    signedInput: `${version}.${kid}.${payloadB64}`,
  };
}

/**
 * `Buffer.from(s, 'base64url')` is lenient — it silently ignores characters it
 * does not recognize, so a payload with a `+` or a `=` in it would decode to
 * something rather than fail. Re-encoding and comparing is the cheap way to
 * insist the input really was unpadded base64url, which is what PX1 §5 pins.
 */
function decodeStrictB64Url(segment: string): Buffer | null {
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.length === 0) return null;
  if (decoded.toString('base64url') !== segment) return null;
  return decoded;
}

function isStringOrNull(v: unknown): v is string | null {
  return v === null || typeof v === 'string';
}

/** Coerce one wire grant, or `null` if it is not the pinned five-key shape. */
function parseGrant(raw: unknown): EntitlementGrant | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o['product'] !== 'string' || typeof o['type'] !== 'string') return null;
  if (!isStringOrNull(o['expires']) || !isStringOrNull(o['version_ceiling'])) return null;

  const rawFeatures = o['features'];
  let features: readonly string[] | null;
  if (rawFeatures === null) {
    features = null;
  } else if (Array.isArray(rawFeatures) && rawFeatures.every((f) => typeof f === 'string')) {
    features = Object.freeze([...(rawFeatures as string[])]);
  } else {
    return null;
  }

  return Object.freeze({
    product: o['product'],
    type: o['type'],
    features,
    expires: o['expires'],
    version_ceiling: o['version_ceiling'],
  });
}

/**
 * Parse the payload AFTER the signature has passed.
 *
 * A grant that does not match the pinned shape drops the WHOLE payload rather
 * than just itself. The signer emits five keys always; a grant that is not that
 * shape means this client and the service disagree about the contract, and
 * quietly proceeding on the grants we happened to understand would let a
 * partial disagreement look like a smaller entitlement.
 */
function parsePayload(raw: unknown): EntitlementPayload | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o['account_id'] !== 'string') return null;
  if (typeof o['issued_at'] !== 'string' || typeof o['valid_until'] !== 'string') return null;
  if (!Array.isArray(o['grants'])) return null;

  const grants: EntitlementGrant[] = [];
  for (const g of o['grants']) {
    const parsed = parseGrant(g);
    if (!parsed) return null;
    grants.push(parsed);
  }

  return Object.freeze({
    account_id: o['account_id'],
    issued_at: o['issued_at'],
    valid_until: o['valid_until'],
    grants: Object.freeze(grants),
  });
}

/**
 * Verify a compact entitlement token against the pinned trust root.
 *
 * The `unpinned_kid` / `bad_signature` split is load-bearing, not cosmetic: the
 * gate turns the first into "update wigolo" and the second into "register", and
 * telling a mid-rotation user to re-register would send them to fix something
 * that is not broken (A-212-12).
 */
export function verifyEntitlementToken(
  token: string,
  keys: readonly PinnedKey[],
): EntitlementVerifyResult {
  const segments = splitToken(token);
  if (!segments) return { ok: false, reason: 'malformed', kid: null };

  const matching = keys.filter((k) => k.kid === segments.kid);
  if (matching.length === 0) {
    return { ok: false, reason: 'unpinned_kid', kid: segments.kid };
  }

  const sig = decodeStrictB64Url(segments.sigB64);
  if (!sig) return { ok: false, reason: 'malformed', kid: segments.kid };

  // The signed bytes are sliced from the token, never rebuilt from the parse.
  const signedBytes = Buffer.from(segments.signedInput, 'ascii');
  const signatureChecks = matching.some((k) => {
    try {
      return verify(null, signedBytes, k.key, sig);
    } catch (err) {
      log.warn('entitlement signature check failed to run', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  });
  if (!signatureChecks) return { ok: false, reason: 'bad_signature', kid: segments.kid };

  const payloadBytes = decodeStrictB64Url(segments.payloadB64);
  if (!payloadBytes) return { ok: false, reason: 'malformed', kid: segments.kid };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed', kid: segments.kid };
  }

  const payload = parsePayload(parsedJson);
  if (!payload) return { ok: false, reason: 'malformed', kid: segments.kid };

  return { ok: true, kid: segments.kid, payload };
}

/**
 * Perpetuity is carried by `type`, not by a null `expires`.
 *
 * PX1 §5 emits `expires: null` for perpetual grants, so the two agree today —
 * but they are not the same claim. `type` is the service's declaration; a null
 * `expires` is a field that could also be null because a subscription grant was
 * projected without one. Reading the declaration means a projection bug cannot
 * silently promote a subscription to a forever grant (brief §3).
 */
export function isPerpetual(grant: EntitlementGrant): boolean {
  return grant.type === 'perpetual';
}

/**
 * Compare a dotted version against a ceiling. `true` means "we are within it".
 *
 * INCLUSIVE — the ceiling names the highest version the grant applies to, so
 * the boundary release itself is covered and the next one is not. PX1 §5 does
 * not say which way that goes; the field's own name does, and the inclusive
 * reading is the one that does not silently revoke a flag on the release the
 * service named. Recorded in DECISIONS-AUTO with its reversal condition.
 *
 * Numeric segment-wise, ignoring any pre-release suffix, because the ceiling is
 * a release boundary and `0.4.0-rc.1` is on the `0.4.0` side of it. An
 * unparseable ceiling — or an unknown running version — is treated as NOT
 * satisfied: a ceiling we cannot read is a contract we do not understand, and
 * guessing in the user's favour would hand out a flag the service meant to
 * withhold.
 */
function withinVersionCeiling(version: string | null, ceiling: string): boolean {
  if (version === null) return false;
  const nums = (v: string): number[] | null => {
    const core = v.split('-')[0].split('+')[0];
    const parts = core.split('.').map((p) => Number.parseInt(p, 10));
    return parts.length > 0 && parts.every((n) => Number.isInteger(n) && n >= 0) ? parts : null;
  };
  const a = nums(version);
  const b = nums(ceiling);
  if (!a || !b) return false;

  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y;
  }
  return true;
}

/** The seam every future paywall calls. Nothing but the gate consults it today. */
export interface Entitlements {
  has(product: string, flag: string): boolean;
  /** The grants the token carried, for `whoami`/`doctor` to display. */
  readonly grants: readonly EntitlementGrant[];
}

export interface EntitlementsOptions {
  /** Injected clock. No `Date.now()` in the decision path (A-212-12). */
  readonly now: () => number;
  /** The running wigolo version, for `version_ceiling`. Null = no ceiling can pass. */
  readonly version?: string | null;
}

/**
 * Build the `has()` seam over a verified payload.
 *
 * A grant unlocks a flag when it names the product, lists the flag, is LIVE at
 * `now` (perpetual grants always are) and is inside its version ceiling. All
 * four, because a grant that fails any one of them is one the service intended
 * not to apply — and the gate's own evaluation (`gate.ts`) deliberately does
 * NOT go through here: activation is `type`-shaped, not `feature`-shaped.
 */
export function entitlementsFrom(
  payload: EntitlementPayload | null,
  options: EntitlementsOptions,
): Entitlements {
  const grants = payload?.grants ?? [];
  const version = options.version ?? null;

  return {
    grants,
    has(product: string, flag: string): boolean {
      return grants.some((g) => {
        if (g.product !== product) return false;
        if (!g.features?.includes(flag)) return false;
        if (g.version_ceiling !== null && !withinVersionCeiling(version, g.version_ceiling)) return false;
        if (isPerpetual(g)) return true;
        if (g.expires === null) return false;
        const expiresAt = Date.parse(g.expires);
        return Number.isFinite(expiresAt) && expiresAt >= options.now();
      });
    },
  };
}

/** An un-activated install. Every flag is off; nothing throws. */
export function noEntitlements(): Entitlements {
  return { grants: [], has: () => false };
}
