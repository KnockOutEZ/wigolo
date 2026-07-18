import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../logger.js';

const logger = createLogger('fetch');

/**
 * Prefix for temp Chrome-profile copies. Doubles as the deletion guard in
 * `removeTempProfile` so cleanup can never touch a user-configured directory.
 */
export const TEMP_PROFILE_PREFIX = 'wigolo-chrome-';

/**
 * Copy the user's Chrome profile into a fresh temp directory so the browser
 * tier can open it without touching (or locking) the live profile. The copy is
 * SINGLE-USE and caller-owned: whoever triggers the copy MUST remove it with
 * `removeTempProfile` once the fetch settles (success, failure, or abort) —
 * a surviving copy is a full-profile privacy leak in tmp.
 */
export function copyProfileToTemp(profilePath: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), TEMP_PROFILE_PREFIX));
  cpSync(profilePath, tempDir, { recursive: true });
  logger.debug('copied Chrome profile to temp directory', { from: profilePath, to: tempDir });
  return tempDir;
}

/**
 * Remove a temp Chrome-profile copy created by `copyProfileToTemp`. Guarded to
 * wigolo-owned temp copies only (the `wigolo-chrome-` prefix) and best-effort:
 * a cleanup failure is logged, never thrown, so it cannot mask the fetch's own
 * outcome. No-op when no copy was made (`userDataDir` undefined).
 */
export function removeTempProfile(userDataDir: string | undefined): void {
  if (!userDataDir) return;
  if (!basename(userDataDir).startsWith(TEMP_PROFILE_PREFIX)) {
    logger.warn('refusing to remove a directory that is not a wigolo temp profile copy', { userDataDir });
    return;
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
    logger.debug('removed temp Chrome profile copy', { userDataDir });
  } catch (err) {
    logger.warn('failed to remove temp Chrome profile copy', {
      userDataDir,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
