/**
 * Offline entitlement verification — the received-bytes law and the `has()` seam.
 *
 * THE ARM THAT MATTERS IS `re-serialized payload with a canonical signature`.
 * It is the only test in this file that a "reasonable" implementation fails:
 * parse the payload, re-serialize it canonically, verify the signature over
 * THAT. Such a client would pass every other arm here — happy path, tampered
 * byte, wrong key, unpinned kid — and would have handed anyone who can reorder
 * JSON keys the ability to ship a payload the signer never saw under a
 * signature the signer really made. So that arm is built to hold the signature
 * constant and change ONLY the received bytes, which is exactly the difference
 * between verifying what arrived and verifying what you rebuilt.
 *
 * The signer here is transcribed from PX1 §5, not imported from `src/`, so a
 * bug shared by both halves cannot make these arms agree with themselves.
 */

import { describe, it, expect } from 'vitest';
import {
  verifyEntitlementToken,
  entitlementsFrom,
  noEntitlements,
  isPerpetual,
  type EntitlementPayload,
} from '../../../src/account/entitlements.js';
import { importAccountsPublicKey, type PinnedKey } from '../../../src/account/pinned-keys.js';
import {
  generateMintKeyPair,
  mintToken,
  mintTokenFromSerialization,
  canonicalJson,
  payload,
  grant,
  type MintKeyPair,
} from './mint-entitlement.js';

function pin(keys: MintKeyPair): PinnedKey[] {
  const imported = importAccountsPublicKey(keys.publicKeyB64Url);
  if (!imported) throw new Error('test key failed to import');
  return [imported];
}

const AT = (iso: string): number => Date.parse(iso);

