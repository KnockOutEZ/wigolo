/**
 * AES-256-GCM symmetric encryption for the encrypted-file fallback tier.
 *
 * KEK strategy: derive a 256-bit key-encryption-key via scrypt from a
 * machine-local identifier (arbitrary string passed in by the caller —
 * typically a stable machine-id or data-dir path) plus a random 32-byte
 * salt stored alongside the ciphertext.
 *
 * Threat model (honest): this protects against casual/offline disk reads by
 * unprivileged users. It does NOT protect against a root attacker or anyone
 * who can read the salt file and reconstruct the machine-id. The keychain
 * tier is preferred precisely because it delegates secret storage to the OS
 * keyring which has stronger access controls.
 *
 * Wire format (binary, then base64-encoded):
 *   [ 4 bytes version ][ 32 bytes salt ][ 12 bytes IV ][ auth-tag 16 bytes ][ ciphertext ... ]
 *
 * version = 0x00000001 (big-endian uint32)
 */

import { scrypt as _scrypt, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMAT_VERSION = 1;
const SALT_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32; // 256-bit

/**
 * Derive a 256-bit AES key from a machine-id string and a random salt using
 * scrypt (N=16384, r=8, p=1). These parameters are deliberately conservative
 * for a local-machine KEK where the salt is not guessable and the primary
 * attacker is an offline disk read, not a brute-force cloud attacker.
 */
function deriveKey(machineId: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    _scrypt(machineId, salt, KEY_LEN, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Encrypt a plaintext secret with AES-256-GCM.
 * Returns a base64-encoded blob (version + salt + IV + tag + ciphertext).
 */
export async function encryptSecret(plaintext: string, machineId: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveKey(machineId, salt);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // version(4) + salt(32) + iv(12) + tag(16) + ciphertext(n)
  const header = Buffer.alloc(4);
  header.writeUInt32BE(FORMAT_VERSION, 0);
  const payload = Buffer.concat([header, salt, iv, tag, encrypted]);
  return payload.toString('base64');
}

/**
 * Decrypt a base64-encoded blob produced by encryptSecret.
 * Throws on any auth/format failure — callers must not silently ignore.
 */
export async function decryptSecret(blob: string, machineId: string): Promise<string> {
  const payload = Buffer.from(blob, 'base64');

  // Minimum viable payload: 4 + 32 + 12 + 16 = 64 bytes plus at least 1 byte ciphertext
  if (payload.length < 65) {
    throw new Error('key-crypto: payload too short to be valid');
  }

  const version = payload.readUInt32BE(0);
  if (version !== FORMAT_VERSION) {
    throw new Error(`key-crypto: unsupported format version ${version}`);
  }

  let offset = 4;
  const salt = payload.subarray(offset, offset + SALT_LEN); offset += SALT_LEN;
  const iv = payload.subarray(offset, offset + IV_LEN); offset += IV_LEN;
  const tag = payload.subarray(offset, offset + TAG_LEN); offset += TAG_LEN;
  const ciphertext = payload.subarray(offset);

  const key = await deriveKey(machineId, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Encrypt a secret and write it atomically to filePath with 0o600 permissions.
 * Creates parent directories if they don't exist.
 */
export async function encryptToFile(
  plaintext: string,
  machineId: string,
  filePath: string,
): Promise<void> {
  const blob = await encryptSecret(plaintext, machineId);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, blob, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Read and decrypt a file written by encryptToFile.
 * Throws if the file is missing, corrupt, or auth-tag check fails.
 */
export async function decryptFromFile(machineId: string, filePath: string): Promise<string> {
  const blob = readFileSync(filePath, 'utf8');
  return decryptSecret(blob.trim(), machineId);
}
