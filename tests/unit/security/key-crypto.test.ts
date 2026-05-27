import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { encryptSecret, decryptSecret, encryptToFile, decryptFromFile } from '../../../src/security/key-crypto.js';

describe('encryptSecret / decryptSecret (AES-256-GCM)', () => {
  it('round-trips a plain secret', async () => {
    const secret = 'sk-ant-api03-test-secret';
    const encrypted = await encryptSecret(secret, 'machine-id-test');
    const decrypted = await decryptSecret(encrypted, 'machine-id-test');
    expect(decrypted).toBe(secret);
  });

  it('produces different ciphertexts each call (random salt + IV)', async () => {
    const secret = 'same-secret';
    const enc1 = await encryptSecret(secret, 'machine-id');
    const enc2 = await encryptSecret(secret, 'machine-id');
    // They must differ due to random salt/IV
    expect(enc1).not.toBe(enc2);
  });

  it('rejects tampered ciphertext (GCM auth tag check)', async () => {
    const secret = 'real-secret';
    const encrypted = await encryptSecret(secret, 'machine-id');
    // Flip a byte in the middle of the base64 payload
    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 5] ^= 0xff;
    const tampered = buf.toString('base64');
    await expect(decryptSecret(tampered, 'machine-id')).rejects.toThrow();
  });

  it('rejects wrong machine-id (wrong KEK)', async () => {
    const secret = 'real-secret';
    const encrypted = await encryptSecret(secret, 'machine-id-correct');
    await expect(decryptSecret(encrypted, 'machine-id-wrong')).rejects.toThrow();
  });
});

describe('encryptToFile / decryptFromFile', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wigolo-crypto-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes file with 0o600 permissions', async () => {
    const filePath = join(tmpDir, 'key.enc');
    await encryptToFile('my-api-key', 'machine-id', filePath);
    const mode = statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('round-trips through file', async () => {
    const filePath = join(tmpDir, 'key.enc');
    await encryptToFile('round-trip-key', 'machine-id', filePath);
    const result = await decryptFromFile('machine-id', filePath);
    expect(result).toBe('round-trip-key');
  });

  it('creates parent directory if missing', async () => {
    const filePath = join(tmpDir, 'nested', 'dir', 'key.enc');
    await encryptToFile('nested-key', 'machine-id', filePath);
    const result = await decryptFromFile('machine-id', filePath);
    expect(result).toBe('nested-key');
  });
});

