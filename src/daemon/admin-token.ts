import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The daemon admin token gates privileged control routes (breaker reset). It is
 * NOT a session credential — loopback source IP is deliberately NOT the control
 * (cloudflared remote-serve delivers every request from 127.0.0.1). A random
 * bearer token written owner-only to disk is the boundary: a caller on the same
 * machine that can read `<dataDir>/daemon-admin.token` (doctor --fix) is trusted;
 * a remote request proxied in cannot read it.
 */
const TOKEN_FILE = 'daemon-admin.token';
const TOKEN_FILE_MODE = 0o600;
const TOKEN_BYTES = 24; // 48 hex chars

export function adminTokenPath(dataDir: string): string {
  return join(dataDir, TOKEN_FILE);
}

/**
 * Generate a fresh random admin token and write it owner-only to disk. Called
 * once at daemon start — a new token per process means a token leaked to disk
 * from a prior run is invalid after a restart.
 */
export function ensureAdminToken(dataDir: string): string {
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  writeFileSync(adminTokenPath(dataDir), `${token}\n`, { encoding: 'utf-8', mode: TOKEN_FILE_MODE });
  return token;
}

/**
 * Read the on-disk admin token. `doctor --fix` uses this to authenticate its
 * POST to a running daemon's reset route. Returns null when the file is absent,
 * unreadable, or blank (a blank token must never authenticate).
 */
export function readAdminToken(dataDir: string): string | null {
  const path = adminTokenPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Constant-time token comparison. Rejects null/empty on either side (a blank or
 * absent expected token must never match) before the length-safe compare.
 */
export function tokenMatches(expected: string | null, provided: string | null): boolean {
  if (!expected || !provided) return false;
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(provided, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
