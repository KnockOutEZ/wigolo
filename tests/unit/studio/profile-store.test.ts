import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The wished-for encrypted profile store — Slice 5c. Until src/studio/profile-store.ts exists this
// import fails to resolve, so every case reds on "Cannot find module …/profile-store.js": the
// RIGHT-REASON RED (the store primitive is absent). It imports key-crypto + keychain, NOT
// daemon/studio-dispatch, so it is not a safety-importing test → check-gate stays 23.
import { ProfileStore, type ProfileKeychain } from '../../../src/studio/profile-store.js';

/**
 * Slice 5c — the encrypted profile store: a per-profile random 32-byte KEK stored KEYCHAIN-ONLY,
 * with the storageState blob encrypted to a 0o600 disk file under that KEK (L5 envelope). Keyed by
 * an OPAQUE profileId (named vs per-session is 5d's call). The keychain is injected so the
 * keychain-unavailable test is clean (no global probe-mocking).
 */

/** An in-memory keychain fake — clean injection. `store` exposes the KEK so a test can assert it lives only in the keychain. */
function memKeychain(available = true): ProfileKeychain & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    available: () => available,
    getKek: (profileId: string) => store.get(profileId) ?? null,
    setKek: (profileId: string, kek: string) => { store.set(profileId, kek); },
  };
}

const SECRET = 's3cr3t-session-token';
const STORAGE_STATE = JSON.stringify({ cookies: [{ name: 'sid', value: SECRET, domain: 'acme.example' }], origins: [] });

describe('studio/profile-store — encrypted profile store (keychain KEK + disk ciphertext)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wigolo-profile-store-')); });
  afterEach(() => {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const profilesDir = () => join(dir, 'studio', 'profiles');
  const blobCount = (): number =>
    existsSync(profilesDir()) ? readdirSync(profilesDir()).filter((f) => f.endsWith('.enc')).length : 0;
  const blobPath = (profileId: string) => join(profilesDir(), `${profileId}.enc`);

  it('PRIMARY (fail-closed): keychain UNAVAILABLE → set() THROWS and writes NO blob (no plaintext, no scrypt-encrypted file)', async () => {
    const store = new ProfileStore({ dataDir: dir, keychain: memKeychain(false) });
    await expect(store.set('prof-1', STORAGE_STATE)).rejects.toThrow();
    // Mutation: give the KEK helper a file/scrypt fallthrough (mimic key-store.ts::storeKey) → the
    // keychain-unavailable set() would mint a KEK anyway, succeed, and write a blob → this REDs.
    // Proves the no-fallthrough (hard-fail) is load-bearing: the KEK never lands on disk.
    expect(blobCount(), 'no blob is written when the keychain is unavailable').toBe(0);
  });

  it('round-trip: set then get returns the original storageState blob; envelope is keychain-KEK + 0o600 ciphertext', async () => {
    const kc = memKeychain(true);
    const store = new ProfileStore({ dataDir: dir, keychain: kc });
    await store.set('prof-1', STORAGE_STATE);

    // get round-trips the exact blob.
    const r = await store.get('prof-1');
    expect(r.ok).toBe(true);
    expect((r as { ok: true; storageState: string }).storageState).toBe(STORAGE_STATE);

    // Envelope pins: the KEK lives in the keychain only; the disk blob is real ciphertext (0o600),
    // carrying neither the plaintext secret nor the KEK.
    expect(blobCount()).toBe(1);
    expect(kc.store.has('prof-1'), 'the per-profile KEK is in the keychain').toBe(true);
    const onDisk = readFileSync(blobPath('prof-1'), 'utf8');
    expect(onDisk, 'the plaintext secret is never on disk').not.toContain(SECRET);
    expect(onDisk, 'the KEK is never on disk').not.toContain(kc.store.get('prof-1'));
    expect(statSync(blobPath('prof-1')).mode & 0o777, 'blob is 0o600 at rest').toBe(0o600);
  });

  it('KEK-missing graceful: get with no KEK → profile_absent, no exception (agent re-login), no scrypt-decrypt attempt', async () => {
    const store = new ProfileStore({ dataDir: dir, keychain: memKeychain(true) }); // available, but no KEK for this profile
    const r = await store.get('never-set');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; reason: string }).reason).toBe('profile_absent');
  });

  it('per-encryption salt: encrypting the same blob twice yields DIFFERENT ciphertext (the wire-format salt)', async () => {
    const store = new ProfileStore({ dataDir: dir, keychain: memKeychain(true) });
    await store.set('prof-1', STORAGE_STATE);
    const first = readFileSync(blobPath('prof-1'), 'utf8');
    await store.set('prof-1', STORAGE_STATE); // same KEK (fetched), fresh salt
    const second = readFileSync(blobPath('prof-1'), 'utf8');
    expect(second).not.toBe(first);
    // …and it still decrypts back to the original.
    expect(((await store.get('prof-1')) as { ok: true; storageState: string }).storageState).toBe(STORAGE_STATE);
  });
});
