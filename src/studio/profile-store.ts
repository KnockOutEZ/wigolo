import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getConfig } from '../config.js';
import { encryptToFile, decryptFromFile } from '../security/key-crypto.js';
import { keychainAvailable, keychainGet, keychainSet } from '../security/keychain.js';

/**
 * Slice 5c — the encrypted profile store: persists a browser `storageState` blob per profile so a
 * human logs in once and the session reuses it (5d/5e wire the persist/attach; this is the primitive).
 *
 * Envelope (L5 — asymmetric to the provider-key tier): a per-profile RANDOM 32-byte KEK lives in the
 * OS keychain ONLY (never on disk), and the storageState JSON is encrypted to a 0o600 disk file under
 * that KEK via the unchanged key-crypto wire format (per-encryption salt). Unlike key-store.ts's
 * provider keys — which fall through to a scrypt(dataDir) file when the keychain is absent (obfuscation
 * vs a casual disk read) — this store HARD-FAILS when the keychain is unavailable: NO file tier, NO
 * scrypt fallback. A credential blob is real-encrypted against a local reader or it is not stored.
 *
 * profileId is OPAQUE: whether it is a profile name (A=named) or a session id (A=per-session) is 5d's
 * call; the store does not decide.
 *
 * SECURITY: never log the storageState, the KEK, or decrypted plaintext. This module emits no logs.
 */

/** The keychain dependency the store needs, injected so the keychain-unavailable path is testable without global probe-mocking. */
export interface ProfileKeychain {
  /** True when the OS keychain is usable. The store HARD-FAILS set() when false (no fallthrough). */
  available(): boolean;
  /** Fetch the per-profile KEK, or null if none is stored. */
  getKek(profileId: string): string | null;
  /** Store the per-profile KEK (keychain-only). */
  setKek(profileId: string, kek: string): void;
}

/** The keychain service the per-profile KEK is stored under (user = the opaque profileId). */
const PROFILE_KEK_SERVICE = 'wigolo-studio-profile';

/** Default keychain binding: the per-profile KEK keyed by (service=`wigolo-studio-profile`, user=profileId). */
const defaultKeychain: ProfileKeychain = {
  available: () => keychainAvailable(),
  getKek: (profileId) => keychainGet(PROFILE_KEK_SERVICE, profileId),
  setKek: (profileId, kek) => keychainSet(PROFILE_KEK_SERVICE, profileId, kek),
};

/** Thrown by set() when the OS keychain is unavailable — the KEK cannot be stored keychain-only, so the blob is NOT written (fail-closed; no plaintext, no scrypt file). Carries no secret. */
export class ProfileKeychainUnavailableError extends Error {
  constructor() {
    super('studio_profile_keychain_unavailable');
    this.name = 'ProfileKeychainUnavailableError';
  }
}

/** The result of a get(): the decrypted storageState, or a graceful profile_absent the caller resolves by re-login. */
export type ProfileGetResult =
  | { ok: true; storageState: string }
  | { ok: false; reason: 'profile_absent' };

export interface ProfileStoreOptions {
  /** Data dir root for `studio/profiles/<profileId>.enc`. Defaults to config.dataDir. */
  dataDir?: string;
  /** Injectable keychain (tests). Defaults to the OS keychain binding. */
  keychain?: ProfileKeychain;
}

export class ProfileStore {
  private readonly dataDir: string;
  private readonly keychain: ProfileKeychain;

  constructor(opts: ProfileStoreOptions = {}) {
    this.dataDir = opts.dataDir ?? getConfig().dataDir;
    this.keychain = opts.keychain ?? defaultKeychain;
  }

  private profilePath(profileId: string): string {
    return join(this.dataDir, 'studio', 'profiles', `${profileId}.enc`);
  }

  /**
   * Generate-or-fetch the per-profile KEK from the keychain. HARD-FAILS when the keychain is
   * unavailable — NO file/scrypt fallthrough (unlike key-store.ts::storeKey), so the KEK never
   * touches disk and a credential blob is never written without keychain-grade protection.
   */
  private getOrCreateKek(profileId: string): string {
    if (!this.keychain.available()) {
      throw new ProfileKeychainUnavailableError();
    }
    const existing = this.keychain.getKek(profileId);
    if (existing) return existing;
    const kek = randomBytes(32).toString('base64');
    this.keychain.setKek(profileId, kek);
    return kek;
  }

  /**
   * Encrypt + persist the storageState blob under profileId. Throws ProfileKeychainUnavailableError
   * when the keychain is unavailable, BEFORE any disk write — no plaintext, no scrypt-only file. The
   * key-crypto wire format adds a per-encryption salt, so repeated encrypts of the same blob differ.
   */
  async set(profileId: string, storageStateJson: string): Promise<void> {
    const kek = this.getOrCreateKek(profileId); // throws (fail-closed) if the keychain is unavailable
    await encryptToFile(storageStateJson, kek, this.profilePath(profileId));
  }

  /**
   * Fetch the KEK and decrypt the blob. Four graceful-absent cases → profile_absent (the agent
   * re-logs in), nothing thrown to the host: keychain unavailable, KEK absent, blob file missing,
   * OR the blob is corrupt/tampered (decrypt/AES-GCM auth failure). NO scrypt-decrypt is attempted
   * without the real KEK.
   */
  async get(profileId: string): Promise<ProfileGetResult> {
    if (!this.keychain.available()) return { ok: false, reason: 'profile_absent' };
    const kek = this.keychain.getKek(profileId);
    if (!kek) return { ok: false, reason: 'profile_absent' };
    const path = this.profilePath(profileId);
    if (!existsSync(path)) return { ok: false, reason: 'profile_absent' };
    try {
      const storageState = await decryptFromFile(kek, path);
      return { ok: true, storageState };
    } catch {
      // 4th absent-case: a corrupt/tampered blob (AES-GCM auth failure) or an unreadable file → treat
      // as profile_absent so the session starts CLEAN (the human re-logs in) instead of crashing the
      // host. GCM has already REJECTED the tampered ciphertext — this is the graceful-absent (liveness)
      // half, NOT a security relaxation. No secret/path is logged.
      return { ok: false, reason: 'profile_absent' };
    }
  }
}
