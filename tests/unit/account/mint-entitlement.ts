/**
 * A stand-in signer for the PX1 accounts service.
 *
 * Deliberately built from Node's own primitives rather than from anything in
 * `src/account/`: a mint that shared code with the verifier could only ever
 * agree with it, and the whole point of these arms is an outside signal. The
 * `kid` derivation, the canonical serialization and the signed-input shape are
 * transcribed from PX1 §5, not imported.
 *
 * `canonicalJson` reproduces the SIGNER-side convention (sorted keys, no
 * whitespace) so that a re-serialization test can hold the signature constant
 * while changing only the received bytes.
 */

import { generateKeyPairSync, sign, createHash, type KeyObject } from 'node:crypto';

export interface MintKeyPair {
  readonly privateKey: KeyObject;
  /** b64url raw 32-byte public key — the form `pinned-keys.ts` takes. */
  readonly publicKeyB64Url: string;
  readonly kid: string;
}

export function generateMintKeyPair(): MintKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  const publicKeyB64Url = jwk.x ?? '';
  const kid = createHash('sha256')
    .update(Buffer.from(publicKeyB64Url, 'base64url'))
    .digest('hex')
    .slice(0, 8);
  return { privateKey, publicKeyB64Url, kid };
}

/** Sorted-key, no-whitespace JSON — the signer's convention, recursively. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const body = Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface MintedToken {
  readonly token: string;
  readonly payloadB64: string;
  readonly signatureB64: string;
  readonly signedInput: string;
}

/**
 * Mint `v1.<kid>.<b64url(payload)>.<b64url(sig)>` over a caller-supplied
 * serialization, so a test can sign one byte sequence and then ship a different
 * one in the token.
 */
export function mintTokenFromSerialization(
  keys: MintKeyPair,
  signedSerialization: string,
  shippedSerialization: string = signedSerialization,
): MintedToken {
  const signedPayloadB64 = Buffer.from(signedSerialization, 'utf8').toString('base64url');
  const signedInput = `v1.${keys.kid}.${signedPayloadB64}`;
  const signature = sign(null, Buffer.from(signedInput, 'ascii'), keys.privateKey);
  const signatureB64 = signature.toString('base64url');

  const shippedPayloadB64 = Buffer.from(shippedSerialization, 'utf8').toString('base64url');
  return {
    token: `v1.${keys.kid}.${shippedPayloadB64}.${signatureB64}`,
    payloadB64: shippedPayloadB64,
    signatureB64,
    signedInput,
  };
}

/** The common case: canonical serialization, signed and shipped. */
export function mintToken(keys: MintKeyPair, payload: unknown): MintedToken {
  return mintTokenFromSerialization(keys, canonicalJson(payload));
}

export interface GrantOverrides {
  product?: string;
  type?: string;
  features?: string[] | null;
  expires?: string | null;
  version_ceiling?: string | null;
}

/** A grant projected as PX1 §5 pins it: exactly five keys, nulls emitted. */
export function grant(overrides: GrantOverrides = {}): Record<string, unknown> {
  return {
    product: overrides.product ?? 'core',
    type: overrides.type ?? 'perpetual',
    features: overrides.features === undefined ? null : overrides.features,
    expires: overrides.expires === undefined ? null : overrides.expires,
    version_ceiling: overrides.version_ceiling === undefined ? null : overrides.version_ceiling,
  };
}

export interface PayloadOverrides {
  account_id?: string;
  issued_at?: string;
  valid_until?: string;
  grants?: Array<Record<string, unknown>>;
}

export function payload(overrides: PayloadOverrides = {}): Record<string, unknown> {
  return {
    account_id: overrides.account_id ?? 'acct_test',
    issued_at: overrides.issued_at ?? '2026-09-01T00:00:00.000Z',
    valid_until: overrides.valid_until ?? '2026-09-08T00:00:00.000Z',
    grants: overrides.grants ?? [grant()],
  };
}
