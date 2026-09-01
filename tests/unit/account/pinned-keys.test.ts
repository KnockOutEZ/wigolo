/**
 * The trust root: what ships, what the env override does, and what it says.
 *
 * Two properties are worth more than the rest of this file. First, the 0.3.0
 * sentinel must be inert — it is a placeholder for a key that does not exist
 * yet, and a placeholder that could verify anything would be a backdoor.
 * Second, the override must REPLACE rather than join the build-time pins:
 * joining would leave the shipped key live beside a dev key, so "the local
 * service's token verified" could no longer tell you which root answered.
 *
 * `env` is passed as a parameter throughout rather than mutated on
 * `process.env`, so these arms cannot leak into a sibling test file.
 */

import { describe, it, expect } from 'vitest';
import { verify } from 'node:crypto';
import {
  resolvePinnedKeys,
  importAccountsPublicKey,
  accountsKeyId,
  customVerificationKeyNotice,
  SENTINEL_ACCOUNTS_PUBKEY,
  PINNED_ACCOUNTS_PUBKEY_SLOTS,
  ACCOUNTS_PUBKEY_ENV,
  CUSTOM_VERIFICATION_KEY_NOTICE,
} from '../../../src/account/pinned-keys.js';
import { generateMintKeyPair, mintToken, payload } from './mint-entitlement.js';

describe('the shipped pins', () => {
  it('holds at most two slots, with slot 2 empty at 0.3.0', () => {
    expect(PINNED_ACCOUNTS_PUBKEY_SLOTS.length).toBeLessThanOrEqual(2);
    expect(PINNED_ACCOUNTS_PUBKEY_SLOTS[0]).toBe(SENTINEL_ACCOUNTS_PUBKEY);
    expect(PINNED_ACCOUNTS_PUBKEY_SLOTS[1]).toBe('');
  });

  it('ships a sentinel that imports but can never verify a signature', () => {
    const sentinel = importAccountsPublicKey(SENTINEL_ACCOUNTS_PUBKEY);
    expect(sentinel).not.toBeNull();
    if (!sentinel) return;

    // A real, freshly minted token — the sentinel must still say no.
    const keys = generateMintKeyPair();
    const minted = mintToken(keys, payload());
    const [v, kid, payloadB64, sig] = minted.token.split('.');
    const signed = Buffer.from(`${v}.${kid}.${payloadB64}`, 'ascii');

    expect(verify(null, signed, sentinel.key, Buffer.from(sig, 'base64url'))).toBe(false);
  });

  it('resolves to exactly the importable build slots when no override is set', () => {
    const set = resolvePinnedKeys({});
    expect(set.overrideActive).toBe(false);
    expect(set.notice).toBeNull();
    // The empty slot 2 contributes nothing; the sentinel does import.
    expect(set.keys.map((k) => k.publicKey)).toEqual([SENTINEL_ACCOUNTS_PUBKEY]);
  });
});

describe('accountsKeyId', () => {
  it('derives the kid the way PX1 §5 does — first 8 hex of sha256(raw key)', () => {
    const keys = generateMintKeyPair();
    expect(accountsKeyId(keys.publicKeyB64Url)).toBe(keys.kid);
    expect(accountsKeyId(keys.publicKeyB64Url)).toHaveLength(8);
  });

  it('is derived, never carried alongside the key', () => {
    const keys = generateMintKeyPair();
    const imported = importAccountsPublicKey(keys.publicKeyB64Url);
    expect(imported?.kid).toBe(accountsKeyId(keys.publicKeyB64Url));
  });
});

describe('importAccountsPublicKey', () => {
  it('accepts a 32-byte b64url raw key', () => {
    const keys = generateMintKeyPair();
    const imported = importAccountsPublicKey(keys.publicKeyB64Url);
    expect(imported?.publicKey).toBe(keys.publicKeyB64Url);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['too short', Buffer.alloc(16).toString('base64url')],
    ['too long', Buffer.alloc(48).toString('base64url')],
    ['not base64url at all', '!!!!'],
  ])('returns null rather than throwing for a %s key', (_label, value) => {
    expect(importAccountsPublicKey(value)).toBeNull();
  });
});

describe('WIGOLO_ACCOUNTS_PUBKEY override', () => {
  it('trusts the supplied key and reports the visible notice', () => {
    const keys = generateMintKeyPair();
    const env = { [ACCOUNTS_PUBKEY_ENV]: keys.publicKeyB64Url };

    const set = resolvePinnedKeys(env);
    expect(set.overrideActive).toBe(true);
    expect(set.notice).toBe(CUSTOM_VERIFICATION_KEY_NOTICE);
    expect(set.keys.map((k) => k.kid)).toEqual([keys.kid]);
    expect(customVerificationKeyNotice(env)).toBe(CUSTOM_VERIFICATION_KEY_NOTICE);
  });

  it('REPLACES the build-time pins rather than joining them', () => {
    const keys = generateMintKeyPair();
    const set = resolvePinnedKeys({ [ACCOUNTS_PUBKEY_ENV]: keys.publicKeyB64Url });

    expect(set.keys).toHaveLength(1);
    expect(set.keys.map((k) => k.publicKey)).not.toContain(SENTINEL_ACCOUNTS_PUBKEY);
    // Non-vacuity: without the override the sentinel IS in the set.
    expect(resolvePinnedKeys({}).keys.map((k) => k.publicKey)).toContain(SENTINEL_ACCOUNTS_PUBKEY);
  });

  it('says nothing when the override is absent or blank', () => {
    expect(customVerificationKeyNotice({})).toBeNull();
    expect(customVerificationKeyNotice({ [ACCOUNTS_PUBKEY_ENV]: '' })).toBeNull();
    expect(customVerificationKeyNotice({ [ACCOUNTS_PUBKEY_ENV]: '   ' })).toBeNull();
  });

  it('still announces itself when the supplied key is unusable', () => {
    // An override that failed to import has still MOVED the trust root — the
    // build pins are gone and nothing replaced them. Staying quiet here would
    // let a support conversation happen against a silently keyless install.
    const env = { [ACCOUNTS_PUBKEY_ENV]: 'not-a-key' };
    const set = resolvePinnedKeys(env);

    expect(set.overrideActive).toBe(true);
    expect(set.keys).toEqual([]);
    expect(customVerificationKeyNotice(env)).toBe(CUSTOM_VERIFICATION_KEY_NOTICE);
  });

  it('tolerates surrounding whitespace in the env value', () => {
    const keys = generateMintKeyPair();
    const set = resolvePinnedKeys({ [ACCOUNTS_PUBKEY_ENV]: `  ${keys.publicKeyB64Url}\n` });
    expect(set.keys.map((k) => k.kid)).toEqual([keys.kid]);
  });

  it('uses capability language in the notice — no curve, no library, no file path', () => {
    expect(CUSTOM_VERIFICATION_KEY_NOTICE).toBe('custom sign-in verification key in use');
    expect(CUSTOM_VERIFICATION_KEY_NOTICE).not.toMatch(/ed25519|jwk|openssl|pem/i);
  });
});