describe('verifyEntitlementToken — the signature is checked over the received bytes', () => {
  it('accepts a token minted the way PX1 mints one', () => {
    const keys = generateMintKeyPair();
    const body = payload();
    const { token } = mintToken(keys, body);

    const result = verifyEntitlementToken(token, pin(keys));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kid).toBe(keys.kid);
    expect(result.payload.account_id).toBe('acct_test');
    expect(result.payload.grants).toHaveLength(1);
    expect(result.payload.grants[0]).toMatchObject({
      product: 'core',
      type: 'perpetual',
      features: null,
      expires: null,
      version_ceiling: null,
    });
  });

  it('REJECTS a key-reordered re-serialization carrying the canonical signature', () => {
    const keys = generateMintKeyPair();
    const body = payload();

    // Signed: the canonical (sorted-key) bytes. Shipped: the same object with
    // its keys in a different order — semantically identical JSON, different
    // bytes. A verifier that re-canonicalized would call this valid.
    const signedBytes = canonicalJson(body);
    const reordered = JSON.stringify({
      grants: body['grants'],
      valid_until: body['valid_until'],
      issued_at: body['issued_at'],
      account_id: body['account_id'],
    });
    expect(reordered).not.toBe(signedBytes);
    expect(JSON.parse(reordered)).toEqual(JSON.parse(signedBytes));

    const minted = mintTokenFromSerialization(keys, signedBytes, reordered);
    const result = verifyEntitlementToken(minted.token, pin(keys));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad_signature');
    expect(result.kid).toBe(keys.kid);

    // Non-vacuity: the SIGNED serialization of the very same object verifies,
    // so the rejection is about the bytes and not about the payload.
    const control = mintTokenFromSerialization(keys, signedBytes, signedBytes);
    expect(verifyEntitlementToken(control.token, pin(keys)).ok).toBe(true);
  });

  it('rejects a token with one mutated payload byte', () => {
    const keys = generateMintKeyPair();
    const { token } = mintToken(keys, payload());
    const [v, kid, payloadB64, sig] = token.split('.');

    const flipped = payloadB64.slice(0, -1) + (payloadB64.endsWith('A') ? 'B' : 'A');
    expect(flipped).not.toBe(payloadB64);

    const result = verifyEntitlementToken(`${v}.${kid}.${flipped}.${sig}`, pin(keys));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a token with one mutated signature byte', () => {
    const keys = generateMintKeyPair();
    const { token } = mintToken(keys, payload());
    const [v, kid, payloadB64, sig] = token.split('.');
    const flipped = (sig.startsWith('A') ? 'B' : 'A') + sig.slice(1);

    const result = verifyEntitlementToken(`${v}.${kid}.${payloadB64}.${flipped}`, pin(keys));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('reports `unpinned_kid` — not a signature failure — when the kid names no pinned key', () => {
    const service = generateMintKeyPair();
    const shipped = generateMintKeyPair();
    const { token } = mintToken(service, payload());

    const result = verifyEntitlementToken(token, pin(shipped));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unpinned_kid');
    expect(result.kid).toBe(service.kid);
  });

  it('reports `bad_signature` when a pinned kid collides but the key does not', () => {
    // The kid is a truncated hash, so a collision is possible in principle and
    // must land on "signature failed", never on "we do not have this key".
    const service = generateMintKeyPair();
    const impostor = generateMintKeyPair();
    const { token } = mintToken(service, payload());

    const imported = importAccountsPublicKey(impostor.publicKeyB64Url);
    if (!imported) throw new Error('impostor key failed to import');
    const collided: PinnedKey[] = [{ ...imported, kid: service.kid }];

    const result = verifyEntitlementToken(token, collided);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('accepts when a SECOND pinned slot holds the signing key (rotation)', () => {
    const outgoing = generateMintKeyPair();
    const incoming = generateMintKeyPair();
    const { token } = mintToken(incoming, payload());

    const keys = [...pin(outgoing), ...pin(incoming)];
    expect(verifyEntitlementToken(token, keys).ok).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['three segments', 'v1.deadbeef.eyJhIjoxfQ'],
    ['five segments', 'v1.deadbeef.eyJhIjoxfQ.sig.extra'],
    ['unknown version', 'v2.deadbeef.eyJhIjoxfQ.sig'],
    ['empty payload segment', 'v1.deadbeef..sig'],
  ])('reports `malformed` for %s', (_label, token) => {
    const result = verifyEntitlementToken(token, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects a padded signature segment rather than decoding it leniently', () => {
    // `Buffer.from(s, 'base64url')` silently drops characters it does not
    // recognize, so `<sig>==` and `<sig>` decode to the same bytes. Without the
    // strict re-encode check a signature could be respelled at will — cosmetic
    // here, but it is the difference between "the token is what was minted" and
    // "the token decodes to what was minted".
    const keys = generateMintKeyPair();
    const minted = mintToken(keys, payload());
    const [v, kid, payloadB64, sig] = minted.token.split('.');
    const padded = `${sig}==`;
    expect(Buffer.from(padded, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);

    const result = verifyEntitlementToken(`${v}.${kid}.${payloadB64}.${padded}`, pin(keys));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');

    // Non-vacuity: the unpadded original verifies.
    expect(verifyEntitlementToken(minted.token, pin(keys)).ok).toBe(true);
  });

  it('rejects a correctly-signed payload whose grants are not the pinned five-key shape', () => {
    const keys = generateMintKeyPair();
    const bent = { ...payload(), grants: [{ product: 'core', type: 'perpetual' }] };
    const { token } = mintToken(keys, bent);

    const result = verifyEntitlementToken(token, pin(keys));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects a correctly-signed payload with a non-array `features`', () => {
    const keys = generateMintKeyPair();
    const bent = {
      ...payload(),
      grants: [{ ...grant(), features: 'studio' }],
    };
    const { token } = mintToken(keys, bent);

    const result = verifyEntitlementToken(token, pin(keys));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('verifies before it parses — a garbage payload under a bad signature is not a parse error', () => {
    const keys = generateMintKeyPair();
    const other = generateMintKeyPair();
    const minted = mintTokenFromSerialization(other, 'not json at all');

    const result = verifyEntitlementToken(minted.token, pin(keys));
    expect(result.ok).toBe(false);
    // The kid is the other key's, so this is an unpinned-kid rejection reached
    // without JSON ever being parsed.
    if (!result.ok) expect(result.reason).toBe('unpinned_kid');
  });
});

describe('entitlements.has(product, flag)', () => {
  const verified = (body: Record<string, unknown>): EntitlementPayload => {
    const keys = generateMintKeyPair();
    const result = verifyEntitlementToken(mintToken(keys, body).token, pin(keys));
    if (!result.ok) throw new Error(`fixture token did not verify: ${result.reason}`);
    return result.payload;
  };

  const NOW = AT('2026-09-05T00:00:00.000Z');

  it('is false for every flag on an un-activated install', () => {
    const none = noEntitlements();
    expect(none.has('core', 'anything')).toBe(false);
    expect(none.grants).toEqual([]);
    expect(entitlementsFrom(null, { now: () => NOW }).has('core', 'anything')).toBe(false);
  });

  it('unlocks a flag a live grant names, and nothing else', () => {
    const p = verified(payload({ grants: [grant({ features: ['studio', 'teams'] })] }));
    const ent = entitlementsFrom(p, { now: () => NOW });

    expect(ent.has('core', 'studio')).toBe(true);
    expect(ent.has('core', 'teams')).toBe(true);
    expect(ent.has('core', 'unlisted')).toBe(false);
    expect(ent.has('other-product', 'studio')).toBe(false);
  });

  it('honours a subscription grant`s expiry against the INJECTED clock', () => {
    const p = verified(
      payload({
        grants: [
          grant({ type: 'subscription', features: ['studio'], expires: '2026-09-10T00:00:00.000Z' }),
        ],
      }),
    );

    expect(entitlementsFrom(p, { now: () => AT('2026-09-09T23:59:59.000Z') }).has('core', 'studio')).toBe(true);
    expect(entitlementsFrom(p, { now: () => AT('2026-09-10T00:00:00.000Z') }).has('core', 'studio')).toBe(true);
    expect(entitlementsFrom(p, { now: () => AT('2026-09-10T00:00:00.001Z') }).has('core', 'studio')).toBe(false);
  });

  it('keeps a perpetual grant`s flags after its `expires` would have passed', () => {
    const p = verified(
      payload({ grants: [grant({ features: ['studio'], expires: '2020-01-01T00:00:00.000Z' })] }),
    );
    expect(entitlementsFrom(p, { now: () => NOW }).has('core', 'studio')).toBe(true);
  });

  it('withholds a ceilinged flag from a version PAST the ceiling', () => {
    const p = verified(
      payload({
        grants: [grant({ features: ['studio'], version_ceiling: '0.4.0' })],
      }),
    );
    const at = (version: string | null): boolean =>
      entitlementsFrom(p, { now: () => NOW, version }).has('core', 'studio');

    // The ceiling is INCLUSIVE: it names the highest version the grant applies
    // to, so the boundary release itself is covered and the next one is not.
    expect(at('0.3.0')).toBe(true);
    expect(at('0.4.0-rc.1')).toBe(true);
    expect(at('0.4.0')).toBe(true);
    expect(at('0.4.1')).toBe(false);
    expect(at('1.0.0')).toBe(false);
    // A version we cannot read is not a version inside the ceiling.
    expect(at(null)).toBe(false);
    expect(at('not-a-version')).toBe(false);
  });

  it('leaves an unceilinged flag alone when the running version is unknown', () => {
    const p = verified(payload({ grants: [grant({ features: ['studio'] })] }));
    expect(entitlementsFrom(p, { now: () => NOW }).has('core', 'studio')).toBe(true);
  });
});

describe('isPerpetual', () => {
  it('reads the declared `type`, not a null `expires`', () => {
    expect(isPerpetual({ product: 'core', type: 'perpetual', features: null, expires: null, version_ceiling: null })).toBe(true);
    // A subscription grant projected without an expiry is NOT perpetual.
    expect(isPerpetual({ product: 'core', type: 'subscription', features: null, expires: null, version_ceiling: null })).toBe(false);
  });
});
