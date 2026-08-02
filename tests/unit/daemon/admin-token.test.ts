import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureAdminToken,
  readAdminToken,
  adminTokenPath,
  tokenMatches,
} from '../../../src/daemon/admin-token.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wigolo-admin-token-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('admin token', () => {
  it('ensureAdminToken writes a random token at <dataDir>/daemon-admin.token', () => {
    const token = ensureAdminToken(dir);
    expect(token).toMatch(/^[0-9a-f]{32,}$/);
    expect(existsSync(adminTokenPath(dir))).toBe(true);
    expect(readFileSync(adminTokenPath(dir), 'utf-8').trim()).toBe(token);
  });

  it('ensureAdminToken rotates on each daemon start (fresh token per call)', () => {
    // WHY (D9): the token is written at daemon start — a restart must not keep a
    // token a previous process could have leaked to disk indefinitely.
    const a = ensureAdminToken(dir);
    const b = ensureAdminToken(dir);
    expect(a).not.toBe(b);
    expect(readAdminToken(dir)).toBe(b);
  });

  it('writes the token file mode 0600 (owner read/write only)', () => {
    ensureAdminToken(dir);
    const mode = statSync(adminTokenPath(dir)).mode & 0o777;
    // On POSIX we assert exactly 0600; Windows has no perm bits so skip there.
    if (process.platform !== 'win32') {
      expect(mode).toBe(0o600);
    }
  });

  it('readAdminToken returns null when no token file exists', () => {
    expect(readAdminToken(dir)).toBeNull();
  });

  it('readAdminToken returns the on-disk token (doctor --fix reads it this way)', () => {
    const token = ensureAdminToken(dir);
    expect(readAdminToken(dir)).toBe(token);
  });

  it('tokenMatches is constant-time-safe and rejects mismatches / empties', () => {
    const token = ensureAdminToken(dir);
    expect(tokenMatches(token, token)).toBe(true);
    expect(tokenMatches(token, `${token}x`)).toBe(false);
    expect(tokenMatches(token, '')).toBe(false);
    expect(tokenMatches('', token)).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches(null, token)).toBe(false);
    expect(tokenMatches(token, null)).toBe(false);
  });

  it('readAdminToken tolerates a truncated/blank token file (returns null)', () => {
    writeFileSync(adminTokenPath(dir), '   \n', 'utf-8');
    expect(readAdminToken(dir)).toBeNull();
  });
});
