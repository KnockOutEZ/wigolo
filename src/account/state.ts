/**
 * `<dataDir>/account/state.json` — the non-secret half of account custody.
 *
 * WHAT LIVES HERE AND WHY IT IS NOT A SECRET. The entitlement token is signed
 * and self-contained: possession of it grants nothing a verifier will accept
 * beyond what it already says, and it expires in 7 days. The refresh token —
 * the one long-lived credential — deliberately does NOT live here; it is in
 * the keychain (or an encrypted file) via `token-store.ts`. The file is still
 * 0600 because it carries the account's email.
 *
 * WHY EVERY READ HITS THE DISK. There is no process-lifetime cache, and that
 * is the design rather than an omission. Refresh rotates the credential, and
 * several wigolo processes (a daemon, an MCP server, a one-shot CLI) can be
 * live at once. A cached reader would keep answering with a pre-rotation
 * `refresh_expires_at` / `needs_relogin` after another process moved them, and
 * the refresh policy's 30-second race branch is built precisely on being able
 * to SEE another process's rotation. The file is a few hundred bytes; the read
 * is not worth a staleness bug.
 *
 * Writes are merge-patch + atomic temp-and-rename (the `persisted-config.ts`
 * pattern), so a concurrent reader sees either the whole old file or the whole
 * new one, never a truncated one.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('account');

const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

export interface AccountState {
  /** Account id from `POST /auth/verify`. Null until the install is activated. */
  account_id: string | null;
  email: string | null;
  /** Compact `v1.<kid>.<payload>.<sig>` entitlement token; verified offline (§5). */
  entitlement_token: string | null;
  /** Last SUCCESSFUL `GET /entitlements/token`. Grace is measured from this. */
  last_refresh_at: string | null;
  /** Last refresh ATTEMPT, successful or not. Throttles to 1/24h (A-212-13). */
  last_refresh_attempt_at: string | null;
  /** From every auth response, so `whoami` can say when re-login is due. */
  refresh_expires_at: string | null;
  /** The refresh credential is dead. Cached entitlements keep governing the gate. */
  needs_relogin: boolean;
  /** Version of the telemetry disclosure the user was shown at registration. */
  disclosure_version: string | null;
  marketing_consent: boolean | null;
}

export const EMPTY_ACCOUNT_STATE: Readonly<AccountState> = Object.freeze({
  account_id: null,
  email: null,
  entitlement_token: null,
  last_refresh_at: null,
  last_refresh_attempt_at: null,
  refresh_expires_at: null,
  needs_relogin: false,
  disclosure_version: null,
  marketing_consent: null,
});

export function accountStatePath(dataDir: string): string {
  return join(dataDir, 'account', 'state.json');
}

/**
 * Coerce a parsed JSON object into `AccountState`.
 *
 * Field-by-field rather than a cast: the file is user-writable and a future
 * version may add keys, so an unknown key is dropped and a wrong-typed key
 * falls back to its empty value instead of poisoning a caller with `undefined`
 * where the type promises `string | null`.
 */
function coerce(raw: unknown): AccountState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...EMPTY_ACCOUNT_STATE };
  }
  const o = raw as Record<string, unknown>;
  const s = (k: keyof AccountState): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    account_id: s('account_id'),
    email: s('email'),
    entitlement_token: s('entitlement_token'),
    last_refresh_at: s('last_refresh_at'),
    last_refresh_attempt_at: s('last_refresh_attempt_at'),
    refresh_expires_at: s('refresh_expires_at'),
    needs_relogin: o['needs_relogin'] === true,
    disclosure_version: s('disclosure_version'),
    marketing_consent: typeof o['marketing_consent'] === 'boolean' ? (o['marketing_consent'] as boolean) : null,
  };
}

/**
 * Reader/writer for one data dir's account state.
 *
 * Instances hold no state of their own, so two instances in one process behave
 * exactly like two processes — which is what makes the cross-process rotation
 * test a real test rather than a tautology.
 */
export class AccountStateStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = accountStatePath(dataDir);
  }

  /** Read the current state. A missing, unparseable or truncated file reads as
   *  empty — an install with a corrupt state file is un-activated, never crashed. */
  read(): AccountState {
    if (!existsSync(this.path)) return { ...EMPTY_ACCOUNT_STATE };
    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (err) {
      log.warn('account state unreadable', { error: err instanceof Error ? err.message : String(err) });
      return { ...EMPTY_ACCOUNT_STATE };
    }
    try {
      return coerce(JSON.parse(raw));
    } catch {
      log.warn('account state unparseable — treating install as un-activated');
      return { ...EMPTY_ACCOUNT_STATE };
    }
  }

  /** Merge-patch and write atomically. Returns the state as persisted. */
  write(patch: Partial<AccountState>): AccountState {
    const next: AccountState = { ...this.read(), ...patch };
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });

    const tmp = join(dir, `.state-${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: STATE_FILE_MODE });
      renameSync(tmp, this.path);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw err;
    }
    return next;
  }

  /** Reset to the un-activated state. Used by `logout` and by account deletion.
   *  Overwrites rather than unlinks so the 0600 file, and its inode, stay ours. */
  clear(): AccountState {
    return this.write({ ...EMPTY_ACCOUNT_STATE });
  }
}
